import { createAppConfig } from '@jejunetwork/config'
import type {
  X402PaymentHeader,
  X402PaymentRequirement,
} from '@jejunetwork/shared'
import { expectJson, ZERO_ADDRESS } from '@jejunetwork/types'
import type { Address } from 'viem'
import { hashMessage, recoverAddress } from 'viem'
import { z } from 'zod'
import { x402State } from '../state.js'

const MiB = 1024 * 1024

const X402PaymentProofSchema = z.object({
  payTo: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string(),
  nonce: z.string(),
  timestamp: z.number(),
  network: z.string(),
  signature: z.string(),
})

interface StoragePaymentsConfig {
  paymentRecipient?: Address
  x402Enabled?: boolean
  [key: string]: Address | boolean | undefined
}

const { config: storagePaymentsConfig, configure: configureStoragePayments } =
  createAppConfig<StoragePaymentsConfig>({
    paymentRecipient: ZERO_ADDRESS,
    x402Enabled: true,
  })

export function configureStoragePaymentsConfig(
  config: Partial<StoragePaymentsConfig>,
): void {
  configureStoragePayments(config)
}

const PAYMENT_RECIPIENT = (storagePaymentsConfig.paymentRecipient ||
  ZERO_ADDRESS) as Address
const X402_ENABLED = storagePaymentsConfig.x402Enabled ?? true

export type StoragePaymentOperation =
  | 'upload'
  | 'download'
  | 'permanent-upload'

export const STORAGE_PRICING = {
  uploadPerMiB: 10_000_000_000n,
  downloadPerMiB: 1_000_000_000n,
  permanentUploadPerMiB: 50_000_000_000n,
} as const

function toUnits(sizeBytes: number): bigint {
  return BigInt(Math.max(1, Math.ceil(sizeBytes / MiB)))
}

export function getStoragePrice(
  operation: StoragePaymentOperation,
  sizeBytes: number,
): bigint {
  const units = toUnits(sizeBytes)
  switch (operation) {
    case 'upload':
      return units * STORAGE_PRICING.uploadPerMiB
    case 'permanent-upload':
      return units * STORAGE_PRICING.permanentUploadPerMiB
    case 'download':
      return units * STORAGE_PRICING.downloadPerMiB
  }
}

export function isStorageX402Enabled(): boolean {
  return X402_ENABLED && PAYMENT_RECIPIENT !== ZERO_ADDRESS
}

export function parseX402Header(header: string): X402PaymentHeader | null {
  const [scheme, network, payload, asset, amount] = header.split(':')
  return amount ? { scheme, network, payload, asset, amount } : null
}

function buildProofMessage(
  proof: z.infer<typeof X402PaymentProofSchema>,
  resource: string,
): string {
  return `x402:storage:${proof.network}:${proof.payTo}:${proof.amount}:${resource}:${proof.nonce}:${proof.timestamp}`
}

async function verifyX402Payment(
  payment: X402PaymentHeader,
  expectedAmount: bigint,
  resource: string,
  userAddress?: Address | string,
): Promise<{ valid: boolean; error?: string; payer?: Address }> {
  if (BigInt(payment.amount) < expectedAmount) {
    return { valid: false, error: 'Insufficient payment' }
  }

  const proof = expectJson(
    payment.payload,
    X402PaymentProofSchema,
    'storage x402 payment proof',
  )
  const nonceKey = `${userAddress?.toLowerCase() ?? 'anonymous'}:${proof.nonce}:${resource}`

  if (proof.payTo.toLowerCase() !== PAYMENT_RECIPIENT.toLowerCase()) {
    return { valid: false, error: 'Wrong recipient' }
  }
  if (await x402State.isNonceUsed(nonceKey)) {
    return { valid: false, error: 'Nonce reused' }
  }
  if (Date.now() / 1000 - proof.timestamp > 300) {
    return { valid: false, error: 'Expired' }
  }

  const recovered = await recoverAddress({
    hash: hashMessage(buildProofMessage(proof, resource)),
    signature: proof.signature as `0x${string}`,
  })

  if (userAddress && recovered.toLowerCase() !== userAddress.toLowerCase()) {
    return { valid: false, error: 'Invalid signature' }
  }

  await x402State.markNonceUsed(nonceKey)
  return { valid: true, payer: recovered }
}

export function generateStoragePaymentRequirement(
  operation: StoragePaymentOperation,
  sizeBytes: number,
  resource: string,
): X402PaymentRequirement {
  const amount = getStoragePrice(operation, sizeBytes).toString()
  return {
    x402Version: 1,
    error: 'Payment required for storage access',
    accepts: [
      {
        scheme: 'exact',
        network: 'jeju',
        maxAmountRequired: amount,
        asset: ZERO_ADDRESS,
        payTo: PAYMENT_RECIPIENT,
        resource,
        description: `Storage ${operation} (${sizeBytes} bytes)`,
      },
      {
        scheme: 'credit',
        network: 'jeju',
        maxAmountRequired: amount,
        asset: ZERO_ADDRESS,
        payTo: PAYMENT_RECIPIENT,
        resource,
        description: 'Prepaid storage credits',
      },
    ],
  }
}

export async function processStoragePayment(params: {
  paymentHeader?: string
  userAddress?: Address | string
  operation: StoragePaymentOperation
  sizeBytes: number
  resource: string
}): Promise<{
  allowed: boolean
  requirement?: X402PaymentRequirement
  error?: string
  payer?: Address | string
  amountWei: bigint
  scheme: 'free' | 'credit' | 'x402'
}> {
  const amountWei = getStoragePrice(params.operation, params.sizeBytes)
  if (!isStorageX402Enabled()) {
    return {
      allowed: true,
      payer: params.userAddress,
      amountWei: 0n,
      scheme: 'free',
    }
  }

  const requirement = generateStoragePaymentRequirement(
    params.operation,
    params.sizeBytes,
    params.resource,
  )

  if (params.userAddress) {
    const credits = await x402State.getCredits(params.userAddress)
    if (credits >= amountWei) {
      await x402State.deductCredits(params.userAddress, amountWei)
      return {
        allowed: true,
        payer: params.userAddress,
        amountWei,
        scheme: 'credit',
      }
    }
  }

  if (!params.paymentHeader) {
    return { allowed: false, requirement, amountWei, scheme: 'free' }
  }

  const payment = parseX402Header(params.paymentHeader)
  if (!payment) {
    return {
      allowed: false,
      requirement,
      error: 'Invalid header',
      amountWei,
      scheme: 'free',
    }
  }

  const result = await verifyX402Payment(
    payment,
    amountWei,
    params.resource,
    params.userAddress,
  )
  if (!result.valid) {
    return {
      allowed: false,
      requirement,
      error: result.error,
      amountWei,
      scheme: 'free',
    }
  }

  return {
    allowed: true,
    payer: result.payer ?? params.userAddress,
    amountWei,
    scheme: 'x402',
  }
}

