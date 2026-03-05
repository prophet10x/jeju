import {
  type IdentityRegistryMetadataEntry,
  JEJU_NODE_REGISTRATION_SERVICE,
} from '@jejunetwork/shared'
import {
  getConfiguredAddress,
  predictSimpleAccountAddress,
} from '@jejunetwork/shared/gasless'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
  {
    type: 'function',
    name: 'registerNodeWithAgentAndIdentity',
    inputs: [
      { name: 'stakingToken', type: 'address' },
      { name: 'stakeAmount', type: 'uint256' },
      { name: 'rewardToken', type: 'address' },
      { name: 'rpcUrl', type: 'string' },
      { name: 'region', type: 'uint8' },
      { name: 'operatorAgentId', type: 'uint256' },
      { name: 'nodeIdentityTokenURI', type: 'string' },
      {
        name: 'nodeIdentityMetadata',
        type: 'tuple[]',
        components: [
          { name: 'key', type: 'string' },
          { name: 'value', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'nodeIdentityAgentId', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'supportsAtomicNodeIdentityRegistration',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'pure',
  },
] as const

export function useNodeStaking() {
  const { address: userAddress } = useAccount()
  const publicClient = usePublicClient()
  const gasless = useGaslessSmartAccount()
  const [predictedSmartAccountAddress, setPredictedSmartAccountAddress] =
    useState<Address>()
  const [lastRegistrationHash, setLastRegistrationHash] = useState<Hex>()
  const [
    supportsAtomicNodeIdentityRegistration,
    setSupportsAtomicNodeIdentityRegistration,
  ] = useState<boolean | null>(null)
  const resolvedSmartAccountAddress =
    gasless.smartAccountAddress ?? predictedSmartAccountAddress
  const stakingManager = useMemo(
    () => getNodeStakingAddress(resolvedSmartAccountAddress ?? userAddress),
    [resolvedSmartAccountAddress, userAddress],
  )
  const stakeSpenderAddress = useMemo(
    () =>
      CONTRACTS.nodeStakingRouter &&
      CONTRACTS.nodeStakingRouter === stakingManager &&
      CONTRACTS.nodeStakingVault &&
      CONTRACTS.nodeStakingVault !==
        '0x0000000000000000000000000000000000000000'
        ? CONTRACTS.nodeStakingVault
        : stakingManager,
    [stakingManager],
  )

  useEffect(() => {
    if (stakingManager) {
      setSupportsAtomicNodeIdentityRegistration(null)
    }
  }, [stakingManager])

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

  const probeAtomicNodeIdentityRegistrationSupport = useCallback(async () => {
    if (supportsAtomicNodeIdentityRegistration !== null) {
      return supportsAtomicNodeIdentityRegistration
    }
    if (!publicClient) {
      return false
    }

    try {
      const supported = (await publicClient.readContract({
        address: stakingManager,
        abi: NODE_STAKING_WITH_AGENT_ABI,
        functionName: 'supportsAtomicNodeIdentityRegistration',
      })) as boolean

      const normalized = Boolean(supported)
      setSupportsAtomicNodeIdentityRegistration(normalized)
      return normalized
    } catch {
      setSupportsAtomicNodeIdentityRegistration(false)
      return false
    }
  }, [publicClient, stakingManager, supportsAtomicNodeIdentityRegistration])

  useEffect(() => {
    void probeAtomicNodeIdentityRegistrationSupport()
  }, [probeAtomicNodeIdentityRegistrationSupport])

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
  const {
    writeAsync: nodeActionWriteAsync,
    hash: nodeActionHash,
    isPending: isNodeActionPending,
    isConfirming: isNodeActionConfirming,
    isSuccess: isNodeActionSuccess,
    receipt: nodeActionReceipt,
  } = useTypedWriteContract()

  const registerNode = async (
    stakingToken: Address,
    stakeAmount: bigint,
    rewardToken: Address,
    rpcUrl: string,
    region: Region,
    operatorAgentId?: bigint,
    options?: {
      gasless?: boolean
      nodeIdentityTokenURI?: string
      nodeIdentityMetadata?: IdentityRegistryMetadataEntry[]
    },
  ) => {
    const shouldAttemptAtomicRegistration =
      operatorAgentId !== undefined &&
      options?.nodeIdentityTokenURI !== undefined &&
      options?.nodeIdentityMetadata !== undefined
    const shouldUseAtomicRegistration =
      shouldAttemptAtomicRegistration &&
      (await probeAtomicNodeIdentityRegistrationSupport())

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
            args: [stakeSpenderAddress, stakeAmount],
          }),
        },
        {
          to: stakingManager,
          data: shouldUseAtomicRegistration
            ? encodeFunctionData({
                abi: NODE_STAKING_WITH_AGENT_ABI,
                functionName: 'registerNodeWithAgentAndIdentity',
                args: [
                  stakingToken,
                  stakeAmount,
                  rewardToken,
                  rpcUrl,
                  region,
                  operatorAgentId as bigint,
                  options.nodeIdentityTokenURI as string,
                  options.nodeIdentityMetadata as IdentityRegistryMetadataEntry[],
                ],
              })
            : operatorAgentId !== undefined
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
      args: [stakeSpenderAddress, stakeAmount],
    })

    // Step 2: Register node (contract will transferFrom)
    if (shouldUseAtomicRegistration) {
      const hash = await registerAsync({
        address: stakingManager,
        abi: NODE_STAKING_WITH_AGENT_ABI,
        functionName: 'registerNodeWithAgentAndIdentity',
        args: [
          stakingToken,
          stakeAmount,
          rewardToken,
          rpcUrl,
          region,
          operatorAgentId as bigint,
          options?.nodeIdentityTokenURI as string,
          options?.nodeIdentityMetadata as IdentityRegistryMetadataEntry[],
        ],
      })
      setLastRegistrationHash(hash)
      return
    }

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

  const increaseNodeStake = async (
    nodeId: string,
    stakingToken: Address,
    amount: bigint,
    options?: { gasless?: boolean },
  ): Promise<Hex> => {
    if (amount <= 0n) {
      throw new Error('Stake increase amount must be greater than zero')
    }

    if (options?.gasless) {
      const calls = [
        {
          to: stakingToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [stakeSpenderAddress, amount],
          }),
        },
        {
          to: stakingManager,
          data: encodeFunctionData({
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'increaseStake',
            args: [nodeId as `0x${string}`, amount],
          }),
        },
      ]

      return gasless.executeGaslessCalls({
        serviceName: JEJU_NODE_REGISTRATION_SERVICE,
        calls,
        requiredJejuBalance:
          stakingToken.toLowerCase() === CONTRACTS.jeju.toLowerCase()
            ? amount
            : undefined,
      })
    }

    await approveAsync({
      address: stakingToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [stakeSpenderAddress, amount],
    })

    return nodeActionWriteAsync({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'increaseStake',
      args: [nodeId as `0x${string}`, amount],
    })
  }

  const updateNodeConfig = async (
    nodeId: string,
    rpcUrl: string,
    region: Region,
    options?: { gasless?: boolean },
  ): Promise<Hex> => {
    if (!rpcUrl.trim()) {
      throw new Error('RPC URL is required')
    }

    if (options?.gasless) {
      return gasless.executeGaslessCalls({
        serviceName: JEJU_NODE_REGISTRATION_SERVICE,
        calls: [
          {
            to: stakingManager,
            data: encodeFunctionData({
              abi: NODE_STAKING_MANAGER_ABI,
              functionName: 'updateNodeConfig',
              args: [nodeId as `0x${string}`, rpcUrl, region],
            }),
          },
        ],
      })
    }

    return nodeActionWriteAsync({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'updateNodeConfig',
      args: [nodeId as `0x${string}`, rpcUrl, region],
    })
  }

  const updateNodeServices = async (
    nodeId: string,
    servicesHash: Hex,
    options?: { gasless?: boolean },
  ): Promise<Hex> => {
    if (!servicesHash || servicesHash.length !== 66) {
      throw new Error('servicesHash must be a 32-byte hex value')
    }

    if (options?.gasless) {
      return gasless.executeGaslessCalls({
        serviceName: JEJU_NODE_REGISTRATION_SERVICE,
        calls: [
          {
            to: stakingManager,
            data: encodeFunctionData({
              abi: NODE_STAKING_MANAGER_ABI,
              functionName: 'updateNodeServices',
              args: [nodeId as `0x${string}`, servicesHash],
            }),
          },
        ],
      })
    }

    return nodeActionWriteAsync({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'updateNodeServices',
      args: [nodeId as `0x${string}`, servicesHash],
    })
  }

  const updateNodeMetadataURI = async (
    nodeId: string,
    metadataURI: string,
    options?: { gasless?: boolean },
  ): Promise<Hex> => {
    if (!metadataURI.trim()) {
      throw new Error('Metadata URI is required')
    }

    if (options?.gasless) {
      return gasless.executeGaslessCalls({
        serviceName: JEJU_NODE_REGISTRATION_SERVICE,
        calls: [
          {
            to: stakingManager,
            data: encodeFunctionData({
              abi: NODE_STAKING_MANAGER_ABI,
              functionName: 'setNodeMetadataURI',
              args: [nodeId as `0x${string}`, metadataURI],
            }),
          },
        ],
      })
    }

    return nodeActionWriteAsync({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'setNodeMetadataURI',
      args: [nodeId as `0x${string}`, metadataURI],
    })
  }

  return {
    operatorAddresses,
    supportsAtomicNodeIdentityRegistration:
      supportsAtomicNodeIdentityRegistration === true,
    isAtomicNodeIdentitySupportKnown:
      supportsAtomicNodeIdentityRegistration !== null,
    operatorNodeIds,
    operatorStats,
    networkStats: networkStats as [bigint, bigint, bigint] | undefined,
    registerNode,
    deregisterNode,
    increaseNodeStake,
    updateNodeConfig,
    updateNodeServices,
    updateNodeMetadataURI,
    isRegistering: isRegistering || isConfirmingRegister || gasless.isExecuting,
    isDeregistering: isDeregistering || isConfirmingDeregister,
    isMutatingNode:
      isNodeActionPending || isNodeActionConfirming || gasless.isExecuting,
    isRegisterSuccess:
      isRegisterSuccess || Boolean(gasless.lastTransactionReceipt),
    registrationHash:
      (registerHash as Hex | undefined) ??
      lastRegistrationHash ??
      gasless.lastTransactionHash,
    registrationReceipt: registerReceipt ?? gasless.lastTransactionReceipt,
    nodeActionHash:
      (nodeActionHash as Hex | undefined) ?? gasless.lastTransactionHash,
    nodeActionReceipt: nodeActionReceipt ?? gasless.lastTransactionReceipt,
    isNodeActionSuccess:
      isNodeActionSuccess || Boolean(gasless.lastTransactionReceipt),
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
