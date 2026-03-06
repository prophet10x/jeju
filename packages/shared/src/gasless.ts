import {
  type Address,
  type PublicClient,
  parseAbi,
  parseEther,
  zeroAddress,
} from 'viem'
import { z } from 'zod'

export const SIMPLE_ACCOUNT_FACTORY_ABI = parseAbi([
  'function getAddress(address owner, uint256 salt) view returns (address)',
])

export type GaslessEntryPointVersion = '0.7' | '0.8' | '0.9'

export function getGaslessEntryPointVersion(
  address: Address | string | undefined | null,
): GaslessEntryPointVersion {
  if (!isConfiguredAddress(address)) return '0.7'

  const normalized = address.toLowerCase()
  if (normalized.startsWith('0x433709')) return '0.9'
  if (normalized.startsWith('0x433708')) return '0.8'

  return '0.7'
}

export const GASLESS_BOOTSTRAP_PURPOSES = ['registry', 'node'] as const
export type GaslessBootstrapPurpose =
  (typeof GASLESS_BOOTSTRAP_PURPOSES)[number]

export interface GaslessReadiness {
  isReady: boolean
  readyViaAllowance: boolean
  readyViaCredit: boolean
  needsPaymasterAllowance: boolean
  preferredPath: 'allowance' | 'credit' | 'not-ready'
  requiredJejuBalance: bigint
  requiredPaymentAmount: bigint
  recommendedJejuBalance: bigint
  jejuBalanceShortfall: bigint
  creditShortfall: bigint
  allowanceShortfall: bigint
}

export interface GaslessReadinessInput {
  jejuBalance?: bigint
  jejuCredit?: bigint
  paymasterAllowance?: bigint
  requiredJejuBalance?: bigint
  requiredPaymentAmount?: bigint
  targetPaymasterAllowance?: bigint
}

export interface GaslessBootstrapRequest {
  ownerAddress: Address
  smartAccountAddress: Address
  purpose: GaslessBootstrapPurpose
  requiredStakeAmount: string
}

export interface GaslessBootstrapResponse {
  success: boolean
  smartAccountAddress: Address
  jejuFundedAmount: string
  creditAddedAmount: string
  fundingTxHash?: `0x${string}`
  creditTxHash?: `0x${string}`
  alreadyReady: boolean
}

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/)

export const GaslessBootstrapRequestSchema = z.object({
  ownerAddress: AddressSchema,
  smartAccountAddress: AddressSchema,
  purpose: z.enum(GASLESS_BOOTSTRAP_PURPOSES),
  requiredStakeAmount: z.string().regex(/^\d+$/),
})

export const DEFAULT_GASLESS_PAYMENT_AMOUNT = parseEther('0.05')
export const DEFAULT_GASLESS_BOOTSTRAP_EXTRA_JEJU = parseEther('1')
export const DEFAULT_GASLESS_BOOTSTRAP_CREDIT_JEJU = parseEther('0')
export const DEFAULT_GASLESS_BOOTSTRAP_MAX_STAKE_JEJU = parseEther('100000')

export function isConfiguredAddress(
  value: Address | string | undefined | null,
): value is Address {
  return !!value && value.toLowerCase() !== zeroAddress
}

export function getConfiguredAddress(
  value: Address | string | undefined | null,
): Address | undefined {
  return isConfiguredAddress(value) ? (value as Address) : undefined
}

export async function predictSimpleAccountAddress(params: {
  publicClient: PublicClient
  factoryAddress: Address
  ownerAddress: Address
  salt?: bigint
}): Promise<Address> {
  const predicted = await params.publicClient.readContract({
    address: params.factoryAddress,
    abi: SIMPLE_ACCOUNT_FACTORY_ABI,
    functionName: 'getAddress',
    args: [params.ownerAddress, params.salt ?? 0n],
  })

  return predicted
}

export function getGaslessReadiness(
  input: GaslessReadinessInput,
): GaslessReadiness {
  const jejuBalance = input.jejuBalance ?? 0n
  const jejuCredit = input.jejuCredit ?? 0n
  const paymasterAllowance = input.paymasterAllowance ?? 0n
  const requiredJejuBalance = input.requiredJejuBalance ?? 0n
  const requiredPaymentAmount =
    input.requiredPaymentAmount ?? DEFAULT_GASLESS_PAYMENT_AMOUNT
  const targetPaymasterAllowance =
    input.targetPaymasterAllowance ?? requiredPaymentAmount

  const hasSufficientAllowance =
    jejuBalance >= requiredJejuBalance + requiredPaymentAmount &&
    paymasterAllowance >= requiredPaymentAmount

  const canSelfApproveAllowance =
    jejuBalance >= requiredJejuBalance + targetPaymasterAllowance

  // Paymaster validation checks allowance before userOp calls execute.
  // Having enough JEJU to self-approve inside the same userOp is not sufficient.
  const readyViaAllowance = hasSufficientAllowance

  const readyViaCredit =
    jejuBalance >= requiredJejuBalance && jejuCredit >= requiredPaymentAmount

  const recommendedJejuBalance = readyViaAllowance
    ? requiredJejuBalance + targetPaymasterAllowance
    : requiredJejuBalance + requiredPaymentAmount

  return {
    isReady: readyViaCredit || readyViaAllowance,
    readyViaAllowance,
    readyViaCredit,
    needsPaymasterAllowance:
      canSelfApproveAllowance && paymasterAllowance < targetPaymasterAllowance,
    preferredPath: readyViaAllowance
      ? 'allowance'
      : readyViaCredit
        ? 'credit'
        : 'not-ready',
    requiredJejuBalance,
    requiredPaymentAmount,
    recommendedJejuBalance,
    jejuBalanceShortfall:
      jejuBalance >= recommendedJejuBalance
        ? 0n
        : recommendedJejuBalance - jejuBalance,
    creditShortfall:
      jejuCredit >= requiredPaymentAmount
        ? 0n
        : requiredPaymentAmount - jejuCredit,
    allowanceShortfall:
      paymasterAllowance >= requiredPaymentAmount
        ? 0n
        : requiredPaymentAmount - paymasterAllowance,
  }
}
