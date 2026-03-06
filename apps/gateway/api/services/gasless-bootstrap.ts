import {
  getRpcUrl as getConfigRpcUrl,
  getContractsConfig,
  getCurrentNetwork,
} from '@jejunetwork/config'
import {
  DEFAULT_GASLESS_BOOTSTRAP_CREDIT_JEJU,
  DEFAULT_GASLESS_BOOTSTRAP_EXTRA_JEJU,
  DEFAULT_GASLESS_BOOTSTRAP_MAX_STAKE_JEJU,
  DEFAULT_GASLESS_PAYMENT_AMOUNT,
  type GaslessBootstrapRequest,
  GaslessBootstrapRequestSchema,
  type GaslessBootstrapResponse,
  getGaslessReadiness,
  isConfiguredAddress,
  predictSimpleAccountAddress,
} from '@jejunetwork/shared'
import { expectAddress, ZERO_ADDRESS } from '@jejunetwork/types'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getChain } from '../../lib/chains'
import { CHAIN_IDS, IS_TESTNET } from '../../lib/config/networks'

const CREDIT_MANAGER_ABI = parseAbi([
  'function balances(address user, address token) view returns (uint256)',
  'function addCredit(address user, address token, uint256 amount)',
])

const contracts = getContractsConfig(getCurrentNetwork())
const rpcUrl = getConfigRpcUrl(getCurrentNetwork())
const chain = getChain(CHAIN_IDS[getCurrentNetwork()])

const JEJU_TOKEN_ADDRESS = expectAddress(
  contracts.tokens?.jeju ?? ZERO_ADDRESS,
  'JEJU token address',
)
const CREDIT_MANAGER_ADDRESS = expectAddress(
  contracts.payments?.creditManager ?? ZERO_ADDRESS,
  'CreditManager address',
)
const SIMPLE_ACCOUNT_FACTORY_ADDRESS = expectAddress(
  contracts.accountAbstraction?.simpleAccountFactory ?? ZERO_ADDRESS,
  'SimpleAccountFactory address',
)
const MULTI_TOKEN_PAYMASTER_ADDRESS = expectAddress(
  contracts.payments?.multiTokenPaymaster ?? ZERO_ADDRESS,
  'MultiTokenPaymaster address',
)

const cooldownByOwner = new Map<string, number>()

const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
}) as any

function getBootstrapPrivateKey(): `0x${string}` {
  const key =
    process.env.GASLESS_BOOTSTRAP_PRIVATE_KEY ??
    process.env.FAUCET_PRIVATE_KEY ??
    process.env.DEPLOYER_PRIVATE_KEY

  if (!key || !key.startsWith('0x') || key.length !== 66) {
    throw new Error(
      'GASLESS_BOOTSTRAP_PRIVATE_KEY, FAUCET_PRIVATE_KEY, or DEPLOYER_PRIVATE_KEY must be configured',
    )
  }

  return key as `0x${string}`
}

function getBootstrapAccount() {
  return privateKeyToAccount(getBootstrapPrivateKey())
}

function getBootstrapWalletClient() {
  return createWalletClient({
    account: getBootstrapAccount(),
    chain,
    transport: http(rpcUrl),
  }) as any
}

function getBootstrapExtraJeju(): bigint {
  const value = process.env.GASLESS_BOOTSTRAP_EXTRA_JEJU
  if (!value) return DEFAULT_GASLESS_BOOTSTRAP_EXTRA_JEJU
  return BigInt(value)
}

function getBootstrapCreditJeju(): bigint {
  const value = process.env.GASLESS_BOOTSTRAP_CREDIT_JEJU
  if (!value) return DEFAULT_GASLESS_BOOTSTRAP_CREDIT_JEJU
  return BigInt(value)
}

function getBootstrapMaxStakeJeju(): bigint {
  const value = process.env.GASLESS_BOOTSTRAP_MAX_STAKE_JEJU
  if (!value) return DEFAULT_GASLESS_BOOTSTRAP_MAX_STAKE_JEJU
  return BigInt(value)
}

function getBootstrapCooldownMs(): number {
  const hours = Number(process.env.GASLESS_BOOTSTRAP_COOLDOWN_HOURS ?? '12')
  return Math.max(1, hours) * 60 * 60 * 1000
}

export async function bootstrapGaslessSmartAccount(
  input: unknown,
): Promise<GaslessBootstrapResponse> {
  if (!IS_TESTNET) {
    throw new Error('Gasless bootstrap is only enabled on testnet')
  }
  if (process.env.GASLESS_BOOTSTRAP_ENABLED === 'false') {
    throw new Error('Gasless bootstrap is disabled')
  }
  if (
    !isConfiguredAddress(JEJU_TOKEN_ADDRESS) ||
    !isConfiguredAddress(CREDIT_MANAGER_ADDRESS) ||
    !isConfiguredAddress(SIMPLE_ACCOUNT_FACTORY_ADDRESS)
  ) {
    throw new Error('Gasless bootstrap dependencies are not fully configured')
  }

  const request = GaslessBootstrapRequestSchema.parse(
    input,
  ) as GaslessBootstrapRequest
  const ownerAddress = expectAddress(request.ownerAddress, 'owner address')
  const smartAccountAddress = expectAddress(
    request.smartAccountAddress,
    'smart account address',
  )
  const requiredStakeAmount = BigInt(request.requiredStakeAmount)

  if (requiredStakeAmount > getBootstrapMaxStakeJeju()) {
    throw new Error('Requested stake exceeds bootstrap limit')
  }

  const predictedAddress = await predictSimpleAccountAddress({
    publicClient,
    factoryAddress: SIMPLE_ACCOUNT_FACTORY_ADDRESS,
    ownerAddress,
  })

  if (predictedAddress.toLowerCase() !== smartAccountAddress.toLowerCase()) {
    throw new Error('Predicted smart account does not match supplied address')
  }

  const cooldownKey = ownerAddress.toLowerCase()
  const cooldownUntil = cooldownByOwner.get(cooldownKey) ?? 0

  const [jejuBalance, jejuCredit, paymasterAllowance] = await Promise.all([
    publicClient.readContract({
      address: JEJU_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [smartAccountAddress],
    }),
    publicClient.readContract({
      address: CREDIT_MANAGER_ADDRESS,
      abi: CREDIT_MANAGER_ABI,
      functionName: 'balances',
      args: [smartAccountAddress, JEJU_TOKEN_ADDRESS],
    }),
    isConfiguredAddress(MULTI_TOKEN_PAYMASTER_ADDRESS)
      ? publicClient.readContract({
          address: JEJU_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [smartAccountAddress, MULTI_TOKEN_PAYMASTER_ADDRESS],
        })
      : Promise.resolve(0n),
  ])

  const readiness = getGaslessReadiness({
    jejuBalance,
    jejuCredit,
    paymasterAllowance,
    requiredJejuBalance: requiredStakeAmount,
    requiredPaymentAmount: DEFAULT_GASLESS_PAYMENT_AMOUNT,
  })

  const targetJejuBalance = requiredStakeAmount + getBootstrapExtraJeju()
  const minimumCreditForFirstGaslessTx =
    paymasterAllowance >= readiness.requiredPaymentAmount
      ? 0n
      : getBootstrapExtraJeju() >= readiness.requiredPaymentAmount
        ? getBootstrapExtraJeju()
        : readiness.requiredPaymentAmount
  const targetCredit = (() => {
    const configuredCredit = getBootstrapCreditJeju()
    return configuredCredit >= minimumCreditForFirstGaslessTx
      ? configuredCredit
      : minimumCreditForFirstGaslessTx
  })()

  const hasTargetJejuBalance = jejuBalance >= targetJejuBalance
  const hasTargetCredit = jejuCredit >= targetCredit

  if (hasTargetJejuBalance && hasTargetCredit) {
    return {
      success: true,
      smartAccountAddress,
      jejuFundedAmount: '0',
      creditAddedAmount: '0',
      alreadyReady: true,
    }
  }

  // Cooldown only rate-limits top-ups. Ready accounts should still pass through
  // this endpoint so UI flows can proceed without a cooldown error.
  if (cooldownUntil > Date.now()) {
    throw new Error('Gasless bootstrap cooldown is still active')
  }

  const jejuFundedAmount =
    jejuBalance >= targetJejuBalance ? 0n : targetJejuBalance - jejuBalance
  const creditAddedAmount =
    jejuCredit >= targetCredit ? 0n : targetCredit - jejuCredit

  const walletClient = getBootstrapWalletClient()

  let fundingTxHash: `0x${string}` | undefined
  let creditTxHash: `0x${string}` | undefined

  if (jejuFundedAmount > 0n) {
    fundingTxHash = await walletClient.writeContract({
      address: JEJU_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [smartAccountAddress, jejuFundedAmount],
    })
    await publicClient.waitForTransactionReceipt({ hash: fundingTxHash })
  }

  if (creditAddedAmount > 0n) {
    const transferToCreditManagerHash = await walletClient.writeContract({
      address: JEJU_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [CREDIT_MANAGER_ADDRESS, creditAddedAmount],
    })
    await publicClient.waitForTransactionReceipt({
      hash: transferToCreditManagerHash,
    })

    creditTxHash = await walletClient.writeContract({
      address: CREDIT_MANAGER_ADDRESS,
      abi: CREDIT_MANAGER_ABI,
      functionName: 'addCredit',
      args: [smartAccountAddress, JEJU_TOKEN_ADDRESS, creditAddedAmount],
    })
    await publicClient.waitForTransactionReceipt({ hash: creditTxHash })
  }

  // Confirm the bootstrap outcome on-chain before returning to the caller.
  const [finalJejuBalance, finalJejuCredit, finalPaymasterAllowance] =
    await Promise.all([
      publicClient.readContract({
        address: JEJU_TOKEN_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [smartAccountAddress],
      }),
      publicClient.readContract({
        address: CREDIT_MANAGER_ADDRESS,
        abi: CREDIT_MANAGER_ABI,
        functionName: 'balances',
        args: [smartAccountAddress, JEJU_TOKEN_ADDRESS],
      }),
      isConfiguredAddress(MULTI_TOKEN_PAYMASTER_ADDRESS)
        ? publicClient.readContract({
            address: JEJU_TOKEN_ADDRESS,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [smartAccountAddress, MULTI_TOKEN_PAYMASTER_ADDRESS],
          })
        : Promise.resolve(0n),
    ])

  const finalHasTargetJejuBalance = finalJejuBalance >= targetJejuBalance
  const finalHasTargetCredit = finalJejuCredit >= targetCredit
  const finalHasAllowance =
    finalPaymasterAllowance >= readiness.requiredPaymentAmount

  if (
    !(finalHasTargetJejuBalance && (finalHasAllowance || finalHasTargetCredit))
  ) {
    throw new Error(
      'Bootstrap finished but smart account is still not gasless-ready on-chain.',
    )
  }

  cooldownByOwner.set(cooldownKey, Date.now() + getBootstrapCooldownMs())

  return {
    success: true,
    smartAccountAddress,
    jejuFundedAmount: jejuFundedAmount.toString(),
    creditAddedAmount: creditAddedAmount.toString(),
    fundingTxHash,
    creditTxHash,
    alreadyReady: false,
  }
}
