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
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
} from 'wagmi'
import { CONTRACTS } from '../../lib/config'
import {
  getNodeStakingAddress,
  getNodeStakingReadAddresses,
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

function toOperatorStats(value: unknown): OperatorStats | null {
  if (!value) return null
  if (Array.isArray(value)) {
    return {
      totalNodesActive: BigInt(value[0] ?? 0),
      totalStakedUSD: BigInt(value[1] ?? 0),
      lifetimeRewardsUSD: BigInt(value[2] ?? 0),
    }
  }
  if (typeof value === 'object') {
    const tuple = value as Partial<OperatorStats>
    if (
      typeof tuple.totalNodesActive === 'bigint' &&
      typeof tuple.totalStakedUSD === 'bigint' &&
      typeof tuple.lifetimeRewardsUSD === 'bigint'
    ) {
      return {
        totalNodesActive: tuple.totalNodesActive,
        totalStakedUSD: tuple.totalStakedUSD,
        lifetimeRewardsUSD: tuple.lifetimeRewardsUSD,
      }
    }
  }
  return null
}

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

  const resolveStakeSpenderAddress = useCallback(
    (managerAddress: Address) =>
      CONTRACTS.nodeStakingRouter &&
      CONTRACTS.nodeStakingRouter === managerAddress &&
      CONTRACTS.nodeStakingVault &&
      CONTRACTS.nodeStakingVault !==
        '0x0000000000000000000000000000000000000000'
        ? CONTRACTS.nodeStakingVault
        : managerAddress,
    [],
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

  const stakingReadManagers = useMemo(() => getNodeStakingReadAddresses(), [])

  const operatorNodeContracts = useMemo(
    () =>
      operatorAddresses.flatMap((operatorAddress) =>
        stakingReadManagers.map((managerAddress) => ({
          address: managerAddress,
          abi: NODE_STAKING_MANAGER_ABI,
          functionName: 'getOperatorNodes' as const,
          args: [operatorAddress] as const,
        })),
      ),
    [operatorAddresses, stakingReadManagers],
  )

  const operatorStatsContracts = useMemo(
    () =>
      operatorAddresses.flatMap((operatorAddress) =>
        stakingReadManagers.map((managerAddress) => ({
          address: managerAddress,
          abi: NODE_STAKING_MANAGER_ABI,
          functionName: 'getOperatorStats' as const,
          args: [operatorAddress] as const,
        })),
      ),
    [operatorAddresses, stakingReadManagers],
  )

  const { data: operatorNodeResults, refetch: refetchOperatorNodes } =
    useReadContracts({
      contracts: operatorNodeContracts,
    })

  const { data: operatorStatsResults } = useReadContracts({
    contracts: operatorStatsContracts,
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
    if (!operatorNodeResults) return []
    const nodeIds: `0x${string}`[] = []
    for (const result of operatorNodeResults) {
      if (result.status !== 'success') continue
      const value = result.result as unknown
      if (!Array.isArray(value)) continue
      for (const nodeId of value) {
        if (typeof nodeId === 'string' && nodeId.startsWith('0x')) {
          nodeIds.push(nodeId as `0x${string}`)
        }
      }
    }
    return Array.from(new Set(nodeIds))
  }, [operatorNodeResults])

  const operatorStats = useMemo<OperatorStats | undefined>(() => {
    if (!operatorStatsResults) return undefined
    const stats = operatorStatsResults
      .filter(
        (
          result,
        ): result is {
          status: 'success'
          result: unknown
        } => result.status === 'success',
      )
      .map((result) => toOperatorStats(result.result))
      .filter((value): value is OperatorStats => Boolean(value))
    if (stats.length === 0) return undefined
    return stats.reduce<OperatorStats>(
      (acc, current) => ({
        totalNodesActive: acc.totalNodesActive + current.totalNodesActive,
        totalStakedUSD: acc.totalStakedUSD + current.totalStakedUSD,
        lifetimeRewardsUSD: acc.lifetimeRewardsUSD + current.lifetimeRewardsUSD,
      }),
      { totalNodesActive: 0n, totalStakedUSD: 0n, lifetimeRewardsUSD: 0n },
    )
  }, [operatorStatsResults])

  const refetchNodes = () => refetchOperatorNodes()

  const deregisterNode = async (
    nodeId: string,
    options?: { managerAddress?: Address },
  ) => {
    const targetManager = options?.managerAddress ?? stakingManager
    deregister({
      address: targetManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'deregisterNode',
      args: [nodeId as `0x${string}`],
    })
  }

  const increaseNodeStake = async (
    nodeId: string,
    stakingToken: Address,
    amount: bigint,
    options?: { gasless?: boolean; managerAddress?: Address },
  ): Promise<Hex> => {
    if (amount <= 0n) {
      throw new Error('Stake increase amount must be greater than zero')
    }

    const targetManager = options?.managerAddress ?? stakingManager
    const targetSpender = resolveStakeSpenderAddress(targetManager)

    if (options?.gasless) {
      const calls = [
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
      args: [targetSpender, amount],
    })

    return nodeActionWriteAsync({
      address: targetManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'increaseStake',
      args: [nodeId as `0x${string}`, amount],
    })
  }

  const updateNodeConfig = async (
    nodeId: string,
    rpcUrl: string,
    region: Region,
    options?: { gasless?: boolean; managerAddress?: Address },
  ): Promise<Hex> => {
    if (!rpcUrl.trim()) {
      throw new Error('RPC URL is required')
    }

    const targetManager = options?.managerAddress ?? stakingManager

    if (options?.gasless) {
      return gasless.executeGaslessCalls({
        serviceName: JEJU_NODE_REGISTRATION_SERVICE,
        calls: [
          {
            to: targetManager,
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
      address: targetManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'updateNodeConfig',
      args: [nodeId as `0x${string}`, rpcUrl, region],
    })
  }

  const updateNodeServices = async (
    nodeId: string,
    servicesHash: Hex,
    options?: { gasless?: boolean; managerAddress?: Address },
  ): Promise<Hex> => {
    if (!servicesHash || servicesHash.length !== 66) {
      throw new Error('servicesHash must be a 32-byte hex value')
    }

    const targetManager = options?.managerAddress ?? stakingManager

    if (options?.gasless) {
      return gasless.executeGaslessCalls({
        serviceName: JEJU_NODE_REGISTRATION_SERVICE,
        calls: [
          {
            to: targetManager,
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
      address: targetManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'updateNodeServices',
      args: [nodeId as `0x${string}`, servicesHash],
    })
  }

  const updateNodeMetadataURI = async (
    nodeId: string,
    metadataURI: string,
    options?: { gasless?: boolean; managerAddress?: Address },
  ): Promise<Hex> => {
    if (!metadataURI.trim()) {
      throw new Error('Metadata URI is required')
    }

    const targetManager = options?.managerAddress ?? stakingManager

    if (options?.gasless) {
      return gasless.executeGaslessCalls({
        serviceName: JEJU_NODE_REGISTRATION_SERVICE,
        calls: [
          {
            to: targetManager,
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
      address: targetManager,
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

function parseNodeInfoTuple(
  value: unknown,
): [NodeStake, PerformanceMetrics, bigint] | null {
  if (Array.isArray(value) && value.length >= 3) {
    const pending = value[2]
    if (typeof pending === 'bigint') {
      return [value[0] as NodeStake, value[1] as PerformanceMetrics, pending]
    }
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const node = (record.node ?? record[0]) as NodeStake | undefined
    const perf = (record.perf ?? record[1]) as PerformanceMetrics | undefined
    const pendingRaw = record.pendingRewardsUSD ?? record[2]
    const pending =
      typeof pendingRaw === 'bigint'
        ? pendingRaw
        : pendingRaw !== undefined
          ? BigInt(pendingRaw as string | number)
          : undefined
    if (node && perf && typeof pending === 'bigint') {
      return [node, perf, pending]
    }
  }

  return null
}

export function useNodeInfo(nodeId: string | undefined) {
  const stakingManagers = useMemo(() => getNodeStakingReadAddresses(), [])

  const contracts = useMemo(
    () =>
      nodeId
        ? stakingManagers.map((managerAddress) => ({
            address: managerAddress,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'getNodeInfo' as const,
            args: [nodeId as `0x${string}`] as const,
          }))
        : [],
    [nodeId, stakingManagers],
  )

  const {
    data: nodeInfoResults,
    refetch,
    isLoading,
    isError,
  } = useReadContracts({
    contracts,
  })

  const resolvedNodeInfo = useMemo(() => {
    if (!nodeInfoResults) return undefined

    for (let index = 0; index < nodeInfoResults.length; index += 1) {
      const result = nodeInfoResults[index]
      if (result.status !== 'success') continue
      const parsed = parseNodeInfoTuple(result.result)
      if (!parsed) continue

      const [node] = parsed
      if (
        typeof node.nodeId === 'string' &&
        /^0x0{64}$/i.test(node.nodeId as string)
      ) {
        continue
      }

      return {
        nodeInfo: parsed,
        managerAddress: stakingManagers[index],
      }
    }

    return undefined
  }, [nodeInfoResults, stakingManagers])

  return {
    nodeInfo: resolvedNodeInfo?.nodeInfo,
    managerAddress: resolvedNodeInfo?.managerAddress,
    refetch,
    isLoading,
    isError,
  }
}

export function useNodeRewards(
  nodeId: string | undefined,
  preferredManagerAddress?: Address,
) {
  const defaultManager = getNodeStakingAddress()
  const stakingManagers = useMemo(() => {
    const allManagers = getNodeStakingReadAddresses()
    if (!preferredManagerAddress) return allManagers
    return [
      preferredManagerAddress,
      ...allManagers.filter(
        (address) =>
          address.toLowerCase() !== preferredManagerAddress.toLowerCase(),
      ),
    ]
  }, [preferredManagerAddress])

  const contracts = useMemo(
    () =>
      nodeId
        ? stakingManagers.map((managerAddress) => ({
            address: managerAddress,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'calculatePendingRewards' as const,
            args: [nodeId as `0x${string}`] as const,
          }))
        : [],
    [nodeId, stakingManagers],
  )

  const { data: pendingRewardResults } = useReadContracts({
    contracts,
  })

  const pendingRewardsUSD = useMemo(() => {
    if (!pendingRewardResults) return undefined
    for (const result of pendingRewardResults) {
      if (result.status !== 'success') continue
      const value = result.result
      if (typeof value === 'bigint') return value
    }
    return undefined
  }, [pendingRewardResults])

  const {
    write: claim,
    isPending: isClaiming,
    isConfirming: isConfirmingClaim,
    isSuccess: isClaimSuccess,
  } = useTypedWriteContract()

  const claimRewards = async (nodeIdToClaim: string) => {
    claim({
      address: preferredManagerAddress ?? defaultManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'claimRewards',
      args: [nodeIdToClaim as `0x${string}`],
    })
  }

  return {
    pendingRewardsUSD,
    claimRewards,
    isClaiming: isClaiming || isConfirmingClaim,
    isClaimSuccess,
  }
}
