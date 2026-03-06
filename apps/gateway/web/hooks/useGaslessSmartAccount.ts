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
import {
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  parseEther,
} from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
  useWalletClient,
} from 'wagmi'
import { BUNDLER_URL, CONTRACTS } from '../../lib/config'

const PAYMENT_TOKEN_JEJU = 0 as const
const DEFAULT_GASLESS_OVERPAYMENT = DEFAULT_GASLESS_PAYMENT_AMOUNT
const DEFAULT_PAYMASTER_ALLOWANCE = parseEther('1')
const FIRST_DEPLOY_CALL_GAS_LIMIT = 2_500_000n
const FIRST_DEPLOY_VERIFICATION_GAS_LIMIT = 2_000_000n
const FIRST_DEPLOY_PRE_VERIFICATION_GAS = 300_000n
const USER_OPERATION_EVENT_TOPIC =
  '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f'
const USER_OPERATION_REVERT_REASON_TOPIC =
  '0xf62676f440ff169a3a9afdbf812e89e7f95975ee8e5c31214ffdef631c5f4792'
const POST_OP_REVERTED_SELECTOR = '0xad7954bc'

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
  {
    type: 'function',
    name: 'authorizedServices',
    inputs: [{ name: 'service', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
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

function topicForAddress(address: Address): Hex {
  return `0x${address.toLowerCase().slice(2).padStart(64, '0')}` as Hex
}

function getUserOperationFailureMessage(params: {
  receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>
  entryPointAddress: Address
  senderAddress: Address
}): string | null {
  const { receipt, entryPointAddress, senderAddress } = params
  const senderTopic = topicForAddress(senderAddress).toLowerCase()
  const entryPointLower = entryPointAddress.toLowerCase()

  const entryPointLogs = receipt.logs
    .filter((log) => log.address.toLowerCase() === entryPointLower)
    .map(
      (log) =>
        log as {
          address: Address
          data: Hex
          topics?: readonly Hex[]
        },
    )
  const userOperationLog = entryPointLogs.find((log) => {
    const topic0 = log.topics?.[0]?.toLowerCase()
    const sender = log.topics?.[2]?.toLowerCase()
    return (
      topic0 === USER_OPERATION_EVENT_TOPIC && sender === senderTopic
    )
  })

  if (!userOperationLog) return null

  let success = false
  try {
    ;[, success] = decodeAbiParameters(
      [
        { type: 'uint256' }, // nonce
        { type: 'bool' }, // success
        { type: 'uint256' }, // actualGasCost
        { type: 'uint256' }, // actualGasUsed
      ],
      userOperationLog.data,
    )
  } catch {
    return 'Gasless transaction mined, but user operation status could not be decoded.'
  }

  if (success) return null

  const userOpHash = userOperationLog.topics?.[1]?.toLowerCase()
  if (!userOpHash) {
    return 'Gasless user operation failed in EntryPoint.'
  }

  const revertReasonLog = entryPointLogs.find((log) => {
    const topic0 = log.topics?.[0]?.toLowerCase()
    const topic1 = log.topics?.[1]?.toLowerCase()
    const topic2 = log.topics?.[2]?.toLowerCase()
    return (
      topic0 === USER_OPERATION_REVERT_REASON_TOPIC &&
      topic1 === userOpHash &&
      topic2 === senderTopic
    )
  })

  if (!revertReasonLog) {
    return 'Gasless user operation failed in EntryPoint.'
  }

  try {
    const [, revertReason] = decodeAbiParameters(
      [
        { type: 'uint256' }, // nonce
        { type: 'bytes' }, // revertReason
      ],
      revertReasonLog.data,
    )

    const reasonHex = (revertReason as Hex).toLowerCase()
    if (!reasonHex || reasonHex === '0x') {
      return 'Gasless user operation failed in EntryPoint.'
    }
    if (reasonHex.startsWith(POST_OP_REVERTED_SELECTOR)) {
      return 'Paymaster postOp reverted (PostOpReverted).'
    }
    return `Gasless user operation reverted: ${reasonHex}`
  } catch {
    return 'Gasless user operation failed in EntryPoint.'
  }
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
      address: CONTRACTS.jeju,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: smartAccountAddress ? [smartAccountAddress] : undefined,
      query: { enabled: Boolean(smartAccountAddress) },
    })

  const {
    data: smartAccountPaymasterAllowance,
    refetch: refetchPaymasterAllowance,
  } = useReadContract({
    address: CONTRACTS.jeju,
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
          ? [smartAccountAddress, CONTRACTS.jeju]
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
        throw new Error(
          'Wallet signer unavailable. Connect your EOA in Rabby/MetaMask to sign this transaction.',
        )
      }
      if (!ownerAddress) {
        throw new Error(
          'Wallet signer unavailable. Connect your EOA in Rabby/MetaMask to sign this transaction.',
        )
      }
      if (!smartAccountAddress) {
        throw new Error('Smart account is not available yet')
      }
      if (!isConfiguredAddress(CONTRACTS.multiTokenPaymaster)) {
        throw new Error('MultiTokenPaymaster is not configured')
      }

      const loadReadiness = async (): Promise<GaslessReadiness> => {
        const [latestJejuBalance, latestJejuCredit, latestPaymasterAllowance] =
          await Promise.all([
            publicClient.readContract({
              address: CONTRACTS.jeju,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [smartAccountAddress],
            }),
            isConfiguredAddress(CONTRACTS.creditManager)
              ? publicClient.readContract({
                  address: CONTRACTS.creditManager,
                  abi: CREDIT_MANAGER_ABI,
                  functionName: 'balances',
                  args: [smartAccountAddress, CONTRACTS.jeju],
                })
              : Promise.resolve(0n),
            publicClient.readContract({
              address: CONTRACTS.jeju,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [smartAccountAddress, CONTRACTS.multiTokenPaymaster],
            }),
          ])

        return getGaslessReadiness({
          jejuBalance: latestJejuBalance as bigint,
          jejuCredit: latestJejuCredit as bigint,
          paymasterAllowance: latestPaymasterAllowance as bigint,
          requiredJejuBalance,
          requiredPaymentAmount,
          targetPaymasterAllowance: bootstrapPaymasterAllowance,
        })
      }

      const bootstrapSmartAccount = async () => {
        const response = await fetch('./api/gasless/bootstrap', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ownerAddress,
            smartAccountAddress,
            purpose: 'registry',
            requiredStakeAmount: requiredJejuBalance.toString(),
          }),
        })

        const rawBody = await response.text()
        const payload = (
          rawBody
            ? JSON.parse(rawBody)
            : {
                success: false,
                error: 'Empty response from bootstrap endpoint',
              }
        ) as { success?: boolean; error?: string }

        if (!response.ok || !payload.success) {
          throw new Error(payload.error ?? 'Failed to prepare smart account')
        }

        await refreshState()
      }

      const normalizeExecutionError = (message: string): string => {
        const normalized = message.toLowerCase()
        if (
          normalized.includes('0xdc0b34cd') ||
          normalized.includes('unauthorizedservice')
        ) {
          return `Paymaster is not authorized in CreditManager. Operator must call CreditManager.setServiceAuthorization(${CONTRACTS.multiTokenPaymaster}, true).`
        }
        if (
          normalized.includes(POST_OP_REVERTED_SELECTOR) ||
          normalized.includes('postopreverted')
        ) {
          return 'Paymaster postOp reverted. Verify JEJU paymaster allowance/credit and paymaster service authorization.'
        }
        if (
          normalized.includes('0xb0a6a455') ||
          normalized.includes('insufficientcreditandnopayment')
        ) {
          return 'Insufficient JEJU credit and paymaster allowance for gasless execution.'
        }
        return message
      }

      const shouldRetryAfterBootstrap = (message: string): boolean => {
        const normalized = message.toLowerCase()
        return (
          normalized.includes('aa33') ||
          normalized.includes('0xb0a6a455') ||
          normalized.includes('insufficientcreditandnopayment') ||
          normalized.includes('not gasless-ready') ||
          normalized.includes(
            'failed to prime paymaster allowance via credit',
          ) ||
          normalized.includes('paymaster allowance priming did not complete')
        )
      }

      const sendGaslessTransaction = async (
        initialReadiness: GaslessReadiness,
      ): Promise<Hex> => {
        let readiness = initialReadiness
        const needsAllowancePriming =
          readiness.readyViaCredit && !readiness.readyViaAllowance

        const account = await buildSmartAccount({
          publicClient,
          walletClient,
          address: smartAccountAddress,
        })
        const isDeployed = await account.isDeployed()
        const gasPrice = await publicClient.getGasPrice()

        const sendWithOverpayment = async (
          callsToSend: GaslessCall[],
          overpayment: bigint,
        ): Promise<Hex> => {
          const buildPaymasterV07 = (): {
            paymaster: Address
            paymasterData: Hex
          } => {
            const paymasterData = getMultiTokenPaymasterData({
              paymaster: CONTRACTS.multiTokenPaymaster,
              serviceName,
              paymentToken: PAYMENT_TOKEN_JEJU,
              overpayment,
            })
            const v07Paymaster = toPaymasterV07Data(paymasterData)
            // Leave gas limits undefined so the bundler can estimate
            // paymasterVerificationGasLimit/paymasterPostOpGasLimit per tx.
            return {
              paymaster: v07Paymaster.paymaster,
              paymasterData: v07Paymaster.paymasterData,
            }
          }

          const smartAccountClient = createSmartAccountClient({
            account,
            chain: publicClient.chain,
            client: publicClient,
            bundlerTransport: http(BUNDLER_URL),
            paymaster: {
              getPaymasterStubData: async () => {
                return buildPaymasterV07()
              },
              getPaymasterData: async () => {
                return buildPaymasterV07()
              },
            },
          })

          return smartAccountClient.sendTransaction(
            isDeployed
              ? {
                  calls: callsToSend,
                  maxFeePerGas: gasPrice,
                  maxPriorityFeePerGas: gasPrice,
                }
              : {
                  calls: callsToSend,
                  callGasLimit: FIRST_DEPLOY_CALL_GAS_LIMIT,
                  verificationGasLimit: FIRST_DEPLOY_VERIFICATION_GAS_LIMIT,
                  preVerificationGas: FIRST_DEPLOY_PRE_VERIFICATION_GAS,
                  maxFeePerGas: gasPrice,
                  maxPriorityFeePerGas: gasPrice,
                },
          )
        }

        if (needsAllowancePriming) {
          const paymasterIsAuthorized = isConfiguredAddress(
            CONTRACTS.creditManager,
          )
            ? await publicClient.readContract({
                address: CONTRACTS.creditManager,
                abi: CREDIT_MANAGER_ABI,
                functionName: 'authorizedServices',
                args: [CONTRACTS.multiTokenPaymaster],
              })
            : false

          if (!paymasterIsAuthorized) {
            throw new Error(
              normalizeExecutionError(
                'UnauthorizedService: paymaster is not authorized in CreditManager',
              ),
            )
          }

          const primeHash = await sendWithOverpayment(
            [
              {
                to: CONTRACTS.jeju,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [
                    CONTRACTS.multiTokenPaymaster,
                    bootstrapPaymasterAllowance,
                  ],
                }),
              },
            ],
            0n,
          )
          const primeReceipt = await publicClient.waitForTransactionReceipt({
            hash: primeHash,
          })
          if (primeReceipt.status !== 'success') {
            throw new Error('Failed to prime paymaster allowance via credit.')
          }

          await refreshState()

          const postPrimeReadiness = await loadReadiness()
          readiness = postPrimeReadiness

          if (!readiness.readyViaAllowance) {
            throw new Error(
              'Paymaster allowance priming did not complete. Retry after confirmation.',
            )
          }
        }

        const preparedCalls = [...calls]
        if (readiness.needsPaymasterAllowance) {
          preparedCalls.unshift({
            to: CONTRACTS.jeju,
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

        const txHash = await sendWithOverpayment(
          preparedCalls,
          requiredPaymentAmount,
        )
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
        })
        if (receipt.status !== 'success') {
          throw new Error('Gasless transaction reverted on-chain.')
        }

        const entryPointAddress = getConfiguredAddress(
          CONTRACTS.entryPointV07 || CONTRACTS.entryPoint,
        )
        if (entryPointAddress) {
          const userOpFailure = getUserOperationFailureMessage({
            receipt,
            entryPointAddress,
            senderAddress: smartAccountAddress,
          })
          if (userOpFailure) {
            throw new Error(userOpFailure)
          }
        }

        setLastTx(txHash)
        await refreshState()
        return txHash
      }

      setIsExecuting(true)
      setExecutionError(null)

      try {
        let readiness = await loadReadiness()

        if (!readiness.isReady) {
          await bootstrapSmartAccount()
          readiness = await loadReadiness()
          if (!readiness.isReady) {
            throw new Error(
              'Smart account is not gasless-ready yet (needs JEJU credit or JEJU paymaster allowance).',
            )
          }
        }

        try {
          return await sendGaslessTransaction(readiness)
        } catch (error) {
          const rawMessage =
            error instanceof Error
              ? error.message
              : 'Gasless transaction failed'
          const message = normalizeExecutionError(rawMessage)

          if (!shouldRetryAfterBootstrap(rawMessage)) {
            throw new Error(message)
          }

          await bootstrapSmartAccount()
          const retryReadiness = await loadReadiness()
          if (!retryReadiness.isReady) {
            throw new Error(
              'Smart account is not gasless-ready yet (needs JEJU credit or JEJU paymaster allowance).',
            )
          }
          return await sendGaslessTransaction(retryReadiness)
        }
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
      ownerAddress,
      publicClient,
      refreshState,
      smartAccountAddress,
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
    lastTransactionHash: lastTx,
    lastTransactionReceipt: lastTxReceipt,
    getReadiness,
    executeGaslessCalls,
    refreshState,
  }
}
