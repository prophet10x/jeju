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
  QOS_VALIDATOR_SERVICE_PROFILES,
  type QoSValidatorModule,
} from './qos-validator-types'
import { isAddress, type Address, type Chain, type Hex, verifyMessage } from 'viem'
import { base, baseSepolia, foundry } from 'viem/chains'

export type NonStorageQoSModule = Exclude<QoSValidatorModule, 'storage'>

export interface QoSServiceReporterConfig {
  module: NonStorageQoSModule
  network: NetworkType
  chainId: number
  rpcUrl: string
  serviceId: string
  fallbackPrivateKey?: Hex
  pollIntervalMs: number
  requestTimeoutMs: number
  lookbackHours: number
  maxSamplesPerNode: number
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

interface ComputeHealthResponse {
  service: string
  status: string
  activeJobs: number
  maxConcurrent: number
  queuedJobs: number
}

interface ComputeNodeStatsResponse {
  inference: {
    totalNodes: number
    activeNodes: number
    totalCapacity: number
    currentLoad: number
    providers: string[]
    models: string[]
  }
  training: {
    totalNodes: number
    activeNodes: number
    totalRuns: number
    activeRuns: number
  }
}

interface ComputeJobsResponse {
  jobs: Array<{
    jobId: string
    status: string
    startedAt: number | null
    completedAt: number | null
  }>
  total: number
}

interface RpcHealthResponse {
  status: string
  service: string
  chains: Array<{
    chainId: number
    name: string
    providers: number
    avgLatency: number | null
  }>
  totalProviders: number
  activeSessions: number
}

interface RpcChainsResponse {
  chains: Array<{
    chainId: number
    name: string
    providers: number
    avgLatency: number | null
  }>
}

interface CdnHealthResponse {
  status: string
  service: string
  cache: {
    entries: number
    sizeBytes: number
    maxSizeBytes: number
    hitRate: number
  }
  apps: {
    registered: number
    names: string[]
  }
}

interface CdnStatsResponse {
  entries: number
  sizeBytes: number
  maxSizeBytes: number
  maxEntries: number
  hitRate: number
  hitCount: number
  missCount: number
}

interface GenericHealthResponse {
  status?: string
  service?: string
  [key: string]: unknown
}

interface NodeServiceMetrics {
  uptimeScore: number
  requestsServed: number
  avgResponseTime: number
  healthLatencyMs: number
  baseUrl: string
  details: Record<string, unknown>
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
  module: NonStorageQoSModule
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
  module: NonStorageQoSModule
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
  metrics?: NodeServiceMetrics
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
    .split(/[\s,]+/)
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

  const exactOverride =
    overrides.get(nodeId.toLowerCase()) ?? overrides.get(rpcUrl.toLowerCase())
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function clampBps(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 10_000) return 10_000
  return Math.round(value)
}

function calculatePassRateBps(samples: NodeAttestationSample[]): number {
  if (samples.length === 0) return 0
  const passCount = samples.reduce(
    (sum, sample) => sum + (sample.passed ? 1 : 0),
    0,
  )
  return clampBps((passCount * 10_000) / samples.length)
}

function buildEvidenceHash(parts: string[]): Hex {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex')
  return `0x${digest}` as Hex
}

interface ModuleEndpointPaths {
  routePath: string
  healthPath: string
  statsPath: string | null
  metricsPath: string | null
}

function resolveModuleEndpoints(module: NonStorageQoSModule): ModuleEndpointPaths {
  switch (module) {
    case 'security':
      return {
        routePath: 'security',
        healthPath: '/security/waf/stats',
        statsPath: '/security/waf/stats',
        metricsPath: null,
      }
    case 'email':
      return {
        routePath: 'email',
        healthPath: '/email/health',
        statsPath: null,
        metricsPath: '/email/metrics',
      }
    case 'observability':
      return {
        routePath: 'observability',
        healthPath: '/observability/health',
        statsPath: null,
        metricsPath: '/observability/metrics',
      }
    case 'gpu':
      return {
        routePath: 'compute',
        healthPath: '/compute/health',
        statsPath: '/compute/nodes/stats',
        metricsPath: null,
      }
    case 'agents':
      return {
        routePath: 'a2a',
        healthPath: '/a2a/health',
        statsPath: null,
        metricsPath: null,
      }
    default:
      return {
        routePath: module,
        healthPath: `/${module}/health`,
        statsPath: `/${module}/stats`,
        metricsPath: `/${module}/metrics`,
      }
  }
}

function parseHealthRatioFromStatus(status: unknown): number {
  if (typeof status !== 'string') return 1
  const normalized = status.toLowerCase()
  if (normalized === 'healthy' || normalized === 'ok' || normalized === 'ready') {
    return 1
  }
  if (normalized === 'degraded') return 0.6
  if (normalized === 'warning') return 0.75
  if (normalized === 'offline' || normalized === 'unhealthy' || normalized === 'error') {
    return 0
  }
  return 1
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function collectNumberishValues(input: unknown): number[] {
  if (!input || typeof input !== 'object') return []

  const values: number[] = []
  const queue: unknown[] = [input]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item)
      continue
    }

    for (const value of Object.values(current)) {
      const numeric = toNumber(value)
      if (numeric !== null) {
        values.push(numeric)
      } else if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }

  return values
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

function readServiceEnv(module: NonStorageQoSModule, suffix: string): string | undefined {
  const upper = module.toUpperCase()
  return process.env[`QOS_VALIDATOR_${upper}_${suffix}`] ?? process.env[`QOS_VALIDATOR_${suffix}`]
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

export function loadQoSServiceReporterConfig(
  module: NonStorageQoSModule,
): QoSServiceReporterConfig {
  const network = (process.env.JEJU_NETWORK as NetworkType | undefined) ?? getCurrentNetwork()
  const chainId = getChainId(network)
  const profile = QOS_VALIDATOR_SERVICE_PROFILES[module]

  return {
    module,
    network,
    chainId,
    rpcUrl:
      readServiceEnv(module, 'RPC_URL') ??
      getRpcUrl(network),
    serviceId:
      readServiceEnv(module, 'SERVICE_ID') ??
      profile.serviceId,
    fallbackPrivateKey: (
      readServiceEnv(module, 'PRIVATE_KEY') ??
      process.env.ORACLE_PRIVATE_KEY ??
      process.env.PRIVATE_KEY
    ) as Hex | undefined,
    pollIntervalMs: getEnvInt(
      `QOS_VALIDATOR_${module.toUpperCase()}_POLL_INTERVAL_MS`,
      getEnvInt('QOS_VALIDATOR_POLL_INTERVAL_MS', 15 * 60 * 1000),
    ),
    requestTimeoutMs: getEnvInt(
      `QOS_VALIDATOR_${module.toUpperCase()}_REQUEST_TIMEOUT_MS`,
      getEnvInt('QOS_VALIDATOR_REQUEST_TIMEOUT_MS', 15_000),
    ),
    lookbackHours: getEnvInt(
      `QOS_VALIDATOR_${module.toUpperCase()}_LOOKBACK_HOURS`,
      getEnvInt('QOS_VALIDATOR_LOOKBACK_HOURS', 24),
    ),
    maxSamplesPerNode: Math.max(
      1,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_MAX_SAMPLES`,
        getEnvInt('QOS_VALIDATOR_MAX_SAMPLES', 200),
      ),
    ),
    slashEventLookbackBlocks: Math.max(
      0,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_SLASH_EVENT_LOOKBACK_BLOCKS`,
        getEnvInt('QOS_VALIDATOR_SLASH_EVENT_LOOKBACK_BLOCKS', 100_000),
      ),
    ),
    publishIdentityMetadata: getEnvBool(
      `QOS_VALIDATOR_${module.toUpperCase()}_PUBLISH_IDENTITY_METADATA`,
      getEnvBool('QOS_VALIDATOR_PUBLISH_IDENTITY_METADATA'),
    ),
    metadataKey:
      readServiceEnv(module, 'METADATA_KEY') ??
      `qos.${module}.summary.v1`,
    metadataPublishIntervalSec: Math.max(
      60,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_METADATA_PUBLISH_INTERVAL_SEC`,
        getEnvInt('QOS_VALIDATOR_METADATA_PUBLISH_INTERVAL_SEC', 3600),
      ),
    ),
    metadataProposalDurationSec: Math.max(
      60,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_METADATA_PROPOSAL_DURATION_SEC`,
        getEnvInt('QOS_VALIDATOR_METADATA_PROPOSAL_DURATION_SEC', 3600),
      ),
    ),
    metadataConsensusAddress: parseOptionalAddress(
      readServiceEnv(module, 'METADATA_CONSENSUS_ADDRESS'),
    ),
    submitOnChain: getEnvBool(
      `QOS_VALIDATOR_${module.toUpperCase()}_SUBMIT_ON_CHAIN`,
      getEnvBool('QOS_VALIDATOR_SUBMIT_ON_CHAIN'),
    ),
    registerAsQoSValidator: getEnvBool(
      `QOS_VALIDATOR_${module.toUpperCase()}_REGISTER_AS_QOS_VALIDATOR`,
      getEnvBool(
        'QOS_VALIDATOR_REGISTER_AS_QOS_VALIDATOR',
        getEnvBool('QOS_VALIDATOR_REGISTER_AS_PERFORMANCE_ORACLE'),
      ),
    ),
    enableAutoSlashing: getEnvBool(
      `QOS_VALIDATOR_${module.toUpperCase()}_ENABLE_AUTO_SLASHING`,
      getEnvBool('QOS_VALIDATOR_ENABLE_AUTO_SLASHING'),
    ),
    checkSlashing: getEnvBool(
      `QOS_VALIDATOR_${module.toUpperCase()}_CHECK_SLASHING`,
      getEnvBool('QOS_VALIDATOR_CHECK_SLASHING'),
    ),
    executeSlashing: getEnvBool(
      `QOS_VALIDATOR_${module.toUpperCase()}_EXECUTE_SLASHING`,
      getEnvBool('QOS_VALIDATOR_EXECUTE_SLASHING'),
    ),
    runOnce: getEnvBool(
      `QOS_VALIDATOR_${module.toUpperCase()}_RUN_ONCE`,
      getEnvBool('QOS_VALIDATOR_RUN_ONCE'),
    ),
    endpointOverrides: parseEndpointOverrides(
      readServiceEnv(module, 'ENDPOINT_OVERRIDES'),
    ),
    allowedNodeIds: parseAllowedNodeIds(
      readServiceEnv(module, 'NODE_IDS'),
    ),
    attestationEnabled: getEnvBool(
      `QOS_VALIDATOR_${module.toUpperCase()}_ATTESTATION_ENABLED`,
      getEnvBool('QOS_VALIDATOR_ATTESTATION_ENABLED', true),
    ),
    attestationPath:
      readServiceEnv(module, 'ATTESTATION_PATH') ?? QOS_ATTESTATION_PATH,
    attestationChallengeWindowMs: Math.max(
      10_000,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_ATTESTATION_CHALLENGE_WINDOW_MS`,
        getEnvInt('QOS_VALIDATOR_ATTESTATION_CHALLENGE_WINDOW_MS', 90_000),
      ),
    ),
    attestationAllowedSkewMs: Math.max(
      0,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_ATTESTATION_ALLOWED_SKEW_MS`,
        getEnvInt('QOS_VALIDATOR_ATTESTATION_ALLOWED_SKEW_MS', 30_000),
      ),
    ),
    attestationSlashBps: Math.max(
      1,
      Math.min(
        10_000,
        getEnvInt(
          `QOS_VALIDATOR_${module.toUpperCase()}_ATTESTATION_SLASH_BPS`,
          getEnvInt('QOS_VALIDATOR_ATTESTATION_SLASH_BPS', 1000),
        ),
      ),
    ),
    attestationSlashPassRateThresholdBps: Math.max(
      0,
      Math.min(
        10_000,
        getEnvInt(
          `QOS_VALIDATOR_${module.toUpperCase()}_ATTESTATION_SLASH_PASS_RATE_BPS`,
          getEnvInt('QOS_VALIDATOR_ATTESTATION_SLASH_PASS_RATE_BPS', 7000),
        ),
      ),
    ),
    attestationSlashConsecutiveFailureThreshold: Math.max(
      1,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_ATTESTATION_SLASH_CONSECUTIVE_FAILURES`,
        getEnvInt('QOS_VALIDATOR_ATTESTATION_SLASH_CONSECUTIVE_FAILURES', 8),
      ),
    ),
    attestationSlashProposalCooldownSec: Math.max(
      60,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_ATTESTATION_SLASH_PROPOSAL_COOLDOWN_SEC`,
        getEnvInt(
          'QOS_VALIDATOR_ATTESTATION_SLASH_PROPOSAL_COOLDOWN_SEC',
          6 * 3600,
        ),
      ),
    ),
    attestationMetadataKey:
      readServiceEnv(module, 'ATTESTATION_METADATA_KEY') ??
      `qos.${module}.attestation.v1`,
    attestationMetadataPublishIntervalSec: Math.max(
      60,
      getEnvInt(
        `QOS_VALIDATOR_${module.toUpperCase()}_ATTESTATION_METADATA_PUBLISH_INTERVAL_SEC`,
        getEnvInt(
          'QOS_VALIDATOR_ATTESTATION_METADATA_PUBLISH_INTERVAL_SEC',
          3600,
        ),
      ),
    ),
  }
}

export class QoSServiceReporter {
  private readonly config: QoSServiceReporterConfig
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

  constructor(config: QoSServiceReporterConfig) {
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
      `[QoSV:${this.config.module}] Starting on ${this.config.network} (${this.config.chainId})`,
    )

    await this.runCycle()

    if (this.config.runOnce) {
      await this.stop()
      return
    }

    this.timer = setInterval(() => {
      void this.runCycle().catch((error) => {
        console.error(`[QoSV:${this.config.module}] Cycle failed:`, error)
      })
    }, this.config.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    console.log(`[QoSV:${this.config.module}] Stopped`)
  }

  async runCycle(): Promise<NodeReportResult[]> {
    const contractClient = await this.getContractClient()

    if (this.config.registerAsQoSValidator) {
      try {
        await this.ensureQoSValidatorRegistration(contractClient)
      } catch (error) {
        console.warn(
          `[QoSV:${this.config.module}] Could not register QoS Validator:`,
          error,
        )
      }
    }

    if (this.config.enableAutoSlashing) {
      try {
        await this.ensureAutoSlashingEnabled(contractClient)
      } catch (error) {
        console.warn(
          `[QoSV:${this.config.module}] Could not enable auto slashing:`,
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
      `[QoSV:${this.config.module}] Cycle complete:`,
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

      const collectedMetrics = await this.collectNodeMetrics(nodeId, node.rpcUrl)
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
          console.warn(
            `[QoSV:${this.config.module}] Could not publish node metadata:`,
            error,
          )
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
    rpcUrl: string,
  ): Promise<NodeServiceMetrics> {
    const moduleEndpoints = resolveModuleEndpoints(this.config.module)
    const candidates = buildBaseCandidates(nodeId, rpcUrl, this.config.endpointOverrides)

    if (candidates.length === 0) {
      throw new Error(`No valid endpoint candidates for ${rpcUrl}`)
    }

    let baseUrl: string | null = null
    let healthLatencyMs = 0

    for (const candidate of candidates) {
      const startedAt = Date.now()
      try {
        await fetchJson<unknown>(
          joinUrl(candidate, moduleEndpoints.healthPath),
          this.config.requestTimeoutMs,
        )
        baseUrl = candidate
        healthLatencyMs = Date.now() - startedAt
        break
      } catch {
        // Try the next endpoint candidate.
      }
    }

    if (!baseUrl) {
      throw new Error(
        `${this.config.module} health check failed for ${rpcUrl}`,
      )
    }

    switch (this.config.module) {
      case 'compute':
      case 'gpu':
        return this.collectComputeMetrics(baseUrl, healthLatencyMs)
      case 'rpc':
        return this.collectRpcMetrics(baseUrl, healthLatencyMs)
      case 'cdn':
        return this.collectCdnMetrics(baseUrl, healthLatencyMs)
      default:
        return this.collectGenericModuleMetrics(
          baseUrl,
          healthLatencyMs,
          moduleEndpoints,
        )
    }
  }

  private getNodeAttestationState(nodeId: Hex): NodeAttestationState {
    let state = this.nodeAttestationById.get(nodeId)
    if (!state) {
      state = {
        samples: [],
        currentDayBucket: 0,
        currentDayPassCount: 0,
        currentDaySampleCount: 0,
        lifetimeDayPassRateSum: 0,
        lifetimeDaysObserved: 0,
        consecutiveFailures: 0,
      }
      this.nodeAttestationById.set(nodeId, state)
    }
    return state
  }

  private recordNodeAttestation(
    nodeId: Hex,
    sample: {
      timestamp: number
      checked: boolean
      verified: boolean
      reason: string | null
      expectedSigner: Address | null
      signer: Address | null
      evidenceHash: Hex | null
      endpointOrigin: string | null
    },
  ): NodeAttestationSnapshot {
    const state = this.getNodeAttestationState(nodeId)
    const dayBucket = Math.floor(sample.timestamp / 86_400)

    if (state.currentDayBucket === 0) {
      state.currentDayBucket = dayBucket
    } else if (dayBucket > state.currentDayBucket) {
      if (state.currentDaySampleCount > 0) {
        state.lifetimeDayPassRateSum += Math.round(
          (state.currentDayPassCount * 10_000) / state.currentDaySampleCount,
        )
        state.lifetimeDaysObserved += 1
      }
      state.currentDayBucket = dayBucket
      state.currentDayPassCount = 0
      state.currentDaySampleCount = 0
    }

    state.samples.push({
      timestamp: sample.timestamp,
      passed: sample.verified,
    })
    state.currentDaySampleCount += 1
    if (sample.verified) {
      state.currentDayPassCount += 1
      state.consecutiveFailures = 0
    } else {
      state.consecutiveFailures += 1
    }

    const dayCutoff = sample.timestamp - 86_400
    state.samples = state.samples.filter((entry) => entry.timestamp >= dayCutoff)

    const hourCutoff = sample.timestamp - 3_600
    const oneHourSamples = state.samples.filter(
      (entry) => entry.timestamp >= hourCutoff,
    )

    const passRate1hBps = calculatePassRateBps(oneHourSamples)
    const passRate24hBps = calculatePassRateBps(state.samples)
    const currentDayPassRate =
      state.currentDaySampleCount > 0
        ? Math.round((state.currentDayPassCount * 10_000) / state.currentDaySampleCount)
        : passRate24hBps
    const lifetimeDays =
      state.lifetimeDaysObserved + (state.currentDaySampleCount > 0 ? 1 : 0)
    const lifetimePassRateBps =
      lifetimeDays > 0
        ? Math.round(
            (state.lifetimeDayPassRateSum + currentDayPassRate) / lifetimeDays,
          )
        : passRate24hBps

    return {
      nodeId,
      checked: sample.checked,
      verified: sample.verified,
      passRate1hBps,
      passRate24hBps,
      consecutiveFailures: state.consecutiveFailures,
      lifetimeDaysObserved: lifetimeDays,
      lifetimePassRateBps,
      reason: sample.reason,
      expectedSigner: sample.expectedSigner,
      signer: sample.signer,
      evidenceHash: sample.evidenceHash,
      endpointOrigin: sample.endpointOrigin,
    }
  }

  private async resolveExpectedAttestationSigner(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
    node: NodeInfoResponse['node'],
  ): Promise<Address | null> {
    if (!this.identityRegistryAddress) return null

    const agentId = await this.resolveNodeAgentId(contractClient, nodeId, node)
    if (agentId === 0n) return null

    try {
      const wallet = (await contractClient.publicClient.readContract({
        address: this.identityRegistryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'getAgentWallet',
        args: [agentId],
      })) as Address
      if (!isAddress(wallet)) return null
      if (wallet.toLowerCase() === '0x0000000000000000000000000000000000000000') {
        return null
      }
      return wallet
    } catch {
      return null
    }
  }

  private async verifyNodeAttestation(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
    node: NodeInfoResponse['node'],
    baseUrl: string,
  ): Promise<NodeAttestationSnapshot> {
    const now = Date.now()
    const endpointOrigin = normalizeAttestationOrigin(baseUrl)

    if (!this.config.attestationEnabled) {
      return this.recordNodeAttestation(nodeId, {
        timestamp: Math.floor(now / 1000),
        checked: false,
        verified: true,
        reason: null,
        expectedSigner: null,
        signer: null,
        evidenceHash: null,
        endpointOrigin,
      })
    }

    const expectedSigner = await this.resolveExpectedAttestationSigner(
      contractClient,
      nodeId,
      node,
    )
    if (!expectedSigner) {
      return this.recordNodeAttestation(nodeId, {
        timestamp: Math.floor(now / 1000),
        checked: true,
        verified: false,
        reason: 'attestation key not bound onchain',
        expectedSigner: null,
        signer: null,
        evidenceHash: buildEvidenceHash([
          nodeId,
          endpointOrigin,
          'missing_expected_signer',
        ]),
        endpointOrigin,
      })
    }

    const issuedAt = now
    const expiresAt = issuedAt + this.config.attestationChallengeWindowMs
    const requestPayload = QoSAttestationRequestSchema.parse({
      nodeId,
      nonce: randomBytes(16).toString('hex'),
      issuedAt,
      expiresAt,
      chainId: this.config.chainId,
      validatorId: contractClient.address,
    })

    let proof: QoSAttestationProof
    try {
      const response = await fetch(
        joinUrl(baseUrl, this.config.attestationPath),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(requestPayload),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        },
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const payload = await response.json()
      const parsed = QoSAttestationProofSchema.safeParse(payload)
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        )
      }
      proof = parsed.data
    } catch (error) {
      return this.recordNodeAttestation(nodeId, {
        timestamp: Math.floor(now / 1000),
        checked: true,
        verified: false,
        reason: `attestation endpoint error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        expectedSigner,
        signer: null,
        evidenceHash: buildEvidenceHash([
          nodeId,
          endpointOrigin,
          expectedSigner,
          'endpoint_error',
        ]),
        endpointOrigin,
      })
    }

    const signedAt = proof.signedAt
    if (signedAt < issuedAt - this.config.attestationAllowedSkewMs) {
      return this.recordNodeAttestation(nodeId, {
        timestamp: Math.floor(now / 1000),
        checked: true,
        verified: false,
        reason: 'attestation signed before valid window',
        expectedSigner,
        signer: proof.signer as Address,
        evidenceHash: buildEvidenceHash([
          nodeId,
          endpointOrigin,
          expectedSigner,
          proof.signer,
          proof.signature,
          String(proof.seq),
          'signed_too_early',
        ]),
        endpointOrigin,
      })
    }

    if (signedAt > expiresAt + this.config.attestationAllowedSkewMs) {
      return this.recordNodeAttestation(nodeId, {
        timestamp: Math.floor(now / 1000),
        checked: true,
        verified: false,
        reason: 'attestation signed after expiry',
        expectedSigner,
        signer: proof.signer as Address,
        evidenceHash: buildEvidenceHash([
          nodeId,
          endpointOrigin,
          expectedSigner,
          proof.signer,
          proof.signature,
          String(proof.seq),
          'signed_too_late',
        ]),
        endpointOrigin,
      })
    }

    if (proof.signer.toLowerCase() !== expectedSigner.toLowerCase()) {
      return this.recordNodeAttestation(nodeId, {
        timestamp: Math.floor(now / 1000),
        checked: true,
        verified: false,
        reason: 'attestation signer mismatch',
        expectedSigner,
        signer: proof.signer as Address,
        evidenceHash: buildEvidenceHash([
          nodeId,
          endpointOrigin,
          expectedSigner,
          proof.signer,
          proof.signature,
          String(proof.seq),
          'signer_mismatch',
        ]),
        endpointOrigin,
      })
    }

    const message = buildQoSAttestationMessage({
      ...requestPayload,
      endpointOrigin,
      seq: proof.seq,
    })
    const signatureValid = await verifyMessage({
      address: expectedSigner,
      message,
      signature: proof.signature as Hex,
    })

    if (!signatureValid) {
      return this.recordNodeAttestation(nodeId, {
        timestamp: Math.floor(now / 1000),
        checked: true,
        verified: false,
        reason: 'attestation signature invalid',
        expectedSigner,
        signer: proof.signer as Address,
        evidenceHash: buildEvidenceHash([
          nodeId,
          endpointOrigin,
          expectedSigner,
          proof.signer,
          proof.signature,
          String(proof.seq),
          'invalid_signature',
        ]),
        endpointOrigin,
      })
    }

    return this.recordNodeAttestation(nodeId, {
      timestamp: Math.floor(now / 1000),
      checked: true,
      verified: true,
      reason: null,
      expectedSigner,
      signer: proof.signer as Address,
      evidenceHash: buildEvidenceHash([
        nodeId,
        endpointOrigin,
        expectedSigner,
        proof.signature,
        String(proof.seq),
      ]),
      endpointOrigin,
    })
  }

  private applyAttestationToMetrics(
    metrics: NodeServiceMetrics,
    attestation: NodeAttestationSnapshot,
  ): NodeServiceMetrics {
    const effectiveUptimeBps = Math.min(
      metrics.uptimeScore,
      attestation.passRate24hBps,
    )

    return {
      ...metrics,
      uptimeScore: effectiveUptimeBps,
      details: {
        ...metrics.details,
        attestation: {
          checked: attestation.checked,
          verified: attestation.verified,
          passRate1hBps: attestation.passRate1hBps,
          passRate24hBps: attestation.passRate24hBps,
          consecutiveFailures: attestation.consecutiveFailures,
          reason: attestation.reason,
          expectedSigner: attestation.expectedSigner,
          signer: attestation.signer,
          evidenceHash: attestation.evidenceHash,
          endpointOrigin: attestation.endpointOrigin,
        },
        effectiveUptimeBps,
      },
    }
  }

  private async collectComputeMetrics(
    baseUrl: string,
    healthLatencyMs: number,
  ): Promise<NodeServiceMetrics> {
    const profile = QOS_VALIDATOR_SERVICE_PROFILES[this.config.module].metrics

    const [health, stats, jobsResponse] = await Promise.all([
      fetchJson<ComputeHealthResponse>(
        joinUrl(baseUrl, '/compute/health'),
        this.config.requestTimeoutMs,
      ),
      fetchJson<ComputeNodeStatsResponse>(
        joinUrl(baseUrl, '/compute/nodes/stats'),
        this.config.requestTimeoutMs,
      ),
      fetchJson<ComputeJobsResponse>(
        joinUrl(baseUrl, `/compute/jobs?limit=${this.config.maxSamplesPerNode}`),
        this.config.requestTimeoutMs,
      ),
    ])

    const nowMs = Date.now()
    const lookbackMs = this.config.lookbackHours * 60 * 60 * 1000

    const recentJobs = jobsResponse.jobs.filter((job) => {
      const referenceTime = job.completedAt ?? job.startedAt
      if (referenceTime === null) return false
      return nowMs - referenceTime <= lookbackMs
    })

    const completedJobs = recentJobs.filter((job) => job.status === 'completed')
    const failedJobs = recentJobs.filter((job) => job.status === 'failed')
    const cancelledJobs = recentJobs.filter((job) => job.status === 'cancelled')

    const completedDurations = completedJobs
      .map((job) => {
        if (job.startedAt === null || job.completedAt === null) return null
        const duration = job.completedAt - job.startedAt
        return duration > 0 ? duration : null
      })
      .filter((duration): duration is number => duration !== null)

    const settledCount =
      completedJobs.length + failedJobs.length + cancelledJobs.length

    const successRatio = settledCount === 0 ? 1 : completedJobs.length / settledCount

    const inferenceCapacity = Math.max(0, stats.inference.totalCapacity)
    const inferenceLoad = Math.max(0, stats.inference.currentLoad)
    const hasActiveCapacity =
      stats.inference.activeNodes > 0 || stats.training.activeNodes > 0
    const capacityRatio =
      inferenceCapacity > 0
        ? clamp01(1 - inferenceLoad / Math.max(1, inferenceCapacity))
        : hasActiveCapacity
          ? 1
          : 0

    const reliabilityRatio = (successRatio + capacityRatio) / 2
    const healthRatio = health.status === 'healthy' ? 1 : 0

    const uptimeScore = clampBps(
      (healthRatio * profile.uptime + reliabilityRatio * (1 - profile.uptime)) *
        10_000,
    )

    const requestsServed = Math.max(
      0,
      Math.round(completedJobs.length * Math.max(0.1, profile.volume)),
    )

    const observedLatency =
      completedDurations.length > 0 ? average(completedDurations) : healthLatencyMs

    const avgResponseTime = Math.max(
      1,
      Math.round(observedLatency * Math.max(0.1, profile.latency)),
    )

    return {
      uptimeScore,
      requestsServed,
      avgResponseTime,
      healthLatencyMs,
      baseUrl,
      details: {
        inference: stats.inference,
        training: stats.training,
        jobsObserved: recentJobs.length,
        completedJobs: completedJobs.length,
        failedJobs: failedJobs.length,
        cancelledJobs: cancelledJobs.length,
      },
    }
  }

  private async collectRpcMetrics(
    baseUrl: string,
    healthLatencyMs: number,
  ): Promise<NodeServiceMetrics> {
    const profile = QOS_VALIDATOR_SERVICE_PROFILES.rpc.metrics

    const [health, chains] = await Promise.all([
      fetchJson<RpcHealthResponse>(
        joinUrl(baseUrl, '/rpc/health'),
        this.config.requestTimeoutMs,
      ),
      fetchJson<RpcChainsResponse>(
        joinUrl(baseUrl, '/rpc/chains?testnet=true'),
        this.config.requestTimeoutMs,
      ),
    ])

    const totalChains = chains.chains.length
    const chainsWithProviders = chains.chains.filter(
      (chain) => chain.providers > 0,
    ).length

    const providerCoverage =
      totalChains > 0 ? chainsWithProviders / totalChains : 0
    const providerDepth =
      health.totalProviders > 0 ? clamp01(health.totalProviders / 5) : 0
    const networkAvailability = providerCoverage * 0.45 + providerDepth * 0.55

    const healthRatio = health.status === 'healthy' ? 1 : 0

    const uptimeScore = clampBps(
      (healthRatio * profile.uptime + networkAvailability * (1 - profile.uptime)) *
        10_000,
    )

    const requestSignal = Math.max(health.activeSessions, chainsWithProviders)
    const requestsServed = Math.max(
      0,
      Math.round(requestSignal * Math.max(0.1, profile.volume)),
    )

    const observedLatencies = health.chains
      .map((chain) => chain.avgLatency)
      .filter((latency): latency is number => latency !== null)
    const observedLatency =
      observedLatencies.length > 0 ? average(observedLatencies) : healthLatencyMs

    const avgResponseTime = Math.max(
      1,
      Math.round(observedLatency * Math.max(0.1, profile.latency)),
    )

    return {
      uptimeScore,
      requestsServed,
      avgResponseTime,
      healthLatencyMs,
      baseUrl,
      details: {
        totalProviders: health.totalProviders,
        activeSessions: health.activeSessions,
        totalChains,
        chainsWithProviders,
      },
    }
  }

  private async collectCdnMetrics(
    baseUrl: string,
    healthLatencyMs: number,
  ): Promise<NodeServiceMetrics> {
    const profile = QOS_VALIDATOR_SERVICE_PROFILES.cdn.metrics

    const [health, stats] = await Promise.all([
      fetchJson<CdnHealthResponse>(
        joinUrl(baseUrl, '/cdn/health'),
        this.config.requestTimeoutMs,
      ),
      fetchJson<CdnStatsResponse>(
        joinUrl(baseUrl, '/cdn/stats'),
        this.config.requestTimeoutMs,
      ),
    ])

    const cacheHitRate = clamp01(stats.hitRate)
    const cacheFillRatio =
      stats.maxEntries > 0 ? clamp01(stats.entries / stats.maxEntries) : 0
    const appCoverage = health.apps.registered > 0 ? 1 : 0
    const serviceQuality = cacheHitRate * 0.5 + cacheFillRatio * 0.2 + appCoverage * 0.3

    const healthRatio = health.status === 'healthy' ? 1 : 0

    const uptimeScore = clampBps(
      (healthRatio * profile.uptime + serviceQuality * (1 - profile.uptime)) *
        10_000,
    )

    const totalRequests = stats.hitCount + stats.missCount
    const requestsServed = Math.max(
      0,
      Math.round(totalRequests * Math.max(0.1, profile.volume)),
    )

    const latencyAdjustment = Math.max(0.25, 1 - cacheHitRate * 0.35)
    const avgResponseTime = Math.max(
      1,
      Math.round(
        healthLatencyMs * Math.max(0.1, profile.latency) * latencyAdjustment,
      ),
    )

    return {
      uptimeScore,
      requestsServed,
      avgResponseTime,
      healthLatencyMs,
      baseUrl,
      details: {
        cacheHitRate,
        cacheEntries: stats.entries,
        totalRequests,
        appsRegistered: health.apps.registered,
      },
    }
  }

  private async collectGenericModuleMetrics(
    baseUrl: string,
    healthLatencyMs: number,
    endpoints: ModuleEndpointPaths,
  ): Promise<NodeServiceMetrics> {
    const module = this.config.module
    const profile = QOS_VALIDATOR_SERVICE_PROFILES[module].metrics

    const healthPromise = fetchJson<GenericHealthResponse>(
      joinUrl(baseUrl, endpoints.healthPath),
      this.config.requestTimeoutMs,
    )
    const statsPromise = endpoints.statsPath
      ? fetchJson<Record<string, unknown>>(
          joinUrl(baseUrl, endpoints.statsPath),
          this.config.requestTimeoutMs,
        ).catch(() => null)
      : Promise.resolve(null)
    const metricsPromise = endpoints.metricsPath
      ? fetchJson<Record<string, unknown>>(
          joinUrl(baseUrl, endpoints.metricsPath),
          this.config.requestTimeoutMs,
        ).catch(() => null)
      : Promise.resolve(null)

    const [health, stats, metrics] = await Promise.all([
      healthPromise,
      statsPromise,
      metricsPromise,
    ])

    const healthRatio = parseHealthRatioFromStatus(health.status)

    const statsNumbers = collectNumberishValues(stats)
    const metricsNumbers = collectNumberishValues(metrics)
    const numericSignal = [...statsNumbers, ...metricsNumbers]
      .map((value) => Math.max(0, value))
      .filter((value) => Number.isFinite(value))
    const requestSignalRaw = numericSignal.length > 0 ? Math.max(...numericSignal) : 0

    const signalRatio = requestSignalRaw > 0 ? clamp01(requestSignalRaw / 100) : 0.1
    const availabilityRatio = stats || metrics ? clamp01(0.6 + signalRatio * 0.4) : 0.7

    const uptimeScore = clampBps(
      (healthRatio * profile.uptime + availabilityRatio * (1 - profile.uptime)) *
        10_000,
    )

    const requestsServed = Math.max(
      0,
      Math.round(requestSignalRaw * Math.max(0.1, profile.volume)),
    )

    const latencyRatio = 1 - Math.min(0.8, signalRatio * 0.6)
    const avgResponseTime = Math.max(
      1,
      Math.round(
        healthLatencyMs * Math.max(0.1, profile.latency) * Math.max(0.25, latencyRatio),
      ),
    )

    return {
      uptimeScore,
      requestsServed,
      avgResponseTime,
      healthLatencyMs,
      baseUrl,
      details: {
        module,
        routePath: endpoints.routePath,
        health,
        stats,
        metrics,
      },
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
    metrics: NodeServiceMetrics,
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
    const oneHourSamples = history.samples.filter((entry) => entry.timestamp >= hourCutoff)

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
      module: this.config.module,
      nodeId,
      updatedAt: nowUnixSeconds,
      latest: {
        uptimeBps: metrics.uptimeScore,
        requestsServed: metrics.requestsServed,
        avgResponseMs: metrics.avgResponseTime,
      },
      avg1h: {
        uptimeBps: this.averageSampleMetric(oneHourSamples, (entry) => entry.uptimeScore),
        requestsServed: this.averageSampleMetric(oneHourSamples, (entry) => entry.requestsServed),
        avgResponseMs: this.averageSampleMetric(oneHourSamples, (entry) => entry.avgResponseTime),
      },
      avg24h: {
        uptimeBps: this.averageSampleMetric(history.samples, (entry) => entry.uptimeScore),
        requestsServed: this.averageSampleMetric(history.samples, (entry) => entry.requestsServed),
        avgResponseMs: this.averageSampleMetric(history.samples, (entry) => entry.avgResponseTime),
      },
      lifetime: {
        daysObserved: lifetimeDays,
        uptimeBps: lifetimeUptimeBps,
      },
    }
  }

  private buildNodeAttestationMetadataSummary(
    attestation: NodeAttestationSnapshot,
    nowUnixSeconds: number,
  ): NodeAttestationMetadataSummary {
    return {
      module: this.config.module,
      nodeId: attestation.nodeId,
      updatedAt: nowUnixSeconds,
      latest: {
        verified: attestation.verified,
        checked: attestation.checked,
        passRateBps: attestation.verified ? 10_000 : 0,
        consecutiveFailures: attestation.consecutiveFailures,
        reason: attestation.reason,
        expectedSigner: attestation.expectedSigner,
        signer: attestation.signer,
        evidenceHash: attestation.evidenceHash,
        endpointOrigin: attestation.endpointOrigin,
      },
      avg1h: {
        passRateBps: attestation.passRate1hBps,
      },
      avg24h: {
        passRateBps: attestation.passRate24hBps,
      },
      lifetimeDays: attestation.lifetimeDaysObserved,
      lifetimePassRateBps: attestation.lifetimePassRateBps,
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
    metrics: NodeServiceMetrics,
  ): Promise<void> {
    if (!this.qosMetadataConsensusAddress) return

    const nowUnixSeconds = Math.floor(Date.now() / 1000)
    const lastPublishedAt = this.lastMetadataPublishAtByNode.get(nodeId) ?? 0
    if (nowUnixSeconds - lastPublishedAt < this.config.metadataPublishIntervalSec) {
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
      `[QoSV:${this.config.module}] Published ${this.config.metadataKey} proposal for node ${nodeId} -> agent ${agentId}`,
    )
  }

  private async publishNodeAttestationMetadata(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
    node: NodeInfoResponse['node'],
    attestation: NodeAttestationSnapshot,
  ): Promise<void> {
    if (!this.qosMetadataConsensusAddress) return

    const nowUnixSeconds = Math.floor(Date.now() / 1000)
    const lastPublishedAt =
      this.lastAttestationMetadataPublishAtByNode.get(nodeId) ?? 0
    if (
      nowUnixSeconds - lastPublishedAt <
      this.config.attestationMetadataPublishIntervalSec
    ) {
      return
    }

    const agentId = await this.resolveNodeAgentId(contractClient, nodeId, node)
    if (agentId === 0n) return

    const summary = this.buildNodeAttestationMetadataSummary(
      attestation,
      nowUnixSeconds,
    )
    const summaryJson = JSON.stringify(summary)
    const summaryHex = `0x${Buffer.from(summaryJson, 'utf8').toString('hex')}` as Hex

    const txHash = await contractClient.client.writeContract({
      address: this.qosMetadataConsensusAddress,
      abi: QOS_METADATA_CONSENSUS_ABI,
      functionName: 'proposeOrApproveMetadataUpdate',
      args: [
        agentId,
        [this.config.attestationMetadataKey],
        [summaryHex],
        BigInt(this.config.metadataProposalDurationSec),
      ],
      chain: this.chain,
      account: contractClient.account,
    })
    await contractClient.publicClient.waitForTransactionReceipt({ hash: txHash })
    this.lastAttestationMetadataPublishAtByNode.set(nodeId, nowUnixSeconds)

    console.log(
      `[QoSV:${this.config.module}] Published ${this.config.attestationMetadataKey} proposal for node ${nodeId} -> agent ${agentId}`,
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
      `[QoSV:${this.config.module}] Registered ${contractClient.address} as QoS Validator`,
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
        `[QoSV:${this.config.module}] Executed staking slash ${slashId} for node ${nodeId}`,
      )
    }

    return executed
  }

  private async hasOpenPendingSlash(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
  ): Promise<boolean> {
    await this.syncPendingSlashIds(contractClient, nodeId)

    const slashIds = this.pendingSlashIdsByNode.get(nodeId)
    if (!slashIds || slashIds.size === 0) return false

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
        slash.nodeId.toLowerCase() !== nodeId.toLowerCase()
      ) {
        slashIds.delete(slashId)
        continue
      }

      return true
    }

    return false
  }

  private async maybeProposeAttestationSlash(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
    attestation: NodeAttestationSnapshot,
  ): Promise<boolean> {
    if (!attestation.checked) return false

    const underPassRate =
      attestation.passRate24hBps <
      this.config.attestationSlashPassRateThresholdBps
    const overConsecutiveFailures =
      attestation.consecutiveFailures >=
      this.config.attestationSlashConsecutiveFailureThreshold
    if (!underPassRate && !overConsecutiveFailures) return false

    const nowUnixSeconds = Math.floor(Date.now() / 1000)
    const lastProposedAt =
      this.lastAttestationSlashProposalAtByNode.get(nodeId) ?? 0
    if (
      nowUnixSeconds - lastProposedAt <
      this.config.attestationSlashProposalCooldownSec
    ) {
      return false
    }

    const hasPendingSlash = await this.hasOpenPendingSlash(contractClient, nodeId)
    if (hasPendingSlash) return false

    try {
      const reason = [
        `QoSV attestation below threshold`,
        `pass24h=${attestation.passRate24hBps}bps`,
        `consecutive=${attestation.consecutiveFailures}`,
        `evidence=${attestation.evidenceHash ?? '0x0'}`,
      ].join('; ')

      const txHash = await contractClient.client.writeContract({
        address: this.nodeStakingAddress,
        abi: NODE_STAKING_MANAGER_ABI,
        functionName: 'slashNode',
        args: [nodeId, BigInt(this.config.attestationSlashBps), reason],
        chain: this.chain,
        account: contractClient.account,
      })
      await contractClient.publicClient.waitForTransactionReceipt({ hash: txHash })
      this.lastAttestationSlashProposalAtByNode.set(nodeId, nowUnixSeconds)
      console.log(
        `[QoSV:${this.config.module}] Proposed staking slash for attestation failure on node ${nodeId}`,
      )
      return true
    } catch (error) {
      console.warn(
        `[QoSV:${this.config.module}] Could not propose attestation slash for ${nodeId}:`,
        error,
      )
      return false
    }
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
    console.log(`[QoSV:${this.config.module}] Enabled AutoSlasher`)
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

export async function runQoSServiceReporter(module: NonStorageQoSModule): Promise<void> {
  const reporter = new QoSServiceReporter(loadQoSServiceReporterConfig(module))

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
