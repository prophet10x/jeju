import { JEJU_NODE_REGISTRATION_SERVICE } from '@jejunetwork/shared'
import {
  getConfiguredAddress,
  predictSimpleAccountAddress,
} from '@jejunetwork/shared/gasless'
import { useEffect, useMemo, useState } from 'react'
import { type Address, encodeFunctionData, erc20Abi, type Hex } from 'viem'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'
import { CONTRACTS } from '../../lib/config'
import {
  getNodeStakingAddress,
  NODE_STAKING_MANAGER_ABI,
  type NodeStake,
  type OperatorStats,
  type PerformanceMetrics,
  type Region,
} from '../../lib/nodeStaking'
import { useGaslessSmartAccount } from './useGaslessSmartAccount'
import { useTypedWriteContract } from './useTypedWriteContract'

const NODE_STAKING_WITH_AGENT_ABI = [
  ...NODE_STAKING_MANAGER_ABI,
  {
    type: 'function',
    name: 'registerNodeWithAgent',
    inputs: [
      { name: 'stakingToken', type: 'address' },
      { name: 'stakeAmount', type: 'uint256' },
      { name: 'rewardToken', type: 'address' },
      { name: 'rpcUrl', type: 'string' },
      { name: 'region', type: 'uint8' },
      { name: 'operatorAgentId', type: 'uint256' },
    ],
    outputs: [{ name: 'nodeId', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
] as const

export function useNodeStaking() {
  const stakingManager = getNodeStakingAddress()
  const { address: userAddress } = useAccount()
  const publicClient = usePublicClient()
  const gasless = useGaslessSmartAccount()
  const [predictedSmartAccountAddress, setPredictedSmartAccountAddress] =
    useState<Address>()
  const [lastRegistrationHash, setLastRegistrationHash] = useState<Hex>()
  const resolvedSmartAccountAddress =
    gasless.smartAccountAddress ?? predictedSmartAccountAddress

  useEffect(() => {
    let cancelled = false

    async function resolveSmartAccountAddress() {
      if (!publicClient || !userAddress) {
        setPredictedSmartAccountAddress(undefined)
        return
      }

      const factoryAddress = getConfiguredAddress(
        CONTRACTS.simpleAccountFactory,
      )
      if (!factoryAddress) {
        setPredictedSmartAccountAddress(undefined)
        return
      }

      try {
        const predictedAddress = await predictSimpleAccountAddress({
          publicClient,
          factoryAddress,
          ownerAddress: userAddress,
        })
        if (!cancelled) {
          setPredictedSmartAccountAddress(predictedAddress)
        }
      } catch {
        if (!cancelled) {
          setPredictedSmartAccountAddress(undefined)
        }
      }
    }

    void resolveSmartAccountAddress()

    return () => {
      cancelled = true
    }
  }, [publicClient, userAddress])

  const operatorAddresses = useMemo(() => {
    const addresses = [
      userAddress,
      gasless.smartAccountAddress,
      predictedSmartAccountAddress,
    ].filter((address): address is Address => Boolean(address))
    return Array.from(
      new Set(addresses.map((address) => address.toLowerCase())),
    ).map((address) => address as Address)
  }, [gasless.smartAccountAddress, predictedSmartAccountAddress, userAddress])

  const { data: eoaOperatorNodeIds, refetch: refetchEoaNodes } =
    useReadContract({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'getOperatorNodes',
      args: userAddress ? [userAddress] : undefined,
    })

  const { data: smartOperatorNodeIds, refetch: refetchSmartNodes } =
    useReadContract({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'getOperatorNodes',
      args:
        resolvedSmartAccountAddress &&
        resolvedSmartAccountAddress !== userAddress
          ? [resolvedSmartAccountAddress]
          : undefined,
    })

  const { data: eoaOperatorStats } = useReadContract({
    address: stakingManager,
    abi: NODE_STAKING_MANAGER_ABI,
    functionName: 'getOperatorStats',
    args: userAddress ? [userAddress] : undefined,
  })

  const { data: smartOperatorStats } = useReadContract({
    address: stakingManager,
    abi: NODE_STAKING_MANAGER_ABI,
    functionName: 'getOperatorStats',
    args:
      resolvedSmartAccountAddress && resolvedSmartAccountAddress !== userAddress
        ? [resolvedSmartAccountAddress]
        : undefined,
  })

  const { data: networkStats } = useReadContract({
    address: stakingManager,
    abi: NODE_STAKING_MANAGER_ABI,
    functionName: 'getNetworkStats',
  })

  const {
    writeAsync: registerAsync,
    hash: registerHash,
    isPending: isRegistering,
    isConfirming: isConfirmingRegister,
    isSuccess: isRegisterSuccess,
    receipt: registerReceipt,
  } = useTypedWriteContract()

  const { writeAsync: approveAsync } = useTypedWriteContract()

  const registerNode = async (
    stakingToken: Address,
    stakeAmount: bigint,
    rewardToken: Address,
    rpcUrl: string,
    region: Region,
    operatorAgentId?: bigint,
    options?: { gasless?: boolean },
  ) => {
    if (options?.gasless) {
      if (stakingToken !== CONTRACTS.jeju) {
        throw new Error(
          'Gasless node registration currently supports JEJU staking only.',
        )
      }

      const calls = [
        {
          to: stakingToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [stakingManager, stakeAmount],
          }),
        },
        {
          to: stakingManager,
          data:
            operatorAgentId !== undefined
              ? encodeFunctionData({
                  abi: NODE_STAKING_WITH_AGENT_ABI,
                  functionName: 'registerNodeWithAgent',
                  args: [
                    stakingToken,
                    stakeAmount,
                    rewardToken,
                    rpcUrl,
                    region,
                    operatorAgentId,
                  ],
                })
              : encodeFunctionData({
                  abi: NODE_STAKING_MANAGER_ABI,
                  functionName: 'registerNode',
                  args: [
                    stakingToken,
                    stakeAmount,
                    rewardToken,
                    rpcUrl,
                    region,
                  ],
                }),
        },
      ]

      await gasless.executeGaslessCalls({
        serviceName: JEJU_NODE_REGISTRATION_SERVICE,
        calls,
        requiredJejuBalance: stakeAmount,
      })
      return
    }

    // Step 1: Approve tokens to NodeStakingManager
    await approveAsync({
      address: stakingToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [stakingManager, stakeAmount],
    })

    // Step 2: Register node (contract will transferFrom)
    if (operatorAgentId !== undefined) {
      const hash = await registerAsync({
        address: stakingManager,
        abi: NODE_STAKING_WITH_AGENT_ABI,
        functionName: 'registerNodeWithAgent',
        args: [
          stakingToken,
          stakeAmount,
          rewardToken,
          rpcUrl,
          region,
          operatorAgentId,
        ],
      })
      setLastRegistrationHash(hash)
      return
    }

    const hash = await registerAsync({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'registerNode',
      args: [stakingToken, stakeAmount, rewardToken, rpcUrl, region],
    })
    setLastRegistrationHash(hash)
  }

  const {
    write: deregister,
    isPending: isDeregistering,
    isConfirming: isConfirmingDeregister,
    isSuccess: isDeregisterSuccess,
  } = useTypedWriteContract()

  const operatorNodeIds = useMemo(() => {
    const nodeIds = [
      ...((eoaOperatorNodeIds as `0x${string}`[] | undefined) ?? []),
      ...((smartOperatorNodeIds as `0x${string}`[] | undefined) ?? []),
    ]
    return Array.from(new Set(nodeIds))
  }, [eoaOperatorNodeIds, smartOperatorNodeIds])

  const operatorStats = useMemo<OperatorStats | undefined>(() => {
    const stats = [eoaOperatorStats, smartOperatorStats].filter(
      (value): value is OperatorStats => Boolean(value),
    )
    if (stats.length === 0) return undefined
    return stats.reduce<OperatorStats>(
      (acc, current) => ({
        totalNodesActive: acc.totalNodesActive + current.totalNodesActive,
        totalStakedUSD: acc.totalStakedUSD + current.totalStakedUSD,
        lifetimeRewardsUSD: acc.lifetimeRewardsUSD + current.lifetimeRewardsUSD,
      }),
      { totalNodesActive: 0n, totalStakedUSD: 0n, lifetimeRewardsUSD: 0n },
    )
  }, [eoaOperatorStats, smartOperatorStats])

  const refetchNodes = () =>
    Promise.all([refetchEoaNodes(), refetchSmartNodes()])

  const deregisterNode = async (nodeId: string) => {
    deregister({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'deregisterNode',
      args: [nodeId as `0x${string}`],
    })
  }

  return {
    operatorAddresses,
    operatorNodeIds,
    operatorStats,
    networkStats: networkStats as [bigint, bigint, bigint] | undefined,
    registerNode,
    deregisterNode,
    isRegistering: isRegistering || isConfirmingRegister || gasless.isExecuting,
    isDeregistering: isDeregistering || isConfirmingDeregister,
    isRegisterSuccess:
      isRegisterSuccess || Boolean(gasless.lastTransactionReceipt),
    registrationHash:
      (registerHash as Hex | undefined) ??
      lastRegistrationHash ??
      gasless.lastTransactionHash,
    registrationReceipt: registerReceipt ?? gasless.lastTransactionReceipt,
    isDeregisterSuccess,
    refetchNodes,
    gasless,
  }
}

export function useNodeInfo(nodeId: string | undefined) {
  const stakingManager = getNodeStakingAddress()

  const {
    data: nodeInfo,
    refetch,
    isLoading,
    isError,
  } = useReadContract({
    address: stakingManager,
    abi: NODE_STAKING_MANAGER_ABI,
    functionName: 'getNodeInfo',
    args: nodeId ? [nodeId as `0x${string}`] : undefined,
  })

  return {
    nodeInfo: nodeInfo as [NodeStake, PerformanceMetrics, bigint] | undefined,
    refetch,
    isLoading,
    isError,
  }
}

export function useNodeRewards(nodeId: string | undefined) {
  const stakingManager = getNodeStakingAddress()

  const { data: pendingRewardsUSD } = useReadContract({
    address: stakingManager,
    abi: NODE_STAKING_MANAGER_ABI,
    functionName: 'calculatePendingRewards',
    args: nodeId ? [nodeId as `0x${string}`] : undefined,
  })

  const {
    write: claim,
    isPending: isClaiming,
    isConfirming: isConfirmingClaim,
    isSuccess: isClaimSuccess,
  } = useTypedWriteContract()

  const claimRewards = async (nodeIdToClaim: string) => {
    claim({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'claimRewards',
      args: [nodeIdToClaim as `0x${string}`],
    })
  }

  return {
    pendingRewardsUSD: pendingRewardsUSD as bigint | undefined,
    claimRewards,
    isClaiming: isClaiming || isConfirmingClaim,
    isClaimSuccess,
  }
}
