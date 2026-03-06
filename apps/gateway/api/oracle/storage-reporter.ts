import {
  getChainId,
  getContract,
  getCurrentNetwork,
  getRpcUrl,
  type NetworkType,
  tryGetContract,
} from '@jejunetwork/config'
import { createMigrationWalletClient } from '@jejunetwork/kms'
import {
  QOS_ATTESTATION_PATH,
  type QoSAttestationProof,
  QoSAttestationProofSchema,
  QoSAttestationRequestSchema,
  buildQoSAttestationMessage,
  normalizeAttestationOrigin,
} from '@jejunetwork/shared'
import { createHash, randomBytes } from 'node:crypto'
import { NODE_STAKING_MANAGER_ABI } from '../../lib/nodeStaking'
import {
  verifyStorageAuditChunks,
  type StorageAuditChunk,
  type StorageAuditCommitment,
} from './storage-audit-verifier'
import { QOS_VALIDATOR_SERVICE_PROFILES } from './qos-validator-types'
import { isAddress, type Address, type Chain, type Hex, verifyMessage } from 'viem'
import { base, baseSepolia, foundry } from 'viem/chains'

export interface StorageReporterConfig {
  network: NetworkType
  chainId: number
  rpcUrl: string
  serviceId: string
  fallbackPrivateKey?: Hex
  pollIntervalMs: number
  requestTimeoutMs: number
  lookbackHours: number
  maxCommitmentsPerNode: number
  challengeChunkCount: number
  slashEventLookbackBlocks: number
  publishIdentityMetadata: boolean
  metadataKey: string
  metadataPublishIntervalSec: number
  metadataProposalDurationSec: number
  metadataConsensusAddress: Address | null
  submitOnChain: boolean
  registerAsQoSValidator: boolean
  enableAutoSlashing: boolean
  checkSlashing: boolean
  executeSlashing: boolean
  runOnce: boolean
  endpointOverrides: Map<string, string>
  allowedNodeIds: Set<Hex> | null
  attestationEnabled: boolean
  attestationPath: string
  attestationChallengeWindowMs: number
  attestationAllowedSkewMs: number
  attestationSlashBps: number
  attestationSlashPassRateThresholdBps: number
  attestationSlashConsecutiveFailureThreshold: number
  attestationSlashProposalCooldownSec: number
  attestationMetadataKey: string
  attestationMetadataPublishIntervalSec: number
}

interface NodeInfoResponse {
  node: {
    nodeId: Hex
    operator: Address
    rpcUrl: string
    geographicRegion: number
    operatorAgentId: bigint
    isActive: boolean
    isSlashed: boolean
  }
  perf: {
    uptimeScore: bigint
    requestsServed: bigint
    avgResponseTime: bigint
    lastUpdateTime: bigint
  }
}

interface SlashProposal {
  nodeId: Hex
  slashPercentageBPS: bigint
  reason: string
  proposedAt: bigint
  executesAt: bigint
  executed: boolean
  appealed: boolean
}

interface PendingSlash {
  nodeId: Hex
  slashPercentageBPS: bigint
  reason: string
  proposedAt: bigint
  executeAfter: bigint
  executed: boolean
  disputed: boolean
}

interface StorageActivitySummary {
  owner: string | null
  since: number
  sinceHours: number
  totalOperations: number
  paidOperations: number
  totalBytes: number
  paidBytes: number
  uploads: number
  downloads: number
  permanentUploads: number
  totalAmountWei: string
}

interface StorageAuditListItem {
  cid: string
  owner: string | null
  tier: string | null
  category: string | null
  backend: string | null
  sizeBytes: number
  createdAt: number
  updatedAt: number
  audit: StorageAuditCommitment
}

interface StorageAuditListResponse {
  items: StorageAuditListItem[]
  limit: number
  offset: number
}

interface StorageAuditChallengeResponse {
  cid: string
  issuedAt: number
  expiresAt: number
  sampleCount: number
  chunkIndices: number[]
  audit: StorageAuditCommitment
}

interface StorageAuditProofResponse {
  cid: string
  backend: string
  latencyMs: number
  chunkSize: number
  chunkCount: number
  chunks: Array<{
    index: number
    data: string
    proof: StorageAuditChunk['proof']
  }>
  audit: StorageAuditCommitment
}

interface NodeAuditMetrics {
  uptimeScore: number
  requestsServed: number
  avgResponseTime: number
  summary: StorageActivitySummary
  healthLatencyMs: number
  auditAttempts: number
  auditFailures: number
  challengedChunks: number
  verifiedChunks: number
  averageProofLatencyMs: number
  auditedCids: string[]
  invalidCids: string[]
  baseUrl: string
  attestationPassRate1hBps?: number
  attestationPassRate24hBps?: number
  attestationConsecutiveFailures?: number
  attestationReason?: string | null
  attestationEvidenceHash?: Hex | null
  attestationChecked?: boolean
  attestationVerified?: boolean
  effectiveUptimeBps?: number
}

interface NodeMetricSample {
  timestamp: number
  uptimeScore: number
  requestsServed: number
  avgResponseTime: number
}

interface NodeHistoryState {
  samples: NodeMetricSample[]
  currentDayBucket: number
  currentDayUptimeSum: number
  currentDaySampleCount: number
  lifetimeDayUptimeSum: number
  lifetimeDaysObserved: number
}

interface NodeMetadataSummary {
  nodeId: Hex
  updatedAt: number
  latest: {
    uptimeBps: number
    requestsServed: number
    avgResponseMs: number
  }
  avg1h: {
    uptimeBps: number
    requestsServed: number
    avgResponseMs: number
  }
  avg24h: {
    uptimeBps: number
    requestsServed: number
    avgResponseMs: number
  }
  lifetime: {
    daysObserved: number
    uptimeBps: number
  }
}

interface NodeAttestationSample {
  timestamp: number
  passed: boolean
}

interface NodeAttestationState {
  samples: NodeAttestationSample[]
  currentDayBucket: number
  currentDayPassCount: number
  currentDaySampleCount: number
  lifetimeDayPassRateSum: number
  lifetimeDaysObserved: number
  consecutiveFailures: number
}

interface NodeAttestationSnapshot {
  nodeId: Hex
  checked: boolean
  verified: boolean
  passRate1hBps: number
  passRate24hBps: number
  consecutiveFailures: number
  lifetimeDaysObserved: number
  lifetimePassRateBps: number
  reason: string | null
  expectedSigner: Address | null
  signer: Address | null
  evidenceHash: Hex | null
  endpointOrigin: string | null
}

interface NodeAttestationMetadataSummary {
  nodeId: Hex
  updatedAt: number
  latest: {
    verified: boolean
    checked: boolean
    passRateBps: number
    consecutiveFailures: number
    reason: string | null
    expectedSigner: Address | null
    signer: Address | null
    evidenceHash: Hex | null
    endpointOrigin: string | null
  }
  avg1h: {
    passRateBps: number
  }
  avg24h: {
    passRateBps: number
  }
  lifetimeDays: number
  lifetimePassRateBps: number
}

interface NodeReportResult {
  nodeId: Hex
  operator: Address
  rpcUrl: string
  skipped?: string
  metrics?: NodeAuditMetrics
  onChainSubmitted: boolean
  onChainHash?: Hex
  slashingChecked: boolean
  slashingProposed: boolean
  slashExecuted: boolean
  attestation?: {
    checked: boolean
    verified: boolean
    passRate1hBps: number
    passRate24hBps: number
    consecutiveFailures: number
    reason: string | null
    evidenceHash: Hex | null
  }
  errors: string[]
}

const AUTO_SLASHER_ABI = [
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'autoSlashingEnabled',
    inputs: [],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'setAutoSlashingEnabled',
    inputs: [{ name: 'enabled', type: 'bool' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'checkAndProposeSlashing',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'executeSlashing',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'slashProposals',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
    outputs: [
      { name: 'nodeId', type: 'bytes32' },
      { name: 'slashPercentageBPS', type: 'uint256' },
      { name: 'reason', type: 'string' },
      { name: 'proposedAt', type: 'uint256' },
      { name: 'executesAt', type: 'uint256' },
      { name: 'executed', type: 'bool' },
      { name: 'appealed', type: 'bool' },
    ],
    stateMutability: 'view',
  },
] as const

const QOS_VALIDATOR_REGISTRATION_ABI = [
  {
    type: 'function',
    name: 'isPerformanceOracle',
    inputs: [{ name: 'validator', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'addPerformanceOracle',
    inputs: [{ name: 'validator', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

const QOS_METADATA_CONSENSUS_ABI = [
  {
    type: 'function',
    name: 'proposeOrApproveMetadataUpdate',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'keys', type: 'string[]' },
      { name: 'values', type: 'bytes[]' },
      { name: 'durationSeconds', type: 'uint256' },
    ],
    outputs: [
      { name: 'proposalId', type: 'bytes32' },
      { name: 'created', type: 'bool' },
      { name: 'executedNow', type: 'bool' },
    ],
    stateMutability: 'nonpayable',
  },
] as const

const IDENTITY_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getAgentWallet',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: 'wallet', type: 'address' }],
    stateMutability: 'view',
  },
] as const

function getChain(chainId: number): Chain {
  if (chainId === foundry.id) return foundry
  if (chainId === baseSepolia.id) return baseSepolia
  if (chainId === base.id) return base

  return {
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [getRpcUrl()] },
      public: { http: [getRpcUrl()] },
    },
  }
}

function getEnvBool(name: string, fallback = false): boolean {
  const value = process.env[name]
  if (!value) return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

function getEnvInt(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseEndpointOverrides(raw?: string): Map<string, string> {
  const overrides = new Map<string, string>()
  if (!raw) return overrides

  for (const entry of raw.split(/[;\n]/)) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const separator = trimmed.includes('=') ? '=' : ':'
    const index = trimmed.indexOf(separator)
    if (index === -1) continue
    const key = trimmed.slice(0, index).trim().toLowerCase()
    const value = trimmed.slice(index + 1).trim()
    if (!key || !value) continue
    overrides.set(key, value)
  }

  return overrides
}

function parseAllowedNodeIds(raw?: string): Set<Hex> | null {
  if (!raw) return null
  const ids = raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean) as Hex[]
  return ids.length > 0 ? new Set(ids) : null
}

function parseOptionalAddress(raw?: string): Address | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null
  return trimmed as Address
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const value = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`

  try {
    const url = new URL(value)
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function joinUrl(base: string, path: string): string {
  const url = new URL(base.endsWith('/') ? base : `${base}/`)
  const [pathname, search = ''] = path.split('?', 2)
  const basePath = url.pathname.replace(/\/+$/, '')
  const nextPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  url.pathname = `${basePath}${nextPath}`.replace(/\/{2,}/g, '/')
  url.search = search
  url.hash = ''
  return url.toString()
}

function buildBaseCandidates(
  nodeId: Hex,
  rpcUrl: string,
  overrides: Map<string, string>,
): string[] {
  const candidates: string[] = []
  const exactOverride = overrides.get(nodeId.toLowerCase()) ?? overrides.get(rpcUrl.toLowerCase())
  if (exactOverride) {
    const normalized = normalizeBaseUrl(exactOverride)
    if (normalized) candidates.push(normalized)
  }

  const normalized = normalizeBaseUrl(rpcUrl)
  if (!normalized) return candidates

  candidates.push(normalized)

  try {
    const parsed = new URL(normalized)
    const origin = parsed.origin
    if (origin !== normalized) candidates.push(origin)
  } catch {
    // Ignore malformed fallback parsing.
  }

  return [...new Set(candidates)]
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function calculatePassRateBps(samples: NodeAttestationSample[]): number {
  if (samples.length === 0) return 0
  const passCount = samples.reduce(
    (sum, sample) => sum + (sample.passed ? 1 : 0),
    0,
  )
  return Math.max(0, Math.min(10_000, Math.round((passCount * 10_000) / samples.length)))
}

function buildEvidenceHash(parts: string[]): Hex {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex')
  return `0x${digest}` as Hex
}

function sampleItems<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items
  const pool = [...items]
  const sampled: T[] = []

  while (sampled.length < count && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length)
    const [item] = pool.splice(index, 1)
    if (item !== undefined) sampled.push(item)
  }

  return sampled
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }

  return (await response.json()) as T
}

function resolveNodeStakingAddress(network: NetworkType): Address {
  const override =
    process.env.QOS_VALIDATOR_NODE_STAKING_MANAGER_ADDRESS ??
    process.env.QOS_VALIDATOR_NODE_STAKING_MANAGER
  if (override !== undefined && override.length > 0) {
    if (!isAddress(override)) {
      throw new Error(
        `Invalid QOS_VALIDATOR_NODE_STAKING_MANAGER_ADDRESS: ${override}`,
      )
    }
    return override as Address
  }

  const managerV2 = tryGetContract('nodeStaking', 'managerV2', network)
  if (managerV2) return managerV2 as Address

  return getContract('nodeStaking', 'manager', network) as Address
}

export function loadStorageReporterConfig(): StorageReporterConfig {
  const network = (process.env.JEJU_NETWORK as NetworkType | undefined) ?? getCurrentNetwork()
  const chainId = getChainId(network)
  const profile = QOS_VALIDATOR_SERVICE_PROFILES.storage

  return {
    network,
    chainId,
    rpcUrl:
      process.env.QOS_VALIDATOR_RPC_URL ??
      process.env.STORAGE_REPORTER_RPC_URL ??
      getRpcUrl(network),
    serviceId:
      process.env.QOS_VALIDATOR_SERVICE_ID ??
      process.env.STORAGE_REPORTER_SERVICE_ID ??
      profile.serviceId,
    fallbackPrivateKey: (
      process.env.QOS_VALIDATOR_PRIVATE_KEY ??
      process.env.STORAGE_REPORTER_PRIVATE_KEY ??
      process.env.ORACLE_PRIVATE_KEY ??
      process.env.PRIVATE_KEY
    ) as Hex | undefined,
    pollIntervalMs: getEnvInt(
      'QOS_VALIDATOR_POLL_INTERVAL_MS',
      getEnvInt('STORAGE_REPORTER_POLL_INTERVAL_MS', 15 * 60 * 1000),
    ),
    requestTimeoutMs: getEnvInt(
      'QOS_VALIDATOR_REQUEST_TIMEOUT_MS',
      getEnvInt('STORAGE_REPORTER_REQUEST_TIMEOUT_MS', 15_000),
    ),
    lookbackHours: getEnvInt(
      'QOS_VALIDATOR_LOOKBACK_HOURS',
      getEnvInt('STORAGE_REPORTER_LOOKBACK_HOURS', 24 * 30),
    ),
    maxCommitmentsPerNode: Math.max(
      1,
      getEnvInt(
        'QOS_VALIDATOR_MAX_COMMITMENTS',
        getEnvInt('STORAGE_REPORTER_MAX_COMMITMENTS', 5),
      ),
    ),
    challengeChunkCount: Math.max(
      1,
      Math.min(
        16,
        getEnvInt(
          'QOS_VALIDATOR_CHUNK_COUNT',
          getEnvInt('STORAGE_REPORTER_CHUNK_COUNT', 3),
        ),
      ),
    ),
    slashEventLookbackBlocks: Math.max(
      0,
      getEnvInt(
        'QOS_VALIDATOR_SLASH_EVENT_LOOKBACK_BLOCKS',
        getEnvInt('STORAGE_REPORTER_SLASH_EVENT_LOOKBACK_BLOCKS', 100_000),
      ),
    ),
    publishIdentityMetadata: getEnvBool(
      'QOS_VALIDATOR_PUBLISH_IDENTITY_METADATA',
      getEnvBool('STORAGE_REPORTER_PUBLISH_IDENTITY_METADATA'),
    ),
    metadataKey:
      process.env.QOS_VALIDATOR_METADATA_KEY ??
      process.env.STORAGE_REPORTER_METADATA_KEY ??
      'qos.storage.summary.v1',
    metadataPublishIntervalSec: Math.max(
      60,
      getEnvInt(
        'QOS_VALIDATOR_METADATA_PUBLISH_INTERVAL_SEC',
        getEnvInt('STORAGE_REPORTER_METADATA_PUBLISH_INTERVAL_SEC', 3600),
      ),
    ),
    metadataProposalDurationSec: Math.max(
      60,
      getEnvInt(
        'QOS_VALIDATOR_METADATA_PROPOSAL_DURATION_SEC',
        getEnvInt('STORAGE_REPORTER_METADATA_PROPOSAL_DURATION_SEC', 3600),
      ),
    ),
    metadataConsensusAddress: parseOptionalAddress(
      process.env.QOS_VALIDATOR_METADATA_CONSENSUS_ADDRESS ??
        process.env.STORAGE_REPORTER_METADATA_CONSENSUS_ADDRESS,
    ),
    submitOnChain: getEnvBool(
      'QOS_VALIDATOR_SUBMIT_ON_CHAIN',
      getEnvBool('STORAGE_REPORTER_SUBMIT_ON_CHAIN'),
    ),
    registerAsQoSValidator: getEnvBool(
      'QOS_VALIDATOR_REGISTER_AS_QOS_VALIDATOR',
      getEnvBool(
        'QOS_VALIDATOR_REGISTER_AS_PERFORMANCE_ORACLE',
        getEnvBool('STORAGE_REPORTER_REGISTER_AS_PERFORMANCE_ORACLE'),
      ),
    ),
    enableAutoSlashing: getEnvBool(
      'QOS_VALIDATOR_ENABLE_AUTO_SLASHING',
      getEnvBool('STORAGE_REPORTER_ENABLE_AUTO_SLASHING'),
    ),
    checkSlashing: getEnvBool(
      'QOS_VALIDATOR_CHECK_SLASHING',
      getEnvBool('STORAGE_REPORTER_CHECK_SLASHING'),
    ),
    executeSlashing: getEnvBool(
      'QOS_VALIDATOR_EXECUTE_SLASHING',
      getEnvBool('STORAGE_REPORTER_EXECUTE_SLASHING'),
    ),
    runOnce: getEnvBool(
      'QOS_VALIDATOR_RUN_ONCE',
      getEnvBool('STORAGE_REPORTER_RUN_ONCE'),
    ),
    endpointOverrides: parseEndpointOverrides(
      process.env.QOS_VALIDATOR_ENDPOINT_OVERRIDES ??
        process.env.STORAGE_REPORTER_ENDPOINT_OVERRIDES,
    ),
    allowedNodeIds: parseAllowedNodeIds(
      process.env.QOS_VALIDATOR_NODE_IDS ??
        process.env.STORAGE_REPORTER_NODE_IDS,
    ),
    attestationEnabled: getEnvBool(
      'QOS_VALIDATOR_ATTESTATION_ENABLED',
      getEnvBool('STORAGE_REPORTER_ATTESTATION_ENABLED', true),
    ),
    attestationPath:
      process.env.QOS_VALIDATOR_ATTESTATION_PATH ??
      process.env.STORAGE_REPORTER_ATTESTATION_PATH ??
      QOS_ATTESTATION_PATH,
    attestationChallengeWindowMs: Math.max(
      10_000,
      getEnvInt(
        'QOS_VALIDATOR_ATTESTATION_CHALLENGE_WINDOW_MS',
        getEnvInt('STORAGE_REPORTER_ATTESTATION_CHALLENGE_WINDOW_MS', 90_000),
      ),
    ),
    attestationAllowedSkewMs: Math.max(
      0,
      getEnvInt(
        'QOS_VALIDATOR_ATTESTATION_ALLOWED_SKEW_MS',
        getEnvInt('STORAGE_REPORTER_ATTESTATION_ALLOWED_SKEW_MS', 30_000),
      ),
    ),
    attestationSlashBps: Math.max(
      1,
      Math.min(
        10_000,
        getEnvInt(
          'QOS_VALIDATOR_ATTESTATION_SLASH_BPS',
          getEnvInt('STORAGE_REPORTER_ATTESTATION_SLASH_BPS', 1000),
        ),
      ),
    ),
    attestationSlashPassRateThresholdBps: Math.max(
      0,
      Math.min(
        10_000,
        getEnvInt(
          'QOS_VALIDATOR_ATTESTATION_SLASH_PASS_RATE_BPS',
          getEnvInt('STORAGE_REPORTER_ATTESTATION_SLASH_PASS_RATE_BPS', 7000),
        ),
      ),
    ),
    attestationSlashConsecutiveFailureThreshold: Math.max(
      1,
      getEnvInt(
        'QOS_VALIDATOR_ATTESTATION_SLASH_CONSECUTIVE_FAILURES',
        getEnvInt('STORAGE_REPORTER_ATTESTATION_SLASH_CONSECUTIVE_FAILURES', 8),
      ),
    ),
    attestationSlashProposalCooldownSec: Math.max(
      60,
      getEnvInt(
        'QOS_VALIDATOR_ATTESTATION_SLASH_PROPOSAL_COOLDOWN_SEC',
        getEnvInt(
          'STORAGE_REPORTER_ATTESTATION_SLASH_PROPOSAL_COOLDOWN_SEC',
          6 * 3600,
        ),
      ),
    ),
    attestationMetadataKey:
      process.env.QOS_VALIDATOR_ATTESTATION_METADATA_KEY ??
      process.env.STORAGE_REPORTER_ATTESTATION_METADATA_KEY ??
      'qos.storage.attestation.v1',
    attestationMetadataPublishIntervalSec: Math.max(
      60,
      getEnvInt(
        'QOS_VALIDATOR_ATTESTATION_METADATA_PUBLISH_INTERVAL_SEC',
        getEnvInt(
          'STORAGE_REPORTER_ATTESTATION_METADATA_PUBLISH_INTERVAL_SEC',
          3600,
        ),
      ),
    ),
  }
}

export class StorageReporter {
  private readonly config: StorageReporterConfig
  private readonly chain: Chain
  private readonly nodeStakingAddress: Address
  private readonly autoSlasherAddress: Address | null
  private readonly identityRegistryAddress: Address | null
  private readonly qosMetadataConsensusAddress: Address | null
  private contractClient: Awaited<
    ReturnType<typeof createMigrationWalletClient>
  > | null = null
  private readonly pendingSlashIdsByNode = new Map<Hex, Set<Hex>>()
  private readonly slashScanCursorByNode = new Map<Hex, bigint>()
  private readonly slashEventQueryChunkSize = 10_000n
  private readonly nodeHistoryById = new Map<Hex, NodeHistoryState>()
  private readonly nodeAttestationById = new Map<Hex, NodeAttestationState>()
  private readonly lastMetadataPublishAtByNode = new Map<Hex, number>()
  private readonly lastAttestationMetadataPublishAtByNode = new Map<Hex, number>()
  private readonly lastAttestationSlashProposalAtByNode = new Map<Hex, number>()
  private running = false
  private timer?: ReturnType<typeof setInterval>

  constructor(config: StorageReporterConfig) {
    this.config = config
    this.chain = getChain(config.chainId)
    this.nodeStakingAddress = resolveNodeStakingAddress(config.network)
    const autoSlasher = tryGetContract('nodeStaking', 'autoSlasher', config.network)
    this.autoSlasherAddress = autoSlasher ? (autoSlasher as Address) : null
    const identityRegistry = tryGetContract('registry', 'identity', config.network)
    this.identityRegistryAddress = identityRegistry
      ? (identityRegistry as Address)
      : null
    const metadataConsensus =
      config.metadataConsensusAddress ??
      (tryGetContract(
        'nodeStaking',
        'qosMetadataReporterConsensus',
        config.network,
      ) as Address | null)
    this.qosMetadataConsensusAddress = metadataConsensus ?? null
  }

  private async getContractClient() {
    if (this.contractClient) return this.contractClient
    const client = await createMigrationWalletClient({
      serviceId: this.config.serviceId,
      chain: this.chain,
      rpcUrl: this.config.rpcUrl,
      fallbackPrivateKey: this.config.fallbackPrivateKey,
    })
    this.contractClient = client
    return client
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    console.log(
      `[QoSV:storage] Starting on ${this.config.network} (${this.config.chainId})`,
    )

    await this.runCycle()

    if (this.config.runOnce) {
      await this.stop()
      return
    }

    this.timer = setInterval(() => {
      void this.runCycle().catch((error) => {
        console.error('[QoSV:storage] Cycle failed:', error)
      })
    }, this.config.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    console.log('[QoSV:storage] Stopped')
  }

  async runCycle(): Promise<NodeReportResult[]> {
    const contractClient = await this.getContractClient()

    if (this.config.registerAsQoSValidator) {
      try {
        await this.ensureQoSValidatorRegistration(contractClient)
      } catch (error) {
        console.warn(
          '[QoSV:storage] Could not register QoS Validator:',
          error,
        )
      }
    }
    if (this.config.enableAutoSlashing) {
      try {
        await this.ensureAutoSlashingEnabled(contractClient)
      } catch (error) {
        console.warn(
          '[QoSV:storage] Could not enable auto slashing:',
          error,
        )
      }
    }

    const nodeIds = (await contractClient.publicClient.readContract({
      address: this.nodeStakingAddress,
      abi: NODE_STAKING_MANAGER_ABI,
      functionName: 'getAllNodes',
    })) as Hex[]

    const results: NodeReportResult[] = []

    for (const nodeId of nodeIds) {
      if (this.config.allowedNodeIds && !this.config.allowedNodeIds.has(nodeId)) {
        results.push({
          nodeId,
          operator: '0x0000000000000000000000000000000000000000',
          rpcUrl: '',
          skipped: 'not in QOS_VALIDATOR_NODE_IDS allowlist',
          onChainSubmitted: false,
          slashingChecked: false,
          slashingProposed: false,
          slashExecuted: false,
          errors: [],
        })
        continue
      }

      results.push(await this.reportNode(contractClient, nodeId))
    }

    console.log(
      '[QoSV:storage] Cycle complete:',
      JSON.stringify(
        results.map((result) => ({
          nodeId: result.nodeId,
          rpcUrl: result.rpcUrl,
          skipped: result.skipped,
          uptimeScore: result.metrics?.uptimeScore,
          requestsServed: result.metrics?.requestsServed,
          avgResponseTime: result.metrics?.avgResponseTime,
          attestationChecked: result.attestation?.checked,
          attestationVerified: result.attestation?.verified,
          attestationPassRate24hBps: result.attestation?.passRate24hBps,
          attestationConsecutiveFailures:
            result.attestation?.consecutiveFailures,
          onChainSubmitted: result.onChainSubmitted,
          slashingChecked: result.slashingChecked,
          slashExecuted: result.slashExecuted,
          errors: result.errors,
        })),
        null,
        2,
      ),
    )

    return results
  }

  private async reportNode(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
  ): Promise<NodeReportResult> {
    const result: NodeReportResult = {
      nodeId,
      operator: '0x0000000000000000000000000000000000000000',
      rpcUrl: '',
      onChainSubmitted: false,
      slashingChecked: false,
      slashingProposed: false,
      slashExecuted: false,
      errors: [],
    }

    try {
      const nodeInfo = (await contractClient.publicClient.readContract({
        address: this.nodeStakingAddress,
        abi: NODE_STAKING_MANAGER_ABI,
        functionName: 'getNodeInfo',
        args: [nodeId],
      })) as unknown as [
        NodeInfoResponse['node'],
        NodeInfoResponse['perf'],
        bigint,
      ]
      const [node] = nodeInfo

      result.operator = node.operator
      result.rpcUrl = node.rpcUrl

      if (!node.isActive) {
        result.skipped = 'node inactive'
        return result
      }
      if (node.isSlashed) {
        result.skipped = 'node already slashed'
        return result
      }

      const collectedMetrics = await this.collectNodeMetrics(
        nodeId,
        node.operator,
        node.rpcUrl,
      )
      const attestation = await this.verifyNodeAttestation(
        contractClient,
        nodeId,
        node,
        collectedMetrics.baseUrl,
      )
      const metrics = this.applyAttestationToMetrics(
        collectedMetrics,
        attestation,
      )
      result.metrics = metrics
      result.attestation = {
        checked: attestation.checked,
        verified: attestation.verified,
        passRate1hBps: attestation.passRate1hBps,
        passRate24hBps: attestation.passRate24hBps,
        consecutiveFailures: attestation.consecutiveFailures,
        reason: attestation.reason,
        evidenceHash: attestation.evidenceHash,
      }

      if (this.config.publishIdentityMetadata && this.qosMetadataConsensusAddress) {
        try {
          await this.publishNodeQoSMetadata(contractClient, nodeId, node, metrics)
          await this.publishNodeAttestationMetadata(
            contractClient,
            nodeId,
            node,
            attestation,
          )
        } catch (error) {
          console.warn('[QoSV:storage] Could not publish node metadata:', error)
        }
      }

      if (this.config.submitOnChain) {
        const txHash = await contractClient.client.writeContract({
          address: this.nodeStakingAddress,
          abi: NODE_STAKING_MANAGER_ABI,
          functionName: 'updatePerformance',
          args: [
            nodeId,
            BigInt(metrics.uptimeScore),
            BigInt(metrics.requestsServed),
            BigInt(metrics.avgResponseTime),
          ],
          chain: this.chain,
          account: contractClient.account,
        })
        await contractClient.publicClient.waitForTransactionReceipt({ hash: txHash })
        result.onChainSubmitted = true
        result.onChainHash = txHash

        if (this.config.checkSlashing) {
          const attestationSlashProposed =
            await this.maybeProposeAttestationSlash(
              contractClient,
              nodeId,
              attestation,
            )
          const slashing = await this.handleSlashing(contractClient, nodeId)
          result.slashingChecked = slashing.checked
          result.slashingProposed = slashing.proposed || attestationSlashProposed
          result.slashExecuted = slashing.executed
        }
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }

    return result
  }

  private async collectNodeMetrics(
    nodeId: Hex,
    operator: Address,
    rpcUrl: string,
  ): Promise<NodeAuditMetrics> {
    const candidates = buildBaseCandidates(
      nodeId,
      rpcUrl,
      this.config.endpointOverrides,
    )

    if (candidates.length === 0) {
      throw new Error(`No valid endpoint candidates for ${rpcUrl}`)
    }

    let baseUrl: string | null = null
    let healthLatencyMs = 0

    for (const candidate of candidates) {
      const startedAt = Date.now()
      try {
        await fetchJson(joinUrl(candidate, '/storage/health'), this.config.requestTimeoutMs)
        baseUrl = candidate
        healthLatencyMs = Date.now() - startedAt
        break
      } catch {
        // Try the next endpoint candidate.
      }
    }

    if (!baseUrl) {
      throw new Error(`Storage health check failed for ${rpcUrl}`)
    }

    const summary = await fetchJson<StorageActivitySummary>(
      joinUrl(
        baseUrl,
        `/storage/activity/summary?owner=${operator}&sinceHours=${this.config.lookbackHours}`,
      ),
      this.config.requestTimeoutMs,
    )

    const auditList = await fetchJson<StorageAuditListResponse>(
      joinUrl(
        baseUrl,
        `/storage/audit?owner=${operator}&limit=${this.config.maxCommitmentsPerNode}&offset=0`,
      ),
      this.config.requestTimeoutMs,
    )

    const sampledItems = sampleItems(
      auditList.items,
      this.config.maxCommitmentsPerNode,
    )

    let auditAttempts = 0
    let auditFailures = 0
    let challengedChunks = 0
    let verifiedChunks = 0
    const proofLatencies: number[] = []
    const auditedCids: string[] = []
    const invalidCids: string[] = []

    for (const item of sampledItems) {
      auditedCids.push(item.cid)
      auditAttempts++

      try {
        const challenge = await fetchJson<StorageAuditChallengeResponse>(
          joinUrl(
            baseUrl,
            `/storage/audit/${item.cid}/challenge?count=${this.config.challengeChunkCount}`,
          ),
          this.config.requestTimeoutMs,
        )

        challengedChunks += challenge.chunkIndices.length
        const startedAt = Date.now()
        const proof = await fetchJson<StorageAuditProofResponse>(
          joinUrl(
            baseUrl,
            `/storage/audit/${item.cid}/prove?indices=${challenge.chunkIndices.join(',')}`,
          ),
          this.config.requestTimeoutMs,
        )
        proofLatencies.push(Date.now() - startedAt)

        const chunks: StorageAuditChunk[] = proof.chunks.map((chunk) => ({
          index: chunk.index,
          data: Uint8Array.from(Buffer.from(chunk.data, 'base64')),
          proof: chunk.proof,
        }))

        const verification = verifyStorageAuditChunks(proof.audit, chunks)
        if (!verification.valid) {
          auditFailures++
          invalidCids.push(item.cid)
          continue
        }

        verifiedChunks += chunks.length
      } catch {
        auditFailures++
        invalidCids.push(item.cid)
      }
    }

      const proofSuccessRatio =
      challengedChunks === 0 ? 1 : verifiedChunks / challengedChunks
    const healthRatio = 1
    const latencyWeight = QOS_VALIDATOR_SERVICE_PROFILES.storage.metrics.latency
    const volumeWeight = QOS_VALIDATOR_SERVICE_PROFILES.storage.metrics.volume
    const uptimeWeight = QOS_VALIDATOR_SERVICE_PROFILES.storage.metrics.uptime
    const uptimeScore = Math.max(
      0,
      Math.min(
        10000,
        Math.round(
          (healthRatio * uptimeWeight +
            proofSuccessRatio * (1 - uptimeWeight)) *
            10000,
        ),
      ),
    )
    const paidVolumeScore = Math.max(
      0,
      Math.round(summary.paidOperations * volumeWeight),
    )
    const normalizedLatency =
      proofLatencies.length > 0 ? average(proofLatencies) : healthLatencyMs
    const avgResponseTime = Math.max(
      1,
      Math.round(normalizedLatency * Math.max(0.1, latencyWeight)),
    )

    return {
      uptimeScore,
      requestsServed: paidVolumeScore,
      avgResponseTime,
      summary,
      healthLatencyMs,
      auditAttempts,
      auditFailures,
      challengedChunks,
      verifiedChunks,
      averageProofLatencyMs: average(proofLatencies),
      auditedCids,
      invalidCids,
      baseUrl,
    }
  }

  private getNodeHistoryState(nodeId: Hex): NodeHistoryState {
    let history = this.nodeHistoryById.get(nodeId)
    if (!history) {
      history = {
        samples: [],
        currentDayBucket: 0,
        currentDayUptimeSum: 0,
        currentDaySampleCount: 0,
        lifetimeDayUptimeSum: 0,
        lifetimeDaysObserved: 0,
      }
      this.nodeHistoryById.set(nodeId, history)
    }
    return history
  }

  private averageSampleMetric(
    samples: NodeMetricSample[],
    pick: (sample: NodeMetricSample) => number,
  ): number {
    if (samples.length === 0) return 0
    return Math.round(
      samples.reduce((sum, sample) => sum + pick(sample), 0) / samples.length,
    )
  }

  private buildNodeMetadataSummary(
    nodeId: Hex,
    metrics: NodeAuditMetrics,
    nowUnixSeconds: number,
  ): NodeMetadataSummary {
    const history = this.getNodeHistoryState(nodeId)
    const dayBucket = Math.floor(nowUnixSeconds / 86_400)

    if (history.currentDayBucket === 0) {
      history.currentDayBucket = dayBucket
    } else if (dayBucket > history.currentDayBucket) {
      if (history.currentDaySampleCount > 0) {
        history.lifetimeDayUptimeSum += Math.round(
          history.currentDayUptimeSum / history.currentDaySampleCount,
        )
        history.lifetimeDaysObserved += 1
      }
      history.currentDayBucket = dayBucket
      history.currentDayUptimeSum = 0
      history.currentDaySampleCount = 0
    }

    const sample: NodeMetricSample = {
      timestamp: nowUnixSeconds,
      uptimeScore: metrics.uptimeScore,
      requestsServed: metrics.requestsServed,
      avgResponseTime: metrics.avgResponseTime,
    }

    history.samples.push(sample)
    history.currentDayUptimeSum += metrics.uptimeScore
    history.currentDaySampleCount += 1

    const dayCutoff = nowUnixSeconds - 86_400
    history.samples = history.samples.filter((entry) => entry.timestamp >= dayCutoff)

    const hourCutoff = nowUnixSeconds - 3_600
    const oneHourSamples = history.samples.filter(
      (entry) => entry.timestamp >= hourCutoff,
    )

    const currentDayAverage =
      history.currentDaySampleCount > 0
        ? Math.round(history.currentDayUptimeSum / history.currentDaySampleCount)
        : 0
    const lifetimeDays =
      history.lifetimeDaysObserved + (history.currentDaySampleCount > 0 ? 1 : 0)
    const lifetimeUptimeBps =
      lifetimeDays > 0
        ? Math.round(
            (history.lifetimeDayUptimeSum + currentDayAverage) / lifetimeDays,
          )
        : metrics.uptimeScore

    return {
      nodeId,
      updatedAt: nowUnixSeconds,
      latest: {
        uptimeBps: metrics.uptimeScore,
        requestsServed: metrics.requestsServed,
        avgResponseMs: metrics.avgResponseTime,
      },
      avg1h: {
        uptimeBps: this.averageSampleMetric(oneHourSamples, (entry) => entry.uptimeScore),
        requestsServed: this.averageSampleMetric(
          oneHourSamples,
          (entry) => entry.requestsServed,
        ),
        avgResponseMs: this.averageSampleMetric(
          oneHourSamples,
          (entry) => entry.avgResponseTime,
        ),
      },
      avg24h: {
        uptimeBps: this.averageSampleMetric(history.samples, (entry) => entry.uptimeScore),
        requestsServed: this.averageSampleMetric(
          history.samples,
          (entry) => entry.requestsServed,
        ),
        avgResponseMs: this.averageSampleMetric(
          history.samples,
          (entry) => entry.avgResponseTime,
        ),
      },
      lifetime: {
        daysObserved: lifetimeDays,
        uptimeBps: lifetimeUptimeBps,
      },
    }
  }

  private async resolveNodeAgentId(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
    node: NodeInfoResponse['node'],
  ): Promise<bigint> {
    try {
      const nodeIdentityAgentId = (await contractClient.publicClient.readContract({
        address: this.nodeStakingAddress,
        abi: NODE_STAKING_MANAGER_ABI,
        functionName: 'getNodeIdentityAgentId',
        args: [nodeId],
      })) as bigint
      if (nodeIdentityAgentId > 0n) return nodeIdentityAgentId
    } catch {
      // Fallback to operator-level agent IDs on legacy managers.
    }

    return node.operatorAgentId > 0n ? node.operatorAgentId : 0n
  }

  private async publishNodeQoSMetadata(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
    node: NodeInfoResponse['node'],
    metrics: NodeAuditMetrics,
  ): Promise<void> {
    if (!this.qosMetadataConsensusAddress) return

    const nowUnixSeconds = Math.floor(Date.now() / 1000)
    const lastPublishedAt = this.lastMetadataPublishAtByNode.get(nodeId) ?? 0
    if (
      nowUnixSeconds - lastPublishedAt <
      this.config.metadataPublishIntervalSec
    ) {
      return
    }

    const agentId = await this.resolveNodeAgentId(contractClient, nodeId, node)
    if (agentId === 0n) return

    const summary = this.buildNodeMetadataSummary(nodeId, metrics, nowUnixSeconds)
    const summaryJson = JSON.stringify(summary)
    const summaryHex = `0x${Buffer.from(summaryJson, 'utf8').toString('hex')}` as Hex

    const txHash = await contractClient.client.writeContract({
      address: this.qosMetadataConsensusAddress,
      abi: QOS_METADATA_CONSENSUS_ABI,
      functionName: 'proposeOrApproveMetadataUpdate',
      args: [
        agentId,
        [this.config.metadataKey],
        [summaryHex],
        BigInt(this.config.metadataProposalDurationSec),
      ],
      chain: this.chain,
      account: contractClient.account,
    })
    await contractClient.publicClient.waitForTransactionReceipt({ hash: txHash })
    this.lastMetadataPublishAtByNode.set(nodeId, nowUnixSeconds)

    console.log(
      `[QoSV:storage] Published ${this.config.metadataKey} proposal for node ${nodeId} -> agent ${agentId}`,
    )
  }

  private async ensureQoSValidatorRegistration(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
  ): Promise<void> {
    const isRegistered = await contractClient.publicClient.readContract({
      address: this.nodeStakingAddress,
      abi: QOS_VALIDATOR_REGISTRATION_ABI,
      functionName: 'isPerformanceOracle',
      args: [contractClient.address],
    })

    if (isRegistered) return

    const txHash = await contractClient.client.writeContract({
      address: this.nodeStakingAddress,
      abi: QOS_VALIDATOR_REGISTRATION_ABI,
      functionName: 'addPerformanceOracle',
      args: [contractClient.address],
      chain: this.chain,
      account: contractClient.account,
    })
    await contractClient.publicClient.waitForTransactionReceipt({ hash: txHash })
    console.log(
      `[QoSV:storage] Registered ${contractClient.address} as QoS Validator`,
    )
  }

  private getPendingSlashSet(nodeId: Hex): Set<Hex> {
    let slashIds = this.pendingSlashIdsByNode.get(nodeId)
    if (!slashIds) {
      slashIds = new Set<Hex>()
      this.pendingSlashIdsByNode.set(nodeId, slashIds)
    }
    return slashIds
  }

  private async syncPendingSlashIds(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
  ): Promise<void> {
    const latestBlock = await contractClient.publicClient.getBlockNumber()
    const configuredLookback = BigInt(this.config.slashEventLookbackBlocks)
    const fromCursor = this.slashScanCursorByNode.get(nodeId)
    const fromBlock =
      fromCursor !== undefined
        ? fromCursor
        : latestBlock > configuredLookback
          ? latestBlock - configuredLookback
          : 0n

    if (fromBlock > latestBlock) {
      return
    }

    const slashIds = this.getPendingSlashSet(nodeId)
    let cursor = fromBlock

    while (cursor <= latestBlock) {
      const toBlock = (() => {
        const upperBound = cursor + this.slashEventQueryChunkSize - 1n
        return upperBound > latestBlock ? latestBlock : upperBound
      })()

      const events = await contractClient.publicClient.getContractEvents({
        address: this.nodeStakingAddress,
        abi: NODE_STAKING_MANAGER_ABI,
        eventName: 'SlashProposed',
        args: { nodeId },
        fromBlock: cursor,
        toBlock,
      })

      for (const event of events) {
        const slashId = (event as { args?: { slashId?: Hex } }).args?.slashId
        if (slashId) {
          slashIds.add(slashId)
        }
      }

      cursor = toBlock + 1n
    }

    this.slashScanCursorByNode.set(nodeId, latestBlock + 1n)
  }

  private async executeMaturedPendingSlashes(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
    nowUnixSeconds: bigint,
  ): Promise<boolean> {
    const slashIds = this.pendingSlashIdsByNode.get(nodeId)
    if (!slashIds || slashIds.size === 0) return false

    let executed = false

    for (const slashId of [...slashIds]) {
      const slash = (await contractClient.publicClient.readContract({
        address: this.nodeStakingAddress,
        abi: NODE_STAKING_MANAGER_ABI,
        functionName: 'pendingSlashes',
        args: [slashId],
      })) as unknown as PendingSlash

      if (
        slash.proposedAt === 0n ||
        slash.executed ||
        slash.disputed ||
        slash.nodeId.toLowerCase() !== nodeId.toLowerCase()
      ) {
        slashIds.delete(slashId)
        continue
      }

      if (slash.executeAfter > nowUnixSeconds) continue

      const txHash = await contractClient.client.writeContract({
        address: this.nodeStakingAddress,
        abi: NODE_STAKING_MANAGER_ABI,
        functionName: 'executeSlash',
        args: [slashId],
        chain: this.chain,
        account: contractClient.account,
      })
      await contractClient.publicClient.waitForTransactionReceipt({ hash: txHash })
      slashIds.delete(slashId)
      executed = true
      console.log(
        `[QoSV:storage] Executed staking slash ${slashId} for node ${nodeId}`,
      )
    }

    return executed
  }

  private async ensureAutoSlashingEnabled(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
  ): Promise<void> {
    if (!this.autoSlasherAddress) return

    const enabled = await contractClient.publicClient.readContract({
      address: this.autoSlasherAddress,
      abi: AUTO_SLASHER_ABI,
      functionName: 'autoSlashingEnabled',
    })
    if (enabled) return

    const txHash = await contractClient.client.writeContract({
      address: this.autoSlasherAddress,
      abi: AUTO_SLASHER_ABI,
      functionName: 'setAutoSlashingEnabled',
      args: [true],
      chain: this.chain,
      account: contractClient.account,
    })
    await contractClient.publicClient.waitForTransactionReceipt({ hash: txHash })
    console.log('[QoSV:storage] Enabled AutoSlasher')
  }

  private async handleSlashing(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
  ): Promise<{ checked: boolean; proposed: boolean; executed: boolean }> {
    let checked = false
    let proposed = false
    let executed = false
    const nowUnixSeconds = BigInt(Math.floor(Date.now() / 1000))

    if (this.autoSlasherAddress) {
      const enabled = await contractClient.publicClient.readContract({
        address: this.autoSlasherAddress,
        abi: AUTO_SLASHER_ABI,
        functionName: 'autoSlashingEnabled',
      })

      if (enabled) {
        const before = (await contractClient.publicClient.readContract({
          address: this.autoSlasherAddress,
          abi: AUTO_SLASHER_ABI,
          functionName: 'slashProposals',
          args: [nodeId],
        })) as unknown as SlashProposal

        const checkHash = await contractClient.client.writeContract({
          address: this.autoSlasherAddress,
          abi: AUTO_SLASHER_ABI,
          functionName: 'checkAndProposeSlashing',
          args: [nodeId],
          chain: this.chain,
          account: contractClient.account,
        })
        await contractClient.publicClient.waitForTransactionReceipt({
          hash: checkHash,
        })

        const after = (await contractClient.publicClient.readContract({
          address: this.autoSlasherAddress,
          abi: AUTO_SLASHER_ABI,
          functionName: 'slashProposals',
          args: [nodeId],
        })) as unknown as SlashProposal

        checked = true
        proposed = after.proposedAt > before.proposedAt

        if (
          this.config.executeSlashing &&
          !after.executed &&
          !after.appealed &&
          after.executesAt > 0n &&
          after.executesAt <= nowUnixSeconds
        ) {
          const executeHash = await contractClient.client.writeContract({
            address: this.autoSlasherAddress,
            abi: AUTO_SLASHER_ABI,
            functionName: 'executeSlashing',
            args: [nodeId],
            chain: this.chain,
            account: contractClient.account,
          })
          await contractClient.publicClient.waitForTransactionReceipt({
            hash: executeHash,
          })
          executed = true
        }
      }
    }

    await this.syncPendingSlashIds(contractClient, nodeId)
    checked = true

    if (this.config.executeSlashing) {
      const stakingSlashExecuted = await this.executeMaturedPendingSlashes(
        contractClient,
        nodeId,
        nowUnixSeconds,
      )
      executed = executed || stakingSlashExecuted
    }

    return {
      checked,
      proposed,
      executed,
    }
  }
}

export async function main(): Promise<void> {
  const reporter = new StorageReporter(loadStorageReporterConfig())

  const shutdown = async () => {
    await reporter.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })

  await reporter.start()
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[QoSV:storage] Fatal error:', error)
    process.exit(1)
  })
}
