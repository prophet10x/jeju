import {
  type IdentityRegistryMetadataEntry,
  JEJU_NODE_REGISTRATION_SERVICE,
} from '@jejunetwork/shared'
import {
  getConfiguredAddress,
  predictSimpleAccountAddress,
} from '@jejunetwork/shared/gasless'
import { useJejuAuth } from '@jejunetwork/auth/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type Address, encodeFunctionData, erc20Abi, type Hex } from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContracts,
} from 'wagmi'
import { CONTRACTS, NETWORK } from '../../lib/config'
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

const NODE_STAKING_WITH_AGENT_ABI = NODE_STAKING_MANAGER_ABI

interface RegisterNodeOptions {
  gasless?: boolean
  registrationNonce?: bigint
  servicesHash?: Hex
  metadataURI?: string
  nodeIdentityTokenURI?: string
  nodeIdentityMetadata?: IdentityRegistryMetadataEntry[]
}

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

function toNetworkStats(value: unknown): [bigint, bigint, bigint] | null {
  if (!value) return null

  if (Array.isArray(value)) {
    return [
      BigInt(value[0] ?? 0),
      BigInt(value[1] ?? 0),
      BigInt(value[2] ?? 0),
    ]
  }

  if (typeof value === 'object') {
    const tuple = value as {
      totalNodesActive?: bigint
      totalStakedUSD?: bigint
      totalRewardsClaimedUSD?: bigint
    }
    if (
      typeof tuple.totalNodesActive === 'bigint' &&
      typeof tuple.totalStakedUSD === 'bigint' &&
      typeof tuple.totalRewardsClaimedUSD === 'bigint'
    ) {
      return [
        tuple.totalNodesActive,
        tuple.totalStakedUSD,
        tuple.totalRewardsClaimedUSD,
      ]
    }
  }

  return null
}

export function useNodeStaking() {
  const { address: userAddress } = useAccount()
  const { authenticated, walletAddress } = useJejuAuth()
  const publicClient = usePublicClient()
  const gasless = useGaslessSmartAccount()
  const [predictedSmartAccountAddress, setPredictedSmartAccountAddress] =
    useState<Address>()
  const [lastRegistrationHash, setLastRegistrationHash] = useState<Hex>()
  const [
    supportsAtomicNodeIdentityRegistration,
    setSupportsAtomicNodeIdentityRegistration,
  ] = useState<boolean | null>(null)
  const [
    supportsStrictAtomicProfileRegistration,
    setSupportsStrictAtomicProfileRegistration,
  ] = useState<boolean | null>(null)
  const resolvedSmartAccountAddress =
    gasless.smartAccountAddress ?? predictedSmartAccountAddress
  const ownerAddressForLookup =
    authenticated && walletAddress ? (walletAddress as Address) : undefined
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
      setSupportsStrictAtomicProfileRegistration(null)
    }
  }, [stakingManager])

  useEffect(() => {
    let cancelled = false

    async function resolveSmartAccountAddress() {
      if (!publicClient || !ownerAddressForLookup) {
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
          ownerAddress: ownerAddressForLookup,
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
  }, [ownerAddressForLookup, publicClient])

  const probeAtomicNodeIdentityRegistrationSupport = useCallback(async () => {
    if (
      supportsAtomicNodeIdentityRegistration !== null &&
      supportsStrictAtomicProfileRegistration !== null
    ) {
      return {
        atomic: supportsAtomicNodeIdentityRegistration,
        strict: supportsStrictAtomicProfileRegistration,
      }
    }
    if (!publicClient) {
      return { atomic: false, strict: false }
    }

    try {
      const supported = (await publicClient.readContract({
        address: stakingManager,
        abi: NODE_STAKING_WITH_AGENT_ABI,
        functionName: 'supportsAtomicNodeIdentityRegistration',
      })) as boolean

      let strictSupported = false
      try {
        strictSupported = (await publicClient.readContract({
          address: stakingManager,
          abi: NODE_STAKING_WITH_AGENT_ABI,
          functionName: 'supportsStrictAtomicProfileRegistration',
        })) as boolean
      } catch {
        strictSupported = false
      }

      const atomic = Boolean(supported)
      const strict = Boolean(strictSupported)
      setSupportsAtomicNodeIdentityRegistration(atomic)
      setSupportsStrictAtomicProfileRegistration(strict)
      return { atomic, strict }
    } catch {
      setSupportsAtomicNodeIdentityRegistration(false)
      setSupportsStrictAtomicProfileRegistration(false)
      return { atomic: false, strict: false }
    }
  }, [
    publicClient,
    stakingManager,
    supportsAtomicNodeIdentityRegistration,
    supportsStrictAtomicProfileRegistration,
  ])

  useEffect(() => {
    void probeAtomicNodeIdentityRegistrationSupport()
  }, [probeAtomicNodeIdentityRegistrationSupport])

  const operatorAddresses = useMemo(() => {
    const addresses = [
      ownerAddressForLookup,
      gasless.smartAccountAddress,
      predictedSmartAccountAddress,
    ].filter((address): address is Address => Boolean(address))
    return Array.from(
      new Set(addresses.map((address) => address.toLowerCase())),
    ).map((address) => address as Address)
  }, [
    gasless.smartAccountAddress,
    ownerAddressForLookup,
    predictedSmartAccountAddress,
  ])

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

  const networkStatsContracts = useMemo(
    () =>
      stakingReadManagers.map((managerAddress) => ({
        address: managerAddress,
        abi: NODE_STAKING_MANAGER_ABI,
        functionName: 'getNetworkStats' as const,
      })),
    [stakingReadManagers],
  )

  const { data: operatorNodeResults, refetch: refetchOperatorNodes } =
    useReadContracts({
      contracts: operatorNodeContracts,
      query: { enabled: operatorNodeContracts.length > 0 },
    })

  const { data: operatorStatsResults } = useReadContracts({
    contracts: operatorStatsContracts,
    query: { enabled: operatorStatsContracts.length > 0 },
  })

  const { data: networkStatsResults } = useReadContracts({
    contracts: networkStatsContracts,
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
    options?: RegisterNodeOptions,
  ) => {
    if (operatorAgentId === undefined) {
      throw new Error(
        'Operator agent ID is required. Node registration without identity is disabled.',
      )
    }
    if (
      options?.nodeIdentityTokenURI === undefined ||
      options.nodeIdentityMetadata === undefined
    ) {
      throw new Error(
        'Node identity metadata is required. Registration must use atomic identity linking.',
      )
    }

    if (
      options?.registrationNonce === undefined ||
      options.servicesHash === undefined ||
      options.metadataURI === undefined
    ) {
      throw new Error(
        'Strict node registration requires a preview nonce, services hash, and IPFS metadata URI.',
      )
    }

    const supports = await probeAtomicNodeIdentityRegistrationSupport()
    if (!supports.atomic || !supports.strict) {
      throw new Error(
        'Selected staking manager does not support strict atomic node registration.',
      )
    }

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
          data: encodeFunctionData({
            abi: NODE_STAKING_WITH_AGENT_ABI,
            functionName: 'registerNodeWithAgentIdentityAndProfile',
            args: [
              stakingToken,
              stakeAmount,
              rewardToken,
              rpcUrl,
              region,
              operatorAgentId,
              options.registrationNonce,
              options.servicesHash,
              options.metadataURI,
              options.nodeIdentityTokenURI,
              options.nodeIdentityMetadata,
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
    const hash = await registerAsync({
      address: stakingManager,
      abi: NODE_STAKING_WITH_AGENT_ABI,
      functionName: 'registerNodeWithAgentIdentityAndProfile',
      args: [
        stakingToken,
        stakeAmount,
        rewardToken,
        rpcUrl,
        region,
        operatorAgentId,
        options.registrationNonce,
        options.servicesHash,
        options.metadataURI,
        options.nodeIdentityTokenURI,
        options.nodeIdentityMetadata,
      ],
    })
    setLastRegistrationHash(hash)
  }

  const previewNextNodeId = useCallback(
    async (
      operatorAddress: Address,
      operatorAgentId: bigint,
      rpcUrl: string,
    ): Promise<Hex> => {
      if (!publicClient) {
        throw new Error('Public client is not available')
      }

      return (await publicClient.readContract({
        address: stakingManager,
        abi: NODE_STAKING_WITH_AGENT_ABI,
        functionName: 'previewNextNodeId',
        args: [operatorAddress, operatorAgentId, rpcUrl],
      })) as Hex
    },
    [publicClient, stakingManager],
  )

  const getNextOperatorNonce = useCallback(
    async (operatorAddress: Address): Promise<bigint> => {
      if (!publicClient) {
        throw new Error('Public client is not available')
      }

      return (await publicClient.readContract({
        address: stakingManager,
        abi: NODE_STAKING_WITH_AGENT_ABI,
        functionName: 'getNextOperatorNonce',
        args: [operatorAddress],
      })) as bigint
    },
    [publicClient, stakingManager],
  )

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

  const networkStats = useMemo<[bigint, bigint, bigint] | undefined>(() => {
    if (!networkStatsResults) return undefined

    const stats = networkStatsResults
      .filter(
        (
          result,
        ): result is {
          status: 'success'
          result: unknown
        } => result.status === 'success',
      )
      .map((result) => toNetworkStats(result.result))
      .filter((value): value is [bigint, bigint, bigint] => Boolean(value))

    if (stats.length === 0) return undefined

    return stats.reduce<[bigint, bigint, bigint]>(
      (acc, current) => [
        acc[0] + current[0],
        acc[1] + current[1],
        acc[2] + current[2],
      ],
      [0n, 0n, 0n],
    )
  }, [networkStatsResults])

  const operatorNodeInfoContracts = useMemo(
    () =>
      operatorNodeIds.flatMap((nodeId) =>
        stakingReadManagers.map((managerAddress) => ({
          address: managerAddress,
          abi: NODE_STAKING_MANAGER_ABI,
          functionName: 'getNodeInfo' as const,
          args: [nodeId] as const,
        })),
      ),
    [operatorNodeIds, stakingReadManagers],
  )

  const { data: operatorNodeInfoResults } = useReadContracts({
    contracts: operatorNodeInfoContracts,
    query: { enabled: operatorNodeInfoContracts.length > 0 },
  })

  const operatorNodeInfoById = useMemo(() => {
    const result = new Map<string, NodeStake>()
    if (!operatorNodeInfoResults || operatorNodeIds.length === 0) {
      return result
    }

    const managersPerNode = stakingReadManagers.length
    if (managersPerNode === 0) return result

    for (let nodeIndex = 0; nodeIndex < operatorNodeIds.length; nodeIndex += 1) {
      const nodeId = operatorNodeIds[nodeIndex]
      for (
        let managerIndex = 0;
        managerIndex < managersPerNode;
        managerIndex += 1
      ) {
        const resultIndex = nodeIndex * managersPerNode + managerIndex
        const readResult = operatorNodeInfoResults[resultIndex]
        if (!readResult || readResult.status !== 'success') continue
        const parsed = parseNodeInfoTuple(readResult.result)
        if (!parsed) continue
        const [node] = parsed
        if (
          typeof node.nodeId === 'string' &&
          /^0x0{64}$/i.test(node.nodeId as string)
        ) {
          continue
        }
        result.set(nodeId.toLowerCase(), node)
        break
      }
    }

    return result
  }, [operatorNodeIds, operatorNodeInfoResults, stakingReadManagers])

  const operatorStakeDisplayUSD = useMemo(() => {
    if (operatorNodeInfoById.size === 0) return undefined
    const jejuAddress = CONTRACTS.jeju.toLowerCase()
    let total = 0n
    for (const node of operatorNodeInfoById.values()) {
      const useTestnetPeggedValue =
        NETWORK === 'testnet' && node.stakedToken.toLowerCase() === jejuAddress
      total += useTestnetPeggedValue ? node.stakedAmount : node.stakedValueUSD
    }
    return total
  }, [operatorNodeInfoById])

  const operatorNodeCountDisplay = useMemo(() => {
    if (operatorNodeInfoById.size > 0) {
      return BigInt(operatorNodeInfoById.size)
    }
    return BigInt(operatorNodeIds.length)
  }, [operatorNodeIds, operatorNodeInfoById])

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
    supportsStrictAtomicProfileRegistration:
      supportsStrictAtomicProfileRegistration === true,
    isAtomicNodeIdentitySupportKnown:
      supportsAtomicNodeIdentityRegistration !== null &&
      supportsStrictAtomicProfileRegistration !== null,
    operatorNodeIds,
    operatorStats,
    operatorStakeDisplayUSD,
    operatorNodeCountDisplay,
    networkStats,
    registerNode,
    previewNextNodeId,
    getNextOperatorNonce,
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
