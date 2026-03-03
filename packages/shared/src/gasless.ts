import { z } from 'zod'
import {
  type Address,
  parseAbi,
  parseEther,
  zeroAddress,
  type PublicClient,
} from 'viem'

export const SIMPLE_ACCOUNT_FACTORY_ABI = parseAbi([
  'function getAddress(address owner, uint256 salt) view returns (address)',
])

export const GASLESS_BOOTSTRAP_PURPOSES = ['registry', 'node'] as const
export type GaslessBootstrapPurpose =
  (typeof GASLESS_BOOTSTRAP_PURPOSES)[number]

export interface GaslessReadiness {
  isReady: boolean
  readyViaCredit: boolean
  readyViaAllowance: boolean
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

export const DEFAULT_GASLESS_PAYMENT_AMOUNT = parseEther('1')
export const DEFAULT_GASLESS_BOOTSTRAP_EXTRA_JEJU = parseEther('1')
export const DEFAULT_GASLESS_BOOTSTRAP_CREDIT_JEJU = parseEther('1')
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

  const readyViaCredit =
    jejuBalance >= requiredJejuBalance &&
    jejuCredit >= requiredPaymentAmount

  const readyViaAllowance =
    jejuBalance >= requiredJejuBalance + requiredPaymentAmount &&
    paymasterAllowance >= requiredPaymentAmount

  const recommendedJejuBalance =
    requiredJejuBalance + requiredPaymentAmount

  return {
    isReady: readyViaCredit || readyViaAllowance,
    readyViaCredit,
    readyViaAllowance,
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
