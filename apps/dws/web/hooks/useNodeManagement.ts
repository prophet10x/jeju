import { JEJU_NODE_REGISTRATION_SERVICE } from '@jejunetwork/shared'
import { useCallback, useState } from 'react'
import { type Address, encodeFunctionData, erc20Abi, type Hex } from 'viem'
import {
  useAccount,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { CONTRACTS, TOKENS, resolveNodeStakingWriteAddress } from '../config'
import { useGaslessSmartAccount } from './useGaslessSmartAccount'

const NODE_STAKING_MUTATION_ABI = [
  {
    type: 'function',
    name: 'increaseStake',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateNodeConfig',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'rpcUrl', type: 'string' },
      { name: 'region', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateNodeServices',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'servicesHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setNodeMetadataURI',
    inputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'metadataURI', type: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

interface NodeMutationOptions {
  gasless?: boolean
  managerAddress?: Address
}

export function useNodeManagement() {
  const { address } = useAccount()
  const gasless = useGaslessSmartAccount()
  const nodeStakingManagerAddress = resolveNodeStakingWriteAddress(
    gasless.smartAccountAddress ?? address,
  )
  const resolveStakeSpender = useCallback(
    (managerAddress: Address) =>
      managerAddress === CONTRACTS.nodeStakingRouter &&
      CONTRACTS.nodeStakingVault &&
      CONTRACTS.nodeStakingVault !== '0x0000000000000000000000000000000000000000'
        ? CONTRACTS.nodeStakingVault
        : managerAddress,
    [],
  )
  const publicClient = usePublicClient()
  const [lastHash, setLastHash] = useState<Hex>()
  const [lastError, setLastError] = useState<string | null>(null)

  const { writeContractAsync, data: wagmiHash, isPending } = useWriteContract()
  const {
    data: wagmiReceipt,
    isLoading: isConfirming,
    isSuccess,
  } = useWaitForTransactionReceipt({ hash: wagmiHash })

  const runDirectWrite = useCallback(
    async (args: {
      managerAddress: Address
      functionName:
        | 'increaseStake'
        | 'updateNodeConfig'
        | 'updateNodeServices'
        | 'setNodeMetadataURI'
      args: readonly unknown[]
    }) => {
      const txHash = await writeContractAsync({
        address: args.managerAddress,
        abi: NODE_STAKING_MUTATION_ABI,
        functionName: args.functionName,
        args: args.args,
      })
      setLastHash(txHash)
      return txHash
    },
    [writeContractAsync],
  )

  const increaseNodeStake = useCallback(
    async (
      nodeId: Hex,
      stakingToken: Address,
      amount: bigint,
      options?: NodeMutationOptions,
    ) => {
      if (amount <= 0n) {
        throw new Error('Stake increase amount must be greater than zero')
      }

      setLastError(null)

      try {
        const targetManager = options?.managerAddress ?? nodeStakingManagerAddress
        const targetSpender = resolveStakeSpender(targetManager)

        if (options?.gasless) {
          const txHash = await gasless.executeGaslessCalls({
            serviceName: JEJU_NODE_REGISTRATION_SERVICE,
            calls: [
              {
                to: stakingToken,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [targetSpender, amount],
                }),
              },
              {
                to: targetManager,
                data: encodeFunctionData({
                  abi: NODE_STAKING_MUTATION_ABI,
                  functionName: 'increaseStake',
                  args: [nodeId, amount],
                }),
              },
            ],
            requiredJejuBalance:
              stakingToken.toLowerCase() === TOKENS.jeju.toLowerCase()
                ? amount
                : undefined,
          })
          setLastHash(txHash)
          return txHash
        }

        const approvalHash = await writeContractAsync({
          address: stakingToken,
          abi: erc20Abi,
          functionName: 'approve',
          args: [targetSpender, amount],
        })

        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash: approvalHash })
        }

        return runDirectWrite({
          managerAddress: targetManager,
          functionName: 'increaseStake',
          args: [nodeId, amount],
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to increase stake'
        setLastError(message)
        throw new Error(message)
      }
    },
    [
      gasless,
      nodeStakingManagerAddress,
      resolveStakeSpender,
      publicClient,
      runDirectWrite,
      writeContractAsync,
    ],
  )

  const updateNodeConfig = useCallback(
    async (
      nodeId: Hex,
      rpcUrl: string,
      region: number,
      options?: NodeMutationOptions,
    ) => {
      if (!rpcUrl.trim()) throw new Error('RPC URL is required')
      setLastError(null)

      try {
        const targetManager = options?.managerAddress ?? nodeStakingManagerAddress

        if (options?.gasless) {
          const txHash = await gasless.executeGaslessCalls({
            serviceName: JEJU_NODE_REGISTRATION_SERVICE,
            calls: [
              {
                to: targetManager,
                data: encodeFunctionData({
                  abi: NODE_STAKING_MUTATION_ABI,
                  functionName: 'updateNodeConfig',
                  args: [nodeId, rpcUrl, region],
                }),
              },
            ],
          })
          setLastHash(txHash)
          return txHash
        }

        return runDirectWrite({
          managerAddress: targetManager,
          functionName: 'updateNodeConfig',
          args: [nodeId, rpcUrl, region],
        })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to update node config'
        setLastError(message)
        throw new Error(message)
      }
    },
    [gasless, nodeStakingManagerAddress, runDirectWrite],
  )

  const updateNodeServices = useCallback(
    async (nodeId: Hex, servicesHash: Hex, options?: NodeMutationOptions) => {
      if (servicesHash.length !== 66) {
        throw new Error('servicesHash must be a 32-byte hex value')
      }
      setLastError(null)

      try {
        const targetManager = options?.managerAddress ?? nodeStakingManagerAddress

        if (options?.gasless) {
          const txHash = await gasless.executeGaslessCalls({
            serviceName: JEJU_NODE_REGISTRATION_SERVICE,
            calls: [
              {
                to: targetManager,
                data: encodeFunctionData({
                  abi: NODE_STAKING_MUTATION_ABI,
                  functionName: 'updateNodeServices',
                  args: [nodeId, servicesHash],
                }),
              },
            ],
          })
          setLastHash(txHash)
          return txHash
        }

        return runDirectWrite({
          managerAddress: targetManager,
          functionName: 'updateNodeServices',
          args: [nodeId, servicesHash],
        })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to update node services'
        setLastError(message)
        throw new Error(message)
      }
    },
    [gasless, nodeStakingManagerAddress, runDirectWrite],
  )

  const updateNodeMetadataURI = useCallback(
    async (nodeId: Hex, metadataUri: string, options?: NodeMutationOptions) => {
      if (!metadataUri.trim()) throw new Error('Metadata URI is required')
      setLastError(null)

      try {
        const targetManager = options?.managerAddress ?? nodeStakingManagerAddress

        if (options?.gasless) {
          const txHash = await gasless.executeGaslessCalls({
            serviceName: JEJU_NODE_REGISTRATION_SERVICE,
            calls: [
              {
                to: targetManager,
                data: encodeFunctionData({
                  abi: NODE_STAKING_MUTATION_ABI,
                  functionName: 'setNodeMetadataURI',
                  args: [nodeId, metadataUri],
                }),
              },
            ],
          })
          setLastHash(txHash)
          return txHash
        }

        return runDirectWrite({
          managerAddress: targetManager,
          functionName: 'setNodeMetadataURI',
          args: [nodeId, metadataUri],
        })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to update metadata URI'
        setLastError(message)
        throw new Error(message)
      }
    },
    [gasless, nodeStakingManagerAddress, runDirectWrite],
  )

  return {
    increaseNodeStake,
    updateNodeConfig,
    updateNodeServices,
    updateNodeMetadataURI,
    isMutatingNode: isPending || isConfirming || gasless.isExecuting,
    isMutationSuccess: isSuccess || Boolean(gasless.lastTransactionReceipt),
    mutationHash:
      lastHash ?? (wagmiHash as Hex | undefined) ?? gasless.lastTransactionHash,
    mutationReceipt: wagmiReceipt ?? gasless.lastTransactionReceipt,
    mutationError: lastError ?? gasless.executionError,
    gasless,
  }
}
