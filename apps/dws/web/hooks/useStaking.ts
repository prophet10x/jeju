/**
 * React Hooks for Node Staking Data
 *
 * Provides hooks for querying staking information from the DWS API,
 * including operator stats, node details, and earnings history.
 */

import {
  getConfiguredAddress,
  predictSimpleAccountAddress,
} from '@jejunetwork/shared/gasless'
import { ZERO_ADDRESS } from '@jejunetwork/types'
import { useQuery } from '@tanstack/react-query'
import { useAccount, usePublicClient } from 'wagmi'
import { CONTRACTS } from '../config'
import { fetchApi } from '../lib/eden'
import { useGaslessSmartAccount } from './useGaslessSmartAccount'

// Types matching the API responses

type Region =
  | 'NorthAmerica'
  | 'SouthAmerica'
  | 'Europe'
  | 'Asia'
  | 'Africa'
  | 'Oceania'
  | 'Global'

export interface NodePerformance {
  uptimeScore: number
  requestsServed: number
  avgResponseTime: number
  lastUpdateTime: number
}

export interface NodeInfo {
  nodeId: string
  operator: string
  stakedToken: string
  stakedAmount: string
  stakedValueUSD: string
  rewardToken: string
  rpcUrl: string
  region: Region
  registrationTime: number
  lastClaimTime: number
  totalRewardsClaimed: string
  operatorAgentId: number
  isActive: boolean
  isSlashed: boolean
  metadataPending?: boolean
  performance: NodePerformance
  pendingRewards: string
}

export interface OperatorStats {
  totalNodesActive: number
  totalStakedUSD: string
  lifetimeRewardsUSD: string
  nodes: NodeInfo[]
}

export interface NetworkStats {
  totalNodesActive: number
  totalStakedUSD: string
  totalRewardsClaimedUSD: string
  regionDistribution: Record<Region, number>
  minStakeUSD: string
  baseRewardPerMonthUSD: string
}

export interface EarningsHistoryItem {
  type: 'claim' | 'register'
  nodeId: string
  rewardToken?: string
  amount?: string
  feesPaid?: string
  stakedToken?: string
  stakedAmount?: string
  stakedValueUSD?: string
  blockNumber: number
  transactionHash: string
}

export interface EarningsHistory {
  operator: string
  history: EarningsHistoryItem[]
  count: number
}

export interface NodesListResponse {
  nodes: NodeInfo[]
  total: number
  offset: number
  limit: number
}

const NODE_STAKING_OPERATOR_ABI = [
  {
    type: 'function',
    name: 'getOperatorNodes',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: 'nodeIds', type: 'bytes32[]' }],
    stateMutability: 'view',
  },
] as const

function useResolvedOperatorAddresses() {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const gasless = useGaslessSmartAccount()

  const { data: predictedSmartAccountAddress } = useQuery({
    queryKey: [
      'staking',
      'predicted-smart-account',
      address,
      CONTRACTS.simpleAccountFactory,
    ],
    queryFn: async () => {
      if (!address || !publicClient) return null
      const factoryAddress = getConfiguredAddress(
        CONTRACTS.simpleAccountFactory,
      )
      if (!factoryAddress) return null
      try {
        return await predictSimpleAccountAddress({
          publicClient,
          factoryAddress,
          ownerAddress: address,
        })
      } catch {
        return null
      }
    },
    enabled: Boolean(address && publicClient),
    staleTime: 60_000,
  })

  return Array.from(
    new Set(
      [address, gasless.smartAccountAddress, predictedSmartAccountAddress]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    ),
  )
}

/**
 * Get network-wide staking statistics
 */
export function useNetworkStats() {
  return useQuery({
    queryKey: ['staking', 'network'],
    queryFn: () => fetchApi<NetworkStats>('/staking/network'),
    refetchInterval: 60000, // Refresh every minute
  })
}

/**
 * Get staking stats and nodes for the connected operator
 */
export function useOperatorStats() {
  const operatorAddresses = useResolvedOperatorAddresses()
  const publicClient = usePublicClient()

  return useQuery({
    queryKey: [
      'staking',
      'operator',
      operatorAddresses,
      CONTRACTS.nodeStakingManager,
    ],
    queryFn: async () => {
      const [stats, onChainNodeIdsPerOperator] = await Promise.all([
        Promise.all(
          operatorAddresses.map((operatorAddress) =>
            fetchApi<OperatorStats>(`/staking/operator/${operatorAddress}`),
          ),
        ),
        Promise.all(
          operatorAddresses.map(async (operatorAddress) => {
            if (
              !publicClient ||
              !CONTRACTS.nodeStakingManager ||
              CONTRACTS.nodeStakingManager === ZERO_ADDRESS
            ) {
              return [] as `0x${string}`[]
            }

            try {
              return (await publicClient.readContract({
                address: CONTRACTS.nodeStakingManager,
                abi: NODE_STAKING_OPERATOR_ABI,
                functionName: 'getOperatorNodes',
                args: [operatorAddress as `0x${string}`],
              })) as `0x${string}`[]
            } catch {
              return [] as `0x${string}`[]
            }
          }),
        ),
      ])

      const mergedStats = stats.reduce<OperatorStats>(
        (acc, current) => ({
          totalNodesActive: acc.totalNodesActive + current.totalNodesActive,
          totalStakedUSD: (
            BigInt(acc.totalStakedUSD) + BigInt(current.totalStakedUSD)
          ).toString(),
          lifetimeRewardsUSD: (
            BigInt(acc.lifetimeRewardsUSD) + BigInt(current.lifetimeRewardsUSD)
          ).toString(),
          nodes: [
            ...acc.nodes,
            ...current.nodes.filter(
              (node) =>
                !acc.nodes.some((existing) => existing.nodeId === node.nodeId),
            ),
          ],
        }),
        {
          totalNodesActive: 0,
          totalStakedUSD: '0',
          lifetimeRewardsUSD: '0',
          nodes: [],
        },
      )

      const onChainNodeIds = Array.from(
        new Set(
          onChainNodeIdsPerOperator
            .flat()
            .map((nodeId) => nodeId.toLowerCase()),
        ),
      )
      const existingNodeIds = new Set(
        mergedStats.nodes.map((node) => node.nodeId.toLowerCase()),
      )
      const fallbackNodes: NodeInfo[] = onChainNodeIds
        .filter((nodeId) => !existingNodeIds.has(nodeId))
        .map((nodeId) => ({
          nodeId,
          operator: '',
          stakedToken: ZERO_ADDRESS,
          stakedAmount: '0',
          stakedValueUSD: '0',
          rewardToken: ZERO_ADDRESS,
          rpcUrl: 'Metadata pending',
          region: 'Global',
          registrationTime: 0,
          lastClaimTime: 0,
          totalRewardsClaimed: '0',
          operatorAgentId: 0,
          isActive: false,
          isSlashed: false,
          metadataPending: true,
          performance: {
            uptimeScore: 0,
            requestsServed: 0,
            avgResponseTime: 0,
            lastUpdateTime: 0,
          },
          pendingRewards: '0',
        }))

      return {
        ...mergedStats,
        totalNodesActive: Math.max(
          mergedStats.totalNodesActive,
          mergedStats.nodes.length + fallbackNodes.length,
        ),
        nodes: [...mergedStats.nodes, ...fallbackNodes],
      }
    },
    enabled: operatorAddresses.length > 0,
    refetchInterval: 30000, // Refresh every 30 seconds
  })
}

/**
 * Get staking stats for a specific operator address
 */
export function useOperatorStatsForAddress(operatorAddress: string | null) {
  return useQuery({
    queryKey: ['staking', 'operator', operatorAddress],
    queryFn: () =>
      fetchApi<OperatorStats>(`/staking/operator/${operatorAddress}`),
    enabled: !!operatorAddress,
    refetchInterval: 30000,
  })
}

/**
 * Get detailed info for a specific node
 */
export function useNodeInfo(nodeId: string | null) {
  return useQuery({
    queryKey: ['staking', 'node', nodeId],
    queryFn: () => fetchApi<NodeInfo>(`/staking/node/${nodeId}`),
    enabled: !!nodeId,
    refetchInterval: 15000, // Refresh every 15 seconds
  })
}

/**
 * Get pending rewards for a node
 */
export function usePendingRewards(nodeId: string | null) {
  return useQuery({
    queryKey: ['staking', 'rewards', nodeId],
    queryFn: () =>
      fetchApi<{ nodeId: string; pendingRewardsUSD: string }>(
        `/staking/rewards/${nodeId}`,
      ),
    enabled: !!nodeId,
    refetchInterval: 10000, // Refresh every 10 seconds for real-time feel
  })
}

/**
 * Get all nodes with pagination
 */
export function useAllNodes(limit = 20, offset = 0) {
  return useQuery({
    queryKey: ['staking', 'nodes', limit, offset],
    queryFn: () =>
      fetchApi<NodesListResponse>(
        `/staking/nodes?limit=${limit}&offset=${offset}`,
      ),
    refetchInterval: 60000,
  })
}

/**
 * Get earnings history for the connected operator
 */
export function useEarningsHistory(fromBlock?: string) {
  const operatorAddresses = useResolvedOperatorAddresses()

  return useQuery({
    queryKey: ['staking', 'history', operatorAddresses, fromBlock],
    queryFn: async () => {
      const params = fromBlock ? `?fromBlock=${fromBlock}` : ''
      const histories = await Promise.all(
        operatorAddresses.map((operatorAddress) =>
          fetchApi<EarningsHistory>(
            `/staking/history/${operatorAddress}${params}`,
          ),
        ),
      )
      const merged = histories.flatMap((history) => history.history)
      return {
        operator: operatorAddresses[0] ?? '',
        history: merged.sort((a, b) => b.blockNumber - a.blockNumber),
        count: merged.length,
      } satisfies EarningsHistory
    },
    enabled: operatorAddresses.length > 0,
    refetchInterval: 60000,
  })
}

/**
 * Get earnings history for a specific operator
 */
export function useEarningsHistoryForAddress(
  operatorAddress: string | null,
  fromBlock?: string,
) {
  return useQuery({
    queryKey: ['staking', 'history', operatorAddress, fromBlock],
    queryFn: () => {
      const params = fromBlock ? `?fromBlock=${fromBlock}` : ''
      return fetchApi<EarningsHistory>(
        `/staking/history/${operatorAddress}${params}`,
      )
    },
    enabled: !!operatorAddress,
    refetchInterval: 60000,
  })
}

/**
 * Calculate estimated monthly earnings based on current stats
 */
export function useEstimatedEarnings() {
  const { data: operatorStats } = useOperatorStats()
  const { data: networkStats } = useNetworkStats()

  if (!operatorStats || !networkStats) {
    return {
      estimatedMonthlyUSD: null,
      estimatedDailyUSD: null,
      isLoading: true,
    }
  }

  // Sum up pending rewards
  const totalPendingUSD = operatorStats.nodes.reduce((sum, node) => {
    return sum + parseFloat(node.pendingRewards || '0')
  }, 0)

  // Calculate time since last claim (average across nodes)
  const now = Date.now() / 1000
  const avgTimeSinceLastClaim =
    operatorStats.nodes.reduce((sum, node) => {
      return sum + (now - node.lastClaimTime)
    }, 0) / operatorStats.nodes.length

  // Project to monthly (30 days = 2592000 seconds)
  const monthlyMultiplier = 2592000 / avgTimeSinceLastClaim
  const estimatedMonthlyUSD = totalPendingUSD * monthlyMultiplier
  const estimatedDailyUSD = estimatedMonthlyUSD / 30

  return {
    estimatedMonthlyUSD: estimatedMonthlyUSD.toFixed(2),
    estimatedDailyUSD: estimatedDailyUSD.toFixed(2),
    totalPendingUSD: totalPendingUSD.toFixed(2),
    isLoading: false,
  }
}

/**
 * Get staking health status
 */
export function useStakingHealth() {
  return useQuery({
    queryKey: ['staking', 'health'],
    queryFn: () =>
      fetchApi<{
        status: string
        service: string
        stakingManagerConfigured: boolean
        stakingManagerAddress: string | null
      }>('/staking/health'),
  })
}

/**
 * Aggregate stats for display
 */
export function useAggregateStats() {
  const { data: operatorStats, isLoading: operatorLoading } = useOperatorStats()
  const { data: networkStats, isLoading: networkLoading } = useNetworkStats()
  const earnings = useEstimatedEarnings()

  const isLoading = operatorLoading || networkLoading

  if (isLoading || !operatorStats || !networkStats) {
    return { isLoading: true, data: null }
  }

  // Calculate percentage of network this operator controls
  const networkSharePercent =
    networkStats.totalNodesActive > 0
      ? (operatorStats.totalNodesActive / networkStats.totalNodesActive) * 100
      : 0

  // Calculate average uptime across nodes
  const avgUptime =
    operatorStats.nodes.length > 0
      ? operatorStats.nodes.reduce(
          (sum, node) => sum + node.performance.uptimeScore,
          0,
        ) / operatorStats.nodes.length
      : 0

  // Calculate total requests served
  const totalRequestsServed = operatorStats.nodes.reduce(
    (sum, node) => sum + node.performance.requestsServed,
    0,
  )

  return {
    isLoading: false,
    data: {
      operator: {
        nodesActive: operatorStats.totalNodesActive,
        totalStakedUSD: operatorStats.totalStakedUSD,
        lifetimeRewardsUSD: operatorStats.lifetimeRewardsUSD,
        networkSharePercent: networkSharePercent.toFixed(2),
        avgUptimePercent: (avgUptime / 100).toFixed(2),
        totalRequestsServed,
      },
      network: {
        totalNodes: networkStats.totalNodesActive,
        totalStakedUSD: networkStats.totalStakedUSD,
        totalRewardsClaimedUSD: networkStats.totalRewardsClaimedUSD,
        minStakeUSD: networkStats.minStakeUSD,
        baseRewardPerMonthUSD: networkStats.baseRewardPerMonthUSD,
        regionDistribution: networkStats.regionDistribution,
      },
      earnings: {
        estimatedMonthlyUSD: earnings.estimatedMonthlyUSD,
        estimatedDailyUSD: earnings.estimatedDailyUSD,
        totalPendingUSD: earnings.totalPendingUSD,
      },
    },
  }
}
