/**
 * Node Staking API Routes
 *
 * Provides API endpoints for querying node staking data from the
 * NodeStakingManager contract. Used by the node operator dashboard.
 */

import { getContract, getCurrentNetwork, getRpcUrl } from '@jejunetwork/config'
import { Elysia, t } from 'elysia'
import {
  type Address,
  createPublicClient,
  formatEther,
  type Hex,
  http,
} from 'viem'

function parseBooleanFlag(
  value: string | undefined,
  defaultValue = false,
): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

const INCLUDE_LEGACY_STAKING_READS = parseBooleanFlag(
  process.env.NODE_STAKING_INCLUDE_LEGACY_READS,
)

type StakingManagerSource = 'router' | 'managerV2' | 'manager' | 'legacyManagerV1'

const STAKING_MANAGER_CANDIDATES: readonly StakingManagerSource[] =
  INCLUDE_LEGACY_STAKING_READS
    ? ['managerV2', 'router', 'manager', 'legacyManagerV1']
    : ['managerV2', 'manager']

// NodeStakingManager ABI (read-only functions)
const NODE_STAKING_MANAGER_ABI = [
  {
    name: 'getNodeInfo',
    type: 'function',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [
      {
        name: 'node',
        type: 'tuple',
        components: [
          { name: 'nodeId', type: 'bytes32' },
          { name: 'operator', type: 'address' },
          { name: 'stakedToken', type: 'address' },
          { name: 'stakedAmount', type: 'uint256' },
          { name: 'stakedValueUSD', type: 'uint256' },
          { name: 'rewardToken', type: 'address' },
          { name: 'rpcUrl', type: 'string' },
          { name: 'geographicRegion', type: 'uint8' },
          { name: 'registrationTime', type: 'uint256' },
          { name: 'lastClaimTime', type: 'uint256' },
          { name: 'totalRewardsClaimed', type: 'uint256' },
          { name: 'operatorAgentId', type: 'uint256' },
          { name: 'isActive', type: 'bool' },
          { name: 'isSlashed', type: 'bool' },
        ],
      },
      {
        name: 'perf',
        type: 'tuple',
        components: [
          { name: 'uptimeScore', type: 'uint256' },
          { name: 'requestsServed', type: 'uint256' },
          { name: 'avgResponseTime', type: 'uint256' },
          { name: 'lastUpdateTime', type: 'uint256' },
        ],
      },
      { name: 'pendingRewardsUSD', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    name: 'getOperatorNodes',
    type: 'function',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ type: 'bytes32[]' }],
    stateMutability: 'view',
  },
  {
    name: 'getOperatorStats',
    type: 'function',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'totalNodesActive', type: 'uint256' },
          { name: 'totalStakedUSD', type: 'uint256' },
          { name: 'lifetimeRewardsUSD', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    name: 'getNetworkStats',
    type: 'function',
    inputs: [],
    outputs: [
      { name: 'totalNodesActive', type: 'uint256' },
      { name: '_totalStakedUSD', type: 'uint256' },
      { name: '_totalRewardsClaimedUSD', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    name: 'getTokenDistribution',
    type: 'function',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'totalStaked', type: 'uint256' },
          { name: 'totalStakedUSD', type: 'uint256' },
          { name: 'nodeCount', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    name: 'calculatePendingRewards',
    type: 'function',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'getAllNodes',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'bytes32[]' }],
    stateMutability: 'view',
  },
  {
    name: 'getNodeVersion',
    type: 'function',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [{ name: 'version', type: 'uint16' }],
    stateMutability: 'view',
  },
  {
    name: 'nodes',
    type: 'function',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'operator', type: 'address' },
      { name: 'stakedToken', type: 'address' },
      { name: 'stakedAmount', type: 'uint256' },
      { name: 'stakedValueUSD', type: 'uint256' },
      { name: 'rewardToken', type: 'address' },
      { name: 'rpcUrl', type: 'string' },
      { name: 'geographicRegion', type: 'uint8' },
      { name: 'registrationTime', type: 'uint256' },
      { name: 'lastClaimTime', type: 'uint256' },
      { name: 'totalRewardsClaimed', type: 'uint256' },
      { name: 'operatorAgentId', type: 'uint256' },
      { name: 'isActive', type: 'bool' },
      { name: 'isSlashed', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    name: 'performance',
    type: 'function',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [
      { name: 'uptimeScore', type: 'uint256' },
      { name: 'requestsServed', type: 'uint256' },
      { name: 'avgResponseTime', type: 'uint256' },
      { name: 'lastUpdateTime', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    name: 'minStakeUSD',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'baseRewardPerMonthUSD',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'nodesByRegion',
    type: 'function',
    inputs: [{ name: 'region', type: 'uint8' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

// Region enum matching the contract
const REGIONS = [
  'NorthAmerica',
  'SouthAmerica',
  'Europe',
  'Asia',
  'Africa',
  'Oceania',
] as const

type Region = (typeof REGIONS)[number]
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface NodeInfo {
  nodeId: Hex
  operator: Address
  stakedToken: Address
  stakedAmount: string
  stakedValueUSD: string
  rewardToken: Address
  rpcUrl: string
  region: Region
  registrationTime: number
  lastClaimTime: number
  totalRewardsClaimed: string
  operatorAgentId: number
  isActive: boolean
  isSlashed: boolean
  stateVersion: number | null
  isLegacy: boolean
  performance: {
    uptimeScore: number
    requestsServed: number
    avgResponseTime: number
    lastUpdateTime: number
  }
  pendingRewards: string
}

interface OperatorStats {
  totalNodesActive: number
  totalStakedUSD: string
  lifetimeRewardsUSD: string
  nodes: NodeInfo[]
}

interface NetworkStats {
  totalNodesActive: number
  totalStakedUSD: string
  totalRewardsClaimedUSD: string
  regionDistribution: Record<Region, number>
  minStakeUSD: string
  baseRewardPerMonthUSD: string
}

function getClient() {
  const network = getCurrentNetwork()
  const rpcUrl = getRpcUrl(network)
  return createPublicClient({ transport: http(rpcUrl) })
}

function resolveStakingManager(): {
  address: Address
  source: StakingManagerSource
} | null {
  return resolveStakingManagers()[0] ?? null
}

function resolveStakingManagers(): Array<{
  address: Address
  source: StakingManagerSource
}> {
  const network = getCurrentNetwork()
  const resolved: Array<{
    address: Address
    source: StakingManagerSource
  }> = []
  const seen = new Set<string>()

  for (const key of STAKING_MANAGER_CANDIDATES) {
    try {
      const address = getContract('nodeStaking', key, network)
      if (address) {
        const normalized = (address as Address).toLowerCase()
        if (!seen.has(normalized)) {
          seen.add(normalized)
          resolved.push({ address: address as Address, source: key })
        }
      }
    } catch {
      // Continue to next candidate.
    }
  }

  return resolved
}

function getStakingManagerAddress(): Address | null {
  return resolveStakingManager()?.address ?? null
}

async function readNodeVersion(
  client: ReturnType<typeof createPublicClient>,
  stakingManager: Address,
  nodeId: Hex,
): Promise<number | null> {
  try {
    const version = await client.readContract({
      address: stakingManager,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'getNodeVersion',
      args: [nodeId],
    })
    return Number(version)
  } catch {
    return null
  }
}

function inferLegacyNode(
  source: StakingManagerSource,
  stateVersion: number | null,
): boolean {
  if (stateVersion !== null) {
    return stateVersion < 3
  }
  return source !== 'router'
}

async function readNodeInfoFromManager(
  client: ReturnType<typeof createPublicClient>,
  stakingManager: Address,
  source: StakingManagerSource,
  nodeId: Hex,
): Promise<NodeInfo | null> {
  try {
    const stateVersion = await readNodeVersion(client, stakingManager, nodeId)
    let nodeInfo: unknown
    let perf: unknown
    let pendingRewards: bigint

    try {
      const fullInfo = (await client.readContract({
        address: stakingManager,
        abi: NODE_STAKING_MANAGER_ABI,
        functionName: 'getNodeInfo',
        args: [nodeId],
      })) as unknown

      if (Array.isArray(fullInfo)) {
        nodeInfo = fullInfo[0]
        perf = fullInfo[1]
        pendingRewards = fullInfo[2] as bigint
      } else if (fullInfo && typeof fullInfo === 'object') {
        const infoRecord = fullInfo as Record<string, unknown>
        nodeInfo = infoRecord.node ?? infoRecord[0]
        perf = infoRecord.perf ?? infoRecord[1]
        pendingRewards = (infoRecord.pendingRewardsUSD ??
          infoRecord[2]) as bigint
      } else {
        throw new Error('invalid getNodeInfo response shape')
      }
    } catch {
      const fallback = await Promise.all([
        client.readContract({
          address: stakingManager,
          abi: NODE_STAKING_MANAGER_ABI,
          functionName: 'nodes',
          args: [nodeId],
        }),
        client.readContract({
          address: stakingManager,
          abi: NODE_STAKING_MANAGER_ABI,
          functionName: 'performance',
          args: [nodeId],
        }),
        client.readContract({
          address: stakingManager,
          abi: NODE_STAKING_MANAGER_ABI,
          functionName: 'calculatePendingRewards',
          args: [nodeId],
        }),
      ])

      nodeInfo = fallback[0] as unknown
      perf = fallback[1] as unknown
      pendingRewards = fallback[2] as bigint
    }

    const pick = (tuple: unknown, index: number, key: string): unknown => {
      if (Array.isArray(tuple)) return tuple[index]
      if (tuple && typeof tuple === 'object') {
        const record = tuple as Record<string, unknown>
        if (record[key] !== undefined) return record[key]
      }
      return undefined
    }

    const asBigInt = (value: unknown): bigint => {
      if (typeof value === 'bigint') return value
      if (typeof value === 'number') return BigInt(value)
      if (typeof value === 'string') return BigInt(value)
      return 0n
    }

    const nodeOperator = pick(nodeInfo, 1, 'operator') as Address | undefined
    if (
      !nodeOperator ||
      nodeOperator.toLowerCase() === ZERO_ADDRESS.toLowerCase()
    ) {
      return null
    }

    const regionIndex = Number(pick(nodeInfo, 7, 'geographicRegion') ?? 0)

    return {
      nodeId: pick(nodeInfo, 0, 'nodeId') as Hex,
      operator: nodeOperator,
      stakedToken: pick(nodeInfo, 2, 'stakedToken') as Address,
      stakedAmount: formatEther(asBigInt(pick(nodeInfo, 3, 'stakedAmount'))),
      stakedValueUSD: formatEther(
        asBigInt(pick(nodeInfo, 4, 'stakedValueUSD')),
      ),
      rewardToken: pick(nodeInfo, 5, 'rewardToken') as Address,
      rpcUrl: String(pick(nodeInfo, 6, 'rpcUrl') ?? ''),
      region: REGIONS[regionIndex] || 'Global',
      registrationTime: Number(pick(nodeInfo, 8, 'registrationTime') ?? 0),
      lastClaimTime: Number(pick(nodeInfo, 9, 'lastClaimTime') ?? 0),
      totalRewardsClaimed: formatEther(
        asBigInt(pick(nodeInfo, 10, 'totalRewardsClaimed')),
      ),
      operatorAgentId: Number(pick(nodeInfo, 11, 'operatorAgentId') ?? 0),
      isActive: Boolean(pick(nodeInfo, 12, 'isActive')),
      isSlashed: Boolean(pick(nodeInfo, 13, 'isSlashed')),
      stateVersion,
      isLegacy: inferLegacyNode(source, stateVersion),
      performance: {
        uptimeScore: Number(pick(perf, 0, 'uptimeScore') ?? 0),
        requestsServed: Number(pick(perf, 1, 'requestsServed') ?? 0),
        avgResponseTime: Number(pick(perf, 2, 'avgResponseTime') ?? 0),
        lastUpdateTime: Number(pick(perf, 3, 'lastUpdateTime') ?? 0),
      },
      pendingRewards: formatEther(pendingRewards),
    }
  } catch {
    return null
  }
}

export function createStakingRouter() {
  return (
    new Elysia({ prefix: '/staking' })
      .get('/health', () => {
        const resolved = resolveStakingManager()
        return {
          status: 'healthy',
          service: 'dws-staking',
          stakingManagerConfigured: Boolean(resolved?.address),
          stakingManagerAddress: resolved?.address ?? null,
          stakingManagerSource: resolved?.source ?? null,
        }
      })

      // Get network-wide staking statistics
      .get('/network', async ({ set }) => {
        const managers = resolveStakingManagers()
        if (managers.length === 0) {
          set.status = 503
          return { error: 'Staking manager not configured' }
        }

        const client = getClient()

        const managerStats = await Promise.all(
          managers.map(async ({ address }) => {
            try {
              const [networkStats, minStake, baseReward, regionCounts] =
                await Promise.all([
                  client.readContract({
                    address,
                    abi: NODE_STAKING_MANAGER_ABI,
                    functionName: 'getNetworkStats',
                  }),
                  client.readContract({
                    address,
                    abi: NODE_STAKING_MANAGER_ABI,
                    functionName: 'minStakeUSD',
                  }),
                  client.readContract({
                    address,
                    abi: NODE_STAKING_MANAGER_ABI,
                    functionName: 'baseRewardPerMonthUSD',
                  }),
                  Promise.all(
                    REGIONS.map(async (_, index) =>
                      client.readContract({
                        address,
                        abi: NODE_STAKING_MANAGER_ABI,
                        functionName: 'nodesByRegion',
                        args: [index],
                      }),
                    ),
                  ),
                ])

              return { networkStats, minStake, baseReward, regionCounts }
            } catch {
              return null
            }
          }),
        )

        const regionDistribution: Record<Region, number> = {
          NorthAmerica: 0,
          SouthAmerica: 0,
          Europe: 0,
          Asia: 0,
          Africa: 0,
          Oceania: 0,
        }

        let totalNodesActive = 0n
        let totalStakedUSD = 0n
        let totalRewardsClaimedUSD = 0n
        let minStake = 0n
        let baseReward = 0n

        for (const result of managerStats) {
          if (!result) continue
          totalNodesActive += result.networkStats[0] as bigint
          totalStakedUSD += result.networkStats[1] as bigint
          totalRewardsClaimedUSD += result.networkStats[2] as bigint
          if (minStake === 0n) minStake = result.minStake as bigint
          if (baseReward === 0n) baseReward = result.baseReward as bigint

          REGIONS.forEach((region, index) => {
            regionDistribution[region] += Number(result.regionCounts[index])
          })
        }

        const stats: NetworkStats = {
          totalNodesActive: Number(totalNodesActive),
          totalStakedUSD: formatEther(totalStakedUSD),
          totalRewardsClaimedUSD: formatEther(totalRewardsClaimedUSD),
          regionDistribution,
          minStakeUSD: formatEther(minStake),
          baseRewardPerMonthUSD: formatEther(baseReward),
        }

        return stats
      })

      // Get operator's staking stats and nodes
      .get(
        '/operator/:address',
        async ({ params, set }) => {
          const managers = resolveStakingManagers()
          if (managers.length === 0) {
            set.status = 503
            return { error: 'Staking manager not configured' }
          }

          const operatorAddress = params.address as Address

          const client = getClient()

          const managerResults = await Promise.all(
            managers.map(async ({ address, source }) => {
              try {
                const [stats, nodeIds] = await Promise.all([
                  client.readContract({
                    address,
                    abi: NODE_STAKING_MANAGER_ABI,
                    functionName: 'getOperatorStats',
                    args: [operatorAddress],
                  }),
                  client.readContract({
                    address,
                    abi: NODE_STAKING_MANAGER_ABI,
                    functionName: 'getOperatorNodes',
                    args: [operatorAddress],
                  }),
                ])
                return { address, source, stats, nodeIds }
              } catch {
                return null
              }
            }),
          )

          let totalNodesActive = 0n
          let totalStakedUSD = 0n
          let lifetimeRewardsUSD = 0n
          const nodeSource = new Map<
            string,
            { address: Address; source: StakingManagerSource }
          >()

          for (const result of managerResults) {
            if (!result) continue
            totalNodesActive += result.stats.totalNodesActive
            totalStakedUSD += result.stats.totalStakedUSD
            lifetimeRewardsUSD += result.stats.lifetimeRewardsUSD
            for (const nodeId of result.nodeIds as Hex[]) {
              const key = nodeId.toLowerCase()
              if (!nodeSource.has(key)) {
                nodeSource.set(key, {
                  address: result.address,
                  source: result.source,
                })
              }
            }
          }

          const nodes = (
            await Promise.all(
              Array.from(nodeSource.entries()).map(async ([nodeId, entry]) =>
                readNodeInfoFromManager(
                  client,
                  entry.address,
                  entry.source,
                  nodeId as Hex,
                ),
              ),
            )
          ).filter((node): node is NodeInfo => Boolean(node))

          const stats: OperatorStats = {
            totalNodesActive: Number(totalNodesActive),
            totalStakedUSD: formatEther(totalStakedUSD),
            lifetimeRewardsUSD: formatEther(lifetimeRewardsUSD),
            nodes,
          }

          return stats
        },
        {
          params: t.Object({
            address: t.String(),
          }),
        },
      )

      // Get specific node info
      .get(
        '/node/:nodeId',
        async ({ params, set }) => {
          const managers = resolveStakingManagers()
          if (managers.length === 0) {
            set.status = 503
            return { error: 'Staking manager not configured' }
          }

          const nodeId = params.nodeId as Hex
          const client = getClient()

          let node: NodeInfo | null = null
          for (const manager of managers) {
            node = await readNodeInfoFromManager(
              client,
              manager.address,
              manager.source,
              nodeId,
            )
            if (node) break
          }
          if (!node) {
            set.status = 404
            return { error: 'Node not found' }
          }

          return node
        },
        {
          params: t.Object({
            nodeId: t.String(),
          }),
        },
      )

      // Get pending rewards for a node
      .get(
        '/rewards/:nodeId',
        async ({ params, set }) => {
          const stakingManager = getStakingManagerAddress()
          if (!stakingManager) {
            set.status = 503
            return { error: 'Staking manager not configured' }
          }

          const nodeId = params.nodeId as Hex
          const client = getClient()

          const pendingRewards = await client.readContract({
            address: stakingManager,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'calculatePendingRewards',
            args: [nodeId],
          })

          return {
            nodeId,
            pendingRewardsUSD: formatEther(pendingRewards),
          }
        },
        {
          params: t.Object({
            nodeId: t.String(),
          }),
        },
      )

      // Get all nodes (paginated)
      .get(
        '/nodes',
        async ({ query, set }) => {
          const managers = resolveStakingManagers()
          if (managers.length === 0) {
            set.status = 503
            return { error: 'Staking manager not configured' }
          }

          const limit = Math.min(parseInt(query.limit ?? '20', 10), 100)
          const offset = parseInt(query.offset ?? '0', 10)

          const client = getClient()

          const nodeSource = new Map<
            string,
            { address: Address; source: StakingManagerSource }
          >()
          for (const manager of managers) {
            try {
              const allNodeIds = (await client.readContract({
                address: manager.address,
                abi: NODE_STAKING_MANAGER_ABI,
                functionName: 'getAllNodes',
              })) as Hex[]
              for (const nodeId of allNodeIds) {
                const key = nodeId.toLowerCase()
                if (!nodeSource.has(key)) {
                  nodeSource.set(key, {
                    address: manager.address,
                    source: manager.source,
                  })
                }
              }
            } catch {
              // Ignore manager read failures and continue with available sources.
            }
          }

          const allNodeIds = Array.from(nodeSource.keys())
          const paginatedIds = allNodeIds.slice(offset, offset + limit)

          const nodes = (
            await Promise.all(
              paginatedIds.map(async (nodeId) => {
                const entry = nodeSource.get(nodeId)
                if (!entry) return null
                return readNodeInfoFromManager(
                  client,
                  entry.address,
                  entry.source,
                  nodeId as Hex,
                )
              }),
            )
          ).filter((node): node is NodeInfo => Boolean(node))

          return {
            nodes,
            total: allNodeIds.length,
            offset,
            limit,
          }
        },
        {
          query: t.Object({
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )

      // Get earnings history (from events)
      .get(
        '/history/:address',
        async ({ params, query, set }) => {
          const stakingManager = getStakingManagerAddress()
          if (!stakingManager) {
            set.status = 503
            return { error: 'Staking manager not configured' }
          }

          const operatorAddress = params.address as Address
          const fromBlock = BigInt(query.fromBlock ?? '0')
          const toBlock =
            query.toBlock === 'latest' ? 'latest' : BigInt(query.toBlock ?? '0')

          const client = getClient()

          // Get RewardsClaimed events for this operator
          const rewardsClaimedLogs = await client.getLogs({
            address: stakingManager,
            event: {
              type: 'event',
              name: 'RewardsClaimed',
              inputs: [
                { name: 'nodeId', type: 'bytes32', indexed: true },
                { name: 'operator', type: 'address', indexed: true },
                { name: 'rewardToken', type: 'address', indexed: false },
                { name: 'rewardAmount', type: 'uint256', indexed: false },
                { name: 'feesPaid', type: 'uint256', indexed: false },
              ],
            },
            args: {
              operator: operatorAddress,
            },
            fromBlock,
            toBlock: toBlock === 'latest' ? undefined : toBlock,
          })

          // Get NodeRegistered events
          const nodeRegisteredLogs = await client.getLogs({
            address: stakingManager,
            event: {
              type: 'event',
              name: 'NodeRegistered',
              inputs: [
                { name: 'nodeId', type: 'bytes32', indexed: true },
                { name: 'operator', type: 'address', indexed: true },
                { name: 'stakingToken', type: 'address', indexed: false },
                { name: 'rewardToken', type: 'address', indexed: false },
                { name: 'stakedAmount', type: 'uint256', indexed: false },
                { name: 'stakedValueUSD', type: 'uint256', indexed: false },
              ],
            },
            args: {
              operator: operatorAddress,
            },
            fromBlock,
            toBlock: toBlock === 'latest' ? undefined : toBlock,
          })

          // Combine and format
          const history = [
            ...rewardsClaimedLogs.map((log) => ({
              type: 'claim' as const,
              nodeId: log.args.nodeId as Hex,
              rewardToken: log.args.rewardToken as Address,
              amount: formatEther(log.args.rewardAmount ?? 0n),
              feesPaid: formatEther(log.args.feesPaid ?? 0n),
              blockNumber: Number(log.blockNumber),
              transactionHash: log.transactionHash,
            })),
            ...nodeRegisteredLogs.map((log) => ({
              type: 'register' as const,
              nodeId: log.args.nodeId as Hex,
              stakedToken: log.args.stakingToken as Address,
              stakedAmount: formatEther(log.args.stakedAmount ?? 0n),
              stakedValueUSD: formatEther(log.args.stakedValueUSD ?? 0n),
              blockNumber: Number(log.blockNumber),
              transactionHash: log.transactionHash,
            })),
          ].sort((a, b) => b.blockNumber - a.blockNumber)

          return {
            operator: operatorAddress,
            history,
            count: history.length,
          }
        },
        {
          params: t.Object({
            address: t.String(),
          }),
          query: t.Object({
            fromBlock: t.Optional(t.String()),
            toBlock: t.Optional(t.String()),
          }),
        },
      )

      // Claim rewards for a node (requires wallet signing on frontend)
      .post(
        '/claim/:nodeId',
        async ({ params, set }) => {
          const stakingManager = getStakingManagerAddress()
          if (!stakingManager) {
            set.status = 503
            return { error: 'Staking manager not configured' }
          }

          // Returns transaction data to be signed by user's wallet
          const nodeId = params.nodeId as Hex
          const client = getClient()

          // Get pending rewards first
          const pendingRewards = await client.readContract({
            address: stakingManager,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'calculatePendingRewards',
            args: [nodeId],
          })

          return {
            success: true,
            nodeId,
            claimed: formatEther(pendingRewards),
            message:
              'Claim prepared. Sign the transaction with your wallet to complete.',
          }
        },
        {
          params: t.Object({
            nodeId: t.String(),
          }),
        },
      )

      // Get contract info for registration (use wagmi useWriteContract client-side)
      .get('/contract-info', async ({ set }) => {
        const stakingManager = getStakingManagerAddress()
        if (!stakingManager) {
          set.status = 503
          return { error: 'Staking manager not configured' }
        }

        const client = getClient()

        const [minStake, baseReward] = await Promise.all([
          client.readContract({
            address: stakingManager,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'minStakeUSD',
          }),
          client.readContract({
            address: stakingManager,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'baseRewardPerMonthUSD',
          }),
        ])

        return {
          stakingManager,
          minStakeUSD: formatEther(minStake),
          baseRewardPerMonthUSD: formatEther(baseReward),
        }
      })

      // Update node performance metrics
      .post(
        '/update-performance',
        async ({ body, set }) => {
          const stakingManager = getStakingManagerAddress()
          if (!stakingManager) {
            set.status = 503
            return { error: 'Staking manager not configured' }
          }

          const validBody = body as { nodeId: string }
          if (!validBody.nodeId) {
            set.status = 400
            return { error: 'nodeId is required' }
          }

          const nodeId = validBody.nodeId as Hex
          const client = getClient()

          // Fetch current performance data
          const perf = await client.readContract({
            address: stakingManager,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'performance',
            args: [nodeId],
          })

          return {
            success: true,
            nodeId: validBody.nodeId,
            performance: {
              uptimeScore: Number(perf[0]),
              requestsServed: Number(perf[1]),
              avgResponseTime: Number(perf[2]),
              lastUpdateTime: Number(perf[3]),
            },
          }
        },
        {
          body: t.Object({
            nodeId: t.String(),
          }),
        },
      )
  )
}
