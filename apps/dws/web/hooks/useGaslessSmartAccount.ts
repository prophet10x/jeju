import {
  getMultiTokenPaymasterData,
  toPaymasterV07Data,
} from '@jejunetwork/contracts/aa'
import {
  DEFAULT_GASLESS_PAYMENT_AMOUNT,
  type GaslessReadiness,
  getConfiguredAddress,
  getGaslessEntryPointVersion,
  getGaslessReadiness,
  isConfiguredAddress,
  predictSimpleAccountAddress,
} from '@jejunetwork/shared/gasless'
import { toJejuSimpleSmartAccount } from '@jejunetwork/shared/gasless-smart-account'
import { createSmartAccountClient } from 'permissionless/clients'
import { useCallback, useEffect, useState } from 'react'
import type {
  Account,
  Address,
  Hex,
  PublicClient,
  Transport,
  WalletClient,
} from 'viem'
import { encodeFunctionData, erc20Abi, http, parseEther } from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
  useWalletClient,
} from 'wagmi'
import { BUNDLER_URL, CONTRACTS, TOKENS } from '../config'

const PAYMENT_TOKEN_JEJU = 0 as const
const DEFAULT_GASLESS_OVERPAYMENT = DEFAULT_GASLESS_PAYMENT_AMOUNT
const DEFAULT_PAYMASTER_ALLOWANCE = parseEther('1')
const FIRST_DEPLOY_CALL_GAS_LIMIT = 2_500_000n
const FIRST_DEPLOY_VERIFICATION_GAS_LIMIT = 2_000_000n
const FIRST_DEPLOY_PRE_VERIFICATION_GAS = 300_000n
const FIRST_DEPLOY_PAYMASTER_VERIFICATION_GAS_LIMIT = 500_000n
const FIRST_DEPLOY_PAYMASTER_POST_OP_GAS_LIMIT = 120_000n

const CREDIT_MANAGER_ABI = [
  {
    type: 'function',
    name: 'balances',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

export interface GaslessCall {
  to: Address
  data: Hex
  value?: bigint
}

interface ExecuteGaslessCallsParams {
  serviceName: string
  calls: GaslessCall[]
  requiredJejuBalance?: bigint
  requiredPaymentAmount?: bigint
  bootstrapPaymasterAllowance?: bigint
}

async function buildSmartAccount(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  address?: Address
}) {
  const entryPoint = getConfiguredAddress(
    CONTRACTS.entryPointV07 || CONTRACTS.entryPoint,
  )
  const factory = getConfiguredAddress(CONTRACTS.simpleAccountFactory)
  const entryPointVersion = getGaslessEntryPointVersion(entryPoint)
  const walletClient = params.walletClient as WalletClient<
    Transport,
    undefined,
    Account
  >

  if (!entryPoint) throw new Error('EntryPoint is not configured')
  if (!factory) throw new Error('SimpleAccountFactory is not configured')
  if (!walletClient.account) {
    throw new Error('Connected wallet has no active account')
  }

  return toJejuSimpleSmartAccount({
    client: params.publicClient,
    owner: walletClient,
    entryPoint: {
      address: entryPoint,
      version: entryPointVersion,
    },
    factoryAddress: factory,
    address: params.address,
  })
}

export function useGaslessSmartAccount() {
  const { address: ownerAddress } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const [smartAccountAddress, setSmartAccountAddress] = useState<Address>()
  const [isLoadingSmartAccount, setIsLoadingSmartAccount] = useState(false)
  const [smartAccountDerivationError, setSmartAccountDerivationError] =
    useState<string | null>(null)
  const [lastTx, setLastTx] = useState<Hex>()
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionError, setExecutionError] = useState<string | null>(null)

  const { data: smartAccountJejuBalance, refetch: refetchJejuBalance } =
    useReadContract({
      address: TOKENS.jeju,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: smartAccountAddress ? [smartAccountAddress] : undefined,
      query: { enabled: Boolean(smartAccountAddress) },
    })

  const {
    data: smartAccountPaymasterAllowance,
    refetch: refetchPaymasterAllowance,
  } = useReadContract({
    address: TOKENS.jeju,
    abi: erc20Abi,
    functionName: 'allowance',
    args:
      smartAccountAddress && isConfiguredAddress(CONTRACTS.multiTokenPaymaster)
        ? [smartAccountAddress, CONTRACTS.multiTokenPaymaster]
        : undefined,
    query: {
      enabled: Boolean(
        smartAccountAddress &&
          isConfiguredAddress(CONTRACTS.multiTokenPaymaster),
      ),
    },
  })

  const { data: smartAccountJejuCredit, refetch: refetchJejuCredit } =
    useReadContract({
      address: CONTRACTS.creditManager,
      abi: CREDIT_MANAGER_ABI,
      functionName: 'balances',
      args:
        smartAccountAddress && isConfiguredAddress(CONTRACTS.creditManager)
          ? [smartAccountAddress, TOKENS.jeju]
          : undefined,
      query: {
        enabled: Boolean(
          smartAccountAddress && isConfiguredAddress(CONTRACTS.creditManager),
        ),
      },
    })

  const { data: lastTxReceipt } = useWaitForTransactionReceipt({
    hash: lastTx,
  })

  useEffect(() => {
    let cancelled = false

    async function loadSmartAccountAddress() {
      if (!publicClient || !ownerAddress) {
        setSmartAccountAddress(undefined)
        setSmartAccountDerivationError(null)
        return
      }

      setIsLoadingSmartAccount(true)
      setSmartAccountDerivationError(null)

      try {
        const factory = getConfiguredAddress(CONTRACTS.simpleAccountFactory)

        if (!factory) {
          throw new Error('SimpleAccountFactory is not configured')
        }

        const predictedAddress = await predictSimpleAccountAddress({
          publicClient,
          factoryAddress: factory,
          ownerAddress,
        })

        if (!isConfiguredAddress(predictedAddress)) {
          throw new Error('Predicted smart account address is invalid')
        }

        if (!cancelled) {
          setSmartAccountAddress(predictedAddress)
        }

        // Best-effort execution validation. Ownership gating should rely on the
        // deterministic factory-derived address, even if wallet client probing
        // fails for hardware wallet sessions.
        if (walletClient) {
          try {
            const account = await buildSmartAccount({
              publicClient,
              walletClient,
              address: predictedAddress,
            })

            const resolvedAddress = await account.getAddress()
            if (
              isConfiguredAddress(resolvedAddress) &&
              resolvedAddress.toLowerCase() !== predictedAddress.toLowerCase()
            ) {
              throw new Error(
                'Predicted SimpleAccount address does not match local account derivation',
              )
            }
          } catch (error) {
            if (!cancelled) {
              setSmartAccountDerivationError(
                error instanceof Error
                  ? `Smart account execution unavailable: ${error.message}`
                  : 'Smart account execution unavailable',
              )
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          setSmartAccountAddress(undefined)
          setSmartAccountDerivationError(
            error instanceof Error
              ? error.message
              : 'Failed to derive smart account',
          )
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSmartAccount(false)
        }
      }
    }

    void loadSmartAccountAddress()

    return () => {
      cancelled = true
    }
  }, [ownerAddress, publicClient, walletClient])

  const refreshState = useCallback(async () => {
    await Promise.all([
      refetchJejuBalance(),
      refetchPaymasterAllowance(),
      refetchJejuCredit(),
    ])
  }, [refetchJejuBalance, refetchPaymasterAllowance, refetchJejuCredit])

  const getReadiness = useCallback(
    (
      requiredJejuBalance = 0n,
      requiredPaymentAmount = DEFAULT_GASLESS_OVERPAYMENT,
    ): GaslessReadiness => {
      return getGaslessReadiness({
        jejuBalance: smartAccountJejuBalance as bigint | undefined,
        jejuCredit: smartAccountJejuCredit as bigint | undefined,
        paymasterAllowance: smartAccountPaymasterAllowance as
          | bigint
          | undefined,
        requiredJejuBalance,
        requiredPaymentAmount,
        targetPaymasterAllowance: DEFAULT_PAYMASTER_ALLOWANCE,
      })
    },
    [
      smartAccountJejuBalance,
      smartAccountJejuCredit,
      smartAccountPaymasterAllowance,
    ],
  )

  const executeGaslessCalls = useCallback(
    async ({
      serviceName,
      calls,
      requiredJejuBalance = 0n,
      requiredPaymentAmount = DEFAULT_GASLESS_OVERPAYMENT,
      bootstrapPaymasterAllowance = DEFAULT_PAYMASTER_ALLOWANCE,
    }: ExecuteGaslessCallsParams): Promise<Hex> => {
      if (!walletClient || !publicClient) {
        throw new Error('Connect a wallet first')
      }
      if (!smartAccountAddress) {
        throw new Error('Smart account is not available yet')
      }
      if (!isConfiguredAddress(CONTRACTS.multiTokenPaymaster)) {
        throw new Error('MultiTokenPaymaster is not configured')
      }

      const readiness = getGaslessReadiness({
        jejuBalance: smartAccountJejuBalance as bigint | undefined,
        jejuCredit: smartAccountJejuCredit as bigint | undefined,
        paymasterAllowance: smartAccountPaymasterAllowance as
          | bigint
          | undefined,
        requiredJejuBalance,
        requiredPaymentAmount,
        targetPaymasterAllowance: bootstrapPaymasterAllowance,
      })
      if (!readiness.readyViaAllowance) {
        throw new Error(
          'Smart account must have JEJU balance and paymaster allowance for gasless transactions',
        )
      }

      setIsExecuting(true)
      setExecutionError(null)

      try {
        const account = await buildSmartAccount({
          publicClient,
          walletClient,
          address: smartAccountAddress,
        })
        const isDeployed = await account.isDeployed()
        const gasPrice = await publicClient.getGasPrice()

        const preparedCalls = [...calls]

        if (
          readiness.needsPaymasterAllowance &&
          isConfiguredAddress(CONTRACTS.multiTokenPaymaster)
        ) {
          preparedCalls.unshift({
            to: TOKENS.jeju,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [
                CONTRACTS.multiTokenPaymaster,
                bootstrapPaymasterAllowance,
              ],
            }),
          })
        }

        const smartAccountClient = createSmartAccountClient({
          account,
          chain: publicClient.chain,
          client: publicClient,
          bundlerTransport: http(BUNDLER_URL),
          paymaster: {
            getPaymasterStubData: async () => {
              const paymasterData = getMultiTokenPaymasterData({
                paymaster: CONTRACTS.multiTokenPaymaster,
                serviceName,
                paymentToken: PAYMENT_TOKEN_JEJU,
                overpayment: requiredPaymentAmount,
              })

              return toPaymasterV07Data(paymasterData)
            },
            getPaymasterData: async () => {
              const paymasterData = getMultiTokenPaymasterData({
                paymaster: CONTRACTS.multiTokenPaymaster,
                serviceName,
                paymentToken: PAYMENT_TOKEN_JEJU,
                overpayment: requiredPaymentAmount,
              })

              return toPaymasterV07Data(paymasterData)
            },
          },
        })

        const txHash = await smartAccountClient.sendTransaction(
          isDeployed
            ? {
                calls: preparedCalls,
                maxFeePerGas: gasPrice,
                maxPriorityFeePerGas: gasPrice,
              }
            : {
                calls: preparedCalls,
                callGasLimit: FIRST_DEPLOY_CALL_GAS_LIMIT,
                verificationGasLimit: FIRST_DEPLOY_VERIFICATION_GAS_LIMIT,
                preVerificationGas: FIRST_DEPLOY_PRE_VERIFICATION_GAS,
                paymasterVerificationGasLimit:
                  FIRST_DEPLOY_PAYMASTER_VERIFICATION_GAS_LIMIT,
                paymasterPostOpGasLimit:
                  FIRST_DEPLOY_PAYMASTER_POST_OP_GAS_LIMIT,
                maxFeePerGas: gasPrice,
                maxPriorityFeePerGas: gasPrice,
              },
        )

        setLastTx(txHash)
        await refreshState()
        return txHash
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Gasless transaction failed'
        setExecutionError(message)
        throw new Error(message)
      } finally {
        setIsExecuting(false)
      }
    },
    [
      publicClient,
      refreshState,
      smartAccountAddress,
      smartAccountJejuBalance,
      smartAccountJejuCredit,
      smartAccountPaymasterAllowance,
      walletClient,
    ],
  )

  return {
    ownerAddress,
    smartAccountAddress,
    smartAccountDerivationError,
    isLoadingSmartAccount,
    smartAccountJejuBalance: smartAccountJejuBalance as bigint | undefined,
    smartAccountJejuCredit: smartAccountJejuCredit as bigint | undefined,
    smartAccountPaymasterAllowance: smartAccountPaymasterAllowance as
      | bigint
      | undefined,
    defaultGaslessOverpayment: DEFAULT_GASLESS_OVERPAYMENT,
    defaultPaymasterAllowance: DEFAULT_PAYMASTER_ALLOWANCE,
    isExecuting,
    executionError,
    lastTx,
    lastTransactionHash: lastTx,
    lastTransactionReceipt: lastTxReceipt,
    getReadiness,
    executeGaslessCalls,
    refreshState,
  }
}
