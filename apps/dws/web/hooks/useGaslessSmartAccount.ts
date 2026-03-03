import {
  DEFAULT_GASLESS_PAYMENT_AMOUNT,
  getConfiguredAddress,
  getGaslessReadiness,
  isConfiguredAddress,
  predictSimpleAccountAddress,
  type GaslessReadiness,
} from '@jejunetwork/shared'
import { useCallback, useEffect, useState } from 'react'
import { toSimpleSmartAccount } from 'permissionless/accounts'
import { createSmartAccountClient } from 'permissionless/clients'
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

const DEFAULT_PAYMASTER_ALLOWANCE = parseEther('10')

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
}) {
  const entryPoint = getConfiguredAddress(
    CONTRACTS.entryPointV07 || CONTRACTS.entryPoint,
  )
  const factory = getConfiguredAddress(CONTRACTS.simpleAccountFactory)
  const walletClient = params.walletClient as WalletClient<
    Transport,
    undefined,
    Account
  >

  if (!entryPoint) throw new Error('EntryPoint v0.7 is not configured')
  if (!factory) throw new Error('SimpleAccountFactory is not configured')
  if (!walletClient.account) {
    throw new Error('Connected wallet has no active account')
  }

  return toSimpleSmartAccount({
    client: params.publicClient,
    owner: walletClient,
    entryPoint: {
      address: entryPoint,
      version: '0.7',
    },
    factoryAddress: factory,
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

  const {
    data: smartAccountJejuBalance,
    refetch: refetchJejuBalance,
  } = useReadContract({
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

  const {
    data: smartAccountJejuCredit,
    refetch: refetchJejuCredit,
  } = useReadContract({
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

  const { data: lastTransactionReceipt } = useWaitForTransactionReceipt({
    hash: lastTx,
  })

  useEffect(() => {
    let cancelled = false

    async function loadSmartAccountAddress() {
      if (!walletClient || !publicClient || !ownerAddress) {
        setSmartAccountAddress(undefined)
        setSmartAccountDerivationError(null)
        return
      }

      setIsLoadingSmartAccount(true)
      setSmartAccountDerivationError(null)

      try {
        const account = await buildSmartAccount({
          publicClient,
          walletClient,
        })
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

        const resolvedAddress = await account.getAddress()
        if (
          isConfiguredAddress(resolvedAddress) &&
          resolvedAddress.toLowerCase() !== predictedAddress.toLowerCase()
        ) {
          throw new Error(
            'Predicted SimpleAccount address does not match local account derivation',
          )
        }

        if (!cancelled) {
          setSmartAccountAddress(predictedAddress)
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
      requiredPaymentAmount = DEFAULT_GASLESS_PAYMENT_AMOUNT,
    ): GaslessReadiness => {
      return getGaslessReadiness({
        jejuBalance: smartAccountJejuBalance as bigint | undefined,
        jejuCredit: smartAccountJejuCredit as bigint | undefined,
        paymasterAllowance: smartAccountPaymasterAllowance as bigint | undefined,
        requiredJejuBalance,
        requiredPaymentAmount,
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
      requiredPaymentAmount = DEFAULT_GASLESS_PAYMENT_AMOUNT,
      bootstrapPaymasterAllowance = DEFAULT_PAYMASTER_ALLOWANCE,
    }: ExecuteGaslessCallsParams) => {
      if (!walletClient || !publicClient || !ownerAddress) {
        throw new Error('Connect your wallet to use the gasless flow')
      }

      const account = await buildSmartAccount({ publicClient, walletClient })
      const readiness = getReadiness(requiredJejuBalance, requiredPaymentAmount)
      const batchedCalls = [...calls]

      if (
        readiness.needsPaymasterAllowance &&
        isConfiguredAddress(CONTRACTS.multiTokenPaymaster)
      ) {
        batchedCalls.unshift({
          to: TOKENS.jeju,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [CONTRACTS.multiTokenPaymaster, bootstrapPaymasterAllowance],
          }),
        })
      }

      const client = createSmartAccountClient({
        account,
        chain: publicClient.chain,
        bundlerTransport: http(BUNDLER_URL),
        paymaster: {
          async getPaymasterData(userOperation) {
            const { getMultiTokenPaymasterData } = await import(
              '@jejunetwork/contracts'
            )

            if (!isConfiguredAddress(CONTRACTS.multiTokenPaymaster)) {
              throw new Error('MultiTokenPaymaster is not configured')
            }

            return getMultiTokenPaymasterData(
              publicClient,
              {
                address: CONTRACTS.multiTokenPaymaster,
                paymentToken: TOKENS.jeju,
                mode: 'credit',
                paymentAmount: requiredPaymentAmount,
                serviceName,
              },
              userOperation,
            )
          },
        },
      })

      setIsExecuting(true)
      setExecutionError(null)

      try {
        const txHash = await client.sendUserOperation({
          calls: batchedCalls.map((call) => ({
            to: call.to,
            data: call.data,
            value: call.value ?? 0n,
          })),
        })
        setLastTx(txHash)
        return txHash
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Gasless execution failed'
        setExecutionError(message)
        throw error
      } finally {
        setIsExecuting(false)
      }
    },
    [getReadiness, ownerAddress, publicClient, walletClient],
  )

  return {
    ownerAddress,
    smartAccountAddress,
    isLoadingSmartAccount,
    smartAccountDerivationError,
    smartAccountJejuBalance: smartAccountJejuBalance as bigint | undefined,
    smartAccountJejuCredit: smartAccountJejuCredit as bigint | undefined,
    smartAccountPaymasterAllowance:
      smartAccountPaymasterAllowance as bigint | undefined,
    getReadiness,
    executeGaslessCalls,
    refreshState,
    isExecuting,
    executionError,
    lastTx,
    lastTransactionReceipt,
  }
}
