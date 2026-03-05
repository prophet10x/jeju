/**
 * Node Staking Processor - indexes legacy manager events and V3 registry/router events.
 */

import type { Store } from '@subsquid/typeorm-store'
import { keccak256, parseAbi, stringToHex } from 'viem'
import {
  GovernanceEvent,
  GovernanceProposal,
  NodeStake,
  PerformanceUpdate,
  RewardClaim,
} from '../src/model'
import { getNetworkConfig } from './network-config'
import type { ProcessorContext } from './processor'
import { decodeEventArgs } from './utils/hex'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface LegacyNodeRegisteredArgs {
  nodeId: string
  operator: string
  stakedToken: string
  stakedAmount: bigint
  rpcUrl: string
  region: number
}

interface RouterNodeRegisteredArgs {
  nodeId: string
  operator: string
  stakedToken: string
  rewardToken: string
  stakedAmount: bigint
  stakedValueUSD: bigint
}

interface PerformanceUpdatedArgs {
  nodeId: string
  uptimeScore: bigint
  requestsServed: bigint
  avgResponseTime: bigint
}

interface RewardsClaimedArgs {
  nodeId: string
  operator: string
  rewardToken: string
  amount: bigint
  paymasterFeesETH: bigint
}

interface NodeSlashedArgs {
  nodeId: string
}

interface NodeDeregisteredArgs {
  nodeId: string
  operator: string
}

interface NodeCreatedArgs {
  nodeId: string
  operator: string
  version: number
}

interface NodeStakeIncreasedArgs {
  nodeId: string
  operator: string
  amount: bigint
  addedValueUSD: bigint
}

interface NodeConfigUpdatedArgs {
  nodeId: string
  operator: string
  rpcUrl: string
  region: number
}

interface NodeRewardsClaimedArgs {
  nodeId: string
  operator: string
  rewardsUSD: bigint
}

interface NodeDeactivatedArgs {
  nodeId: string
  operator: string
  unstakedAmount: bigint
}

interface ProposalCreatedArgs {
  proposalId: string
  parameter: string
  currentValue: bigint
  proposedValue: bigint
  proposer: string
}

interface ProposalExecutedArgs {
  proposalId: string
  outcome: boolean
}

interface ProposalVetoedArgs {
  proposalId: string
  admin: string
  reason: string
}

const EMPTY_BYTES32 = Buffer.from(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex',
)

const stakingEventInterface = parseAbi([
  // Legacy manager
  'event NodeRegistered(bytes32 indexed nodeId, address indexed operator, address stakedToken, uint256 stakedAmount, string rpcUrl, uint8 region)',
  'event PerformanceUpdated(bytes32 indexed nodeId, uint256 uptimeScore, uint256 requestsServed, uint256 avgResponseTime)',
  'event RewardsClaimed(bytes32 indexed nodeId, address indexed operator, address rewardToken, uint256 amount, uint256 paymasterFeesETH)',
  'event NodeSlashed(bytes32 indexed nodeId, address indexed operator, string reason)',
  'event ProposalCreated(bytes32 indexed proposalId, string parameter, uint256 currentValue, uint256 proposedValue, address proposer)',
  'event ProposalExecuted(bytes32 indexed proposalId, bool outcome)',
  'event ProposalVetoed(bytes32 indexed proposalId, address admin, string reason)',
  // V3 router
  'event NodeRegistered(bytes32 indexed nodeId, address indexed operator, address indexed stakedToken, address rewardToken, uint256 stakedAmount, uint256 stakedValueUSD)',
  'event NodeDeregistered(bytes32 indexed nodeId, address indexed operator)',
  // V3 registry
  'event NodeCreated(bytes32 indexed nodeId, address indexed operator, uint16 indexed version)',
  'event NodeStakeIncreased(bytes32 indexed nodeId, address indexed operator, uint256 amount, uint256 addedValueUSD)',
  'event NodeConfigUpdated(bytes32 indexed nodeId, address indexed operator, string rpcUrl, uint8 region)',
  'event NodeRewardsClaimed(bytes32 indexed nodeId, address indexed operator, uint256 rewardsUSD)',
  'event NodeDeactivated(bytes32 indexed nodeId, address indexed operator, uint256 unstakedAmount)',
  'event NodeUpgradeStarted(bytes32 indexed nodeId, uint16 indexed fromVersion, uint16 indexed targetVersion, bytes32 contextHash)',
  'event NodeMigrationStep(bytes32 indexed nodeId, uint16 indexed targetVersion, uint256 stepIndex)',
  'event NodeUpgradeCompleted(bytes32 indexed nodeId, uint16 indexed fromVersion, uint16 indexed targetVersion)',
  'event NodeMigrationPatched(bytes32 indexed nodeId, uint16 indexed targetVersion, bytes32 contextHash)',
])

const LEGACY_NODE_REGISTERED = keccak256(
  stringToHex('NodeRegistered(bytes32,address,address,uint256,string,uint8)'),
)
const ROUTER_NODE_REGISTERED = keccak256(
  stringToHex(
    'NodeRegistered(bytes32,address,address,address,uint256,uint256)',
  ),
)
const PERFORMANCE_UPDATED = keccak256(
  stringToHex('PerformanceUpdated(bytes32,uint256,uint256,uint256)'),
)
const REWARDS_CLAIMED = keccak256(
  stringToHex('RewardsClaimed(bytes32,address,address,uint256,uint256)'),
)
const NODE_SLASHED = keccak256(
  stringToHex('NodeSlashed(bytes32,address,string)'),
)
const NODE_DEREGISTERED = keccak256(
  stringToHex('NodeDeregistered(bytes32,address)'),
)
const NODE_CREATED = keccak256(
  stringToHex('NodeCreated(bytes32,address,uint16)'),
)
const NODE_STAKE_INCREASED = keccak256(
  stringToHex('NodeStakeIncreased(bytes32,address,uint256,uint256)'),
)
const NODE_CONFIG_UPDATED = keccak256(
  stringToHex('NodeConfigUpdated(bytes32,address,string,uint8)'),
)
const NODE_REWARDS_CLAIMED = keccak256(
  stringToHex('NodeRewardsClaimed(bytes32,address,uint256)'),
)
const NODE_DEACTIVATED = keccak256(
  stringToHex('NodeDeactivated(bytes32,address,uint256)'),
)
const PROPOSAL_CREATED = keccak256(
  stringToHex('ProposalCreated(bytes32,string,uint256,uint256,address)'),
)
const PROPOSAL_EXECUTED = keccak256(
  stringToHex('ProposalExecuted(bytes32,bool)'),
)
const PROPOSAL_VETOED = keccak256(
  stringToHex('ProposalVetoed(bytes32,address,string)'),
)

function buildStakingAddressSet(): Set<string> {
  const contracts = getNetworkConfig().contracts
  const candidates = [
    contracts.nodeStakingManager,
    contracts.nodeStakingManagerV2,
    contracts.nodeStakingLegacyManagerV1,
    contracts.nodeStakingRegistry,
    contracts.nodeStakingRouter,
    contracts.nodeStakingModuleV3,
    contracts.nodeStakingMigrationHandlerV3,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase())
  return new Set(candidates)
}

function createNodeStake(
  nodeId: string,
  timestamp: bigint,
  defaults: Partial<{
    operator: string
    stakedToken: string
    stakedAmount: bigint
    stakedValueUSD: bigint
    rewardToken: string
    rpcUrl: string
    geographicRegion: number
    isActive: boolean
    isSlashed: boolean
  }>,
): NodeStake {
  return new NodeStake({
    id: nodeId,
    nodeId,
    operator: defaults.operator ?? ZERO_ADDRESS,
    stakedToken: defaults.stakedToken ?? ZERO_ADDRESS,
    stakedAmount: defaults.stakedAmount ?? 0n,
    stakedValueUSD: defaults.stakedValueUSD ?? 0n,
    rewardToken: defaults.rewardToken ?? defaults.stakedToken ?? ZERO_ADDRESS,
    totalRewardsClaimed: 0n,
    lastClaimTime: timestamp,
    rpcUrl: defaults.rpcUrl ?? '',
    geographicRegion: defaults.geographicRegion ?? 0,
    registrationTime: timestamp,
    isActive: defaults.isActive ?? true,
    isSlashed: defaults.isSlashed ?? false,
  })
}

export async function processNodeStakingEvents(
  ctx: ProcessorContext<Store>,
): Promise<void> {
  const stakingAddresses = buildStakingAddressSet()
  const nodes = new Map<string, NodeStake>()
  const performanceUpdates: PerformanceUpdate[] = []
  const rewardClaims: RewardClaim[] = []
  const proposals = new Map<string, GovernanceProposal>()
  const proposalEvents: GovernanceEvent[] = []

  async function getOrLoadNode(nodeId: string): Promise<NodeStake | null> {
    const cached = nodes.get(nodeId)
    if (cached) return cached

    const existing = await ctx.store.get(NodeStake, nodeId)
    if (existing) {
      nodes.set(nodeId, existing)
      return existing
    }
    return null
  }

  for (const block of ctx.blocks) {
    const timestamp = BigInt(block.header.timestamp)

    for (const log of block.logs) {
      if (!log.transaction) continue
      if (!stakingAddresses.has(log.address.toLowerCase())) continue

      const eventSig = log.topics[0]
      const txHash = log.transaction.hash

      if (eventSig === LEGACY_NODE_REGISTERED) {
        const nodeId = log.topics[1]
        const args = decodeEventArgs<LegacyNodeRegisteredArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )

        nodes.set(
          nodeId,
          createNodeStake(nodeId, timestamp, {
            operator: args.operator,
            stakedToken: args.stakedToken,
            stakedAmount: BigInt(args.stakedAmount.toString()),
            stakedValueUSD: 0n,
            rewardToken: args.stakedToken,
            rpcUrl: args.rpcUrl,
            geographicRegion: args.region,
            isActive: true,
          }),
        )
      } else if (eventSig === ROUTER_NODE_REGISTERED) {
        const nodeId = log.topics[1]
        const args = decodeEventArgs<RouterNodeRegisteredArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )
        const node =
          (await getOrLoadNode(nodeId)) ??
          createNodeStake(nodeId, timestamp, { operator: args.operator })

        node.operator = args.operator
        node.stakedToken = args.stakedToken
        node.stakedAmount = BigInt(args.stakedAmount.toString())
        node.stakedValueUSD = BigInt(args.stakedValueUSD.toString())
        node.rewardToken = args.rewardToken
        node.registrationTime = timestamp
        node.isActive = true
        nodes.set(nodeId, node)
      } else if (eventSig === NODE_CREATED) {
        const nodeId = log.topics[1]
        const args = decodeEventArgs<NodeCreatedArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )
        const node =
          (await getOrLoadNode(nodeId)) ??
          createNodeStake(nodeId, timestamp, {
            operator: args.operator,
            isActive: true,
          })
        node.operator = args.operator
        node.isActive = true
        nodes.set(nodeId, node)
      } else if (eventSig === NODE_STAKE_INCREASED) {
        const nodeId = log.topics[1]
        const args = decodeEventArgs<NodeStakeIncreasedArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )
        const node =
          (await getOrLoadNode(nodeId)) ??
          createNodeStake(nodeId, timestamp, { operator: args.operator })
        node.operator = args.operator
        node.stakedAmount = node.stakedAmount + BigInt(args.amount.toString())
        node.stakedValueUSD =
          node.stakedValueUSD + BigInt(args.addedValueUSD.toString())
        nodes.set(nodeId, node)
      } else if (eventSig === NODE_CONFIG_UPDATED) {
        const nodeId = log.topics[1]
        const args = decodeEventArgs<NodeConfigUpdatedArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )
        const node =
          (await getOrLoadNode(nodeId)) ??
          createNodeStake(nodeId, timestamp, { operator: args.operator })
        node.operator = args.operator
        node.rpcUrl = args.rpcUrl
        node.geographicRegion = args.region
        nodes.set(nodeId, node)
      } else if (eventSig === NODE_REWARDS_CLAIMED) {
        const nodeId = log.topics[1]
        const args = decodeEventArgs<NodeRewardsClaimedArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )
        const node =
          (await getOrLoadNode(nodeId)) ??
          createNodeStake(nodeId, timestamp, { operator: args.operator })
        const amount = BigInt(args.rewardsUSD.toString())
        node.operator = args.operator
        node.totalRewardsClaimed = node.totalRewardsClaimed + amount
        node.lastClaimTime = timestamp
        nodes.set(nodeId, node)

        rewardClaims.push(
          new RewardClaim({
            id: `${txHash}-${log.logIndex}`,
            node,
            operator: args.operator,
            rewardToken: node.rewardToken,
            rewardAmount: amount,
            paymasterFeesETH: 0n,
            timestamp,
            blockNumber: BigInt(block.header.height),
            transactionHash: txHash,
          }),
        )
      } else if (
        eventSig === NODE_DEACTIVATED ||
        eventSig === NODE_DEREGISTERED
      ) {
        const nodeId = log.topics[1]
        const operator =
          eventSig === NODE_DEACTIVATED
            ? decodeEventArgs<NodeDeactivatedArgs>(
                stakingEventInterface,
                log.data,
                log.topics,
              ).operator
            : decodeEventArgs<NodeDeregisteredArgs>(
                stakingEventInterface,
                log.data,
                log.topics,
              ).operator

        const node =
          (await getOrLoadNode(nodeId)) ??
          createNodeStake(nodeId, timestamp, { operator })
        node.operator = operator
        node.isActive = false
        node.stakedAmount = 0n
        node.stakedValueUSD = 0n
        nodes.set(nodeId, node)
      } else if (eventSig === PERFORMANCE_UPDATED) {
        const nodeId = log.topics[1]
        const args = decodeEventArgs<PerformanceUpdatedArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )

        const node = await getOrLoadNode(nodeId)
        if (node) {
          node.currentUptimeScore = BigInt(args.uptimeScore.toString())
          node.currentRequestsServed = BigInt(args.requestsServed.toString())
          node.currentAvgResponseTime = BigInt(args.avgResponseTime.toString())
          nodes.set(nodeId, node)

          performanceUpdates.push(
            new PerformanceUpdate({
              id: `${txHash}-${log.logIndex}`,
              node,
              uptimeScore: BigInt(args.uptimeScore.toString()),
              requestsServed: BigInt(args.requestsServed.toString()),
              avgResponseTime: BigInt(args.avgResponseTime.toString()),
              timestamp,
              blockNumber: BigInt(block.header.height),
              transactionHash: txHash,
            }),
          )
        }
      } else if (eventSig === REWARDS_CLAIMED) {
        const nodeId = log.topics[1]
        const args = decodeEventArgs<RewardsClaimedArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )
        const node =
          (await getOrLoadNode(nodeId)) ??
          createNodeStake(nodeId, timestamp, { operator: args.operator })
        const amount = BigInt(args.amount.toString())
        node.operator = args.operator
        node.totalRewardsClaimed = node.totalRewardsClaimed + amount
        node.lastClaimTime = timestamp
        nodes.set(nodeId, node)

        rewardClaims.push(
          new RewardClaim({
            id: `${txHash}-${log.logIndex}`,
            node,
            operator: args.operator,
            rewardToken: args.rewardToken,
            rewardAmount: amount,
            paymasterFeesETH: BigInt(args.paymasterFeesETH.toString()),
            timestamp,
            blockNumber: BigInt(block.header.height),
            transactionHash: txHash,
          }),
        )
      } else if (eventSig === NODE_SLASHED) {
        const args = decodeEventArgs<NodeSlashedArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )
        const node = await getOrLoadNode(args.nodeId)
        if (node) {
          node.isSlashed = true
          node.isActive = false
          nodes.set(args.nodeId, node)
        }
      } else if (eventSig === PROPOSAL_CREATED) {
        const proposalId = log.topics[1]
        const args = decodeEventArgs<ProposalCreatedArgs>(
          stakingEventInterface,
          log.data,
          log.topics,
        )

        const proposal = new GovernanceProposal({
          id: proposalId,
          proposalId: Buffer.from(proposalId.slice(2), 'hex'),
          parameter: args.parameter,
          currentValue: BigInt(args.currentValue.toString()),
          proposedValue: BigInt(args.proposedValue.toString()),
          changeMarketId: EMPTY_BYTES32,
          statusQuoMarketId: EMPTY_BYTES32,
          createdAt: timestamp,
          votingEnds: BigInt(block.header.timestamp + 7 * 24 * 3600),
          executeAfter: BigInt(block.header.timestamp + 14 * 24 * 3600),
          executed: false,
          vetoed: false,
          proposer: args.proposer,
        })
        proposals.set(proposalId, proposal)

        proposalEvents.push(
          new GovernanceEvent({
            id: `${txHash}-${log.logIndex}`,
            proposal,
            eventType: 'created',
            actor: args.proposer,
            reason: null,
            timestamp,
            blockNumber: BigInt(block.header.height),
            transactionHash: txHash,
          }),
        )
      } else if (eventSig === PROPOSAL_EXECUTED) {
        const proposalId = log.topics[1]
        const proposal = proposals.get(proposalId)
        if (proposal) {
          decodeEventArgs<ProposalExecutedArgs>(
            stakingEventInterface,
            log.data,
            log.topics,
          )

          proposal.executed = true
          proposalEvents.push(
            new GovernanceEvent({
              id: `${txHash}-${log.logIndex}`,
              proposal,
              eventType: 'executed',
              actor: null,
              reason: null,
              timestamp,
              blockNumber: BigInt(block.header.height),
              transactionHash: txHash,
            }),
          )
        }
      } else if (eventSig === PROPOSAL_VETOED) {
        const proposalId = log.topics[1]
        const proposal = proposals.get(proposalId)
        if (proposal) {
          const args = decodeEventArgs<ProposalVetoedArgs>(
            stakingEventInterface,
            log.data,
            log.topics,
          )

          proposal.vetoed = true
          proposalEvents.push(
            new GovernanceEvent({
              id: `${txHash}-${log.logIndex}`,
              proposal,
              eventType: 'vetoed',
              actor: args.admin,
              reason: args.reason,
              timestamp,
              blockNumber: BigInt(block.header.height),
              transactionHash: txHash,
            }),
          )
        }
      }
    }
  }

  if (nodes.size > 0) await ctx.store.upsert([...nodes.values()])
  if (performanceUpdates.length > 0) await ctx.store.insert(performanceUpdates)
  if (rewardClaims.length > 0) await ctx.store.insert(rewardClaims)
  if (proposals.size > 0) await ctx.store.upsert([...proposals.values()])
  if (proposalEvents.length > 0) await ctx.store.insert(proposalEvents)
}
