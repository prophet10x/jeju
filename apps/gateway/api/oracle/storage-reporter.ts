import {
  getChainId,
  getContract,
  getCurrentNetwork,
  getRpcUrl,
  type NetworkType,
  tryGetContract,
} from '@jejunetwork/config'
import { createMigrationWalletClient } from '@jejunetwork/kms'
import { NODE_STAKING_MANAGER_ABI } from '../../lib/nodeStaking'
import {
  verifyStorageAuditChunks,
  type StorageAuditChunk,
  type StorageAuditCommitment,
} from './storage-audit-verifier'
import type { Address, Chain, Hex } from 'viem'
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
  submitOnChain: boolean
  registerAsPerformanceOracle: boolean
  enableAutoSlashing: boolean
  checkSlashing: boolean
  executeSlashing: boolean
  runOnce: boolean
  endpointOverrides: Map<string, string>
  allowedNodeIds: Set<Hex> | null
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

const PERFORMANCE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'isPerformanceOracle',
    inputs: [{ name: 'oracle', type: 'address' }],
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
    inputs: [{ name: 'oracle', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
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

export function loadStorageReporterConfig(): StorageReporterConfig {
  const network = (process.env.JEJU_NETWORK as NetworkType | undefined) ?? getCurrentNetwork()
  const chainId = getChainId(network)

  return {
    network,
    chainId,
    rpcUrl: process.env.STORAGE_REPORTER_RPC_URL ?? getRpcUrl(network),
    serviceId: process.env.STORAGE_REPORTER_SERVICE_ID ?? 'storage-reporter',
    fallbackPrivateKey: (process.env.ORACLE_PRIVATE_KEY ??
      process.env.PRIVATE_KEY) as Hex | undefined,
    pollIntervalMs: getEnvInt('STORAGE_REPORTER_POLL_INTERVAL_MS', 15 * 60 * 1000),
    requestTimeoutMs: getEnvInt('STORAGE_REPORTER_REQUEST_TIMEOUT_MS', 15_000),
    lookbackHours: getEnvInt('STORAGE_REPORTER_LOOKBACK_HOURS', 24 * 30),
    maxCommitmentsPerNode: Math.max(
      1,
      getEnvInt('STORAGE_REPORTER_MAX_COMMITMENTS', 5),
    ),
    challengeChunkCount: Math.max(
      1,
      Math.min(16, getEnvInt('STORAGE_REPORTER_CHUNK_COUNT', 3)),
    ),
    submitOnChain: getEnvBool('STORAGE_REPORTER_SUBMIT_ON_CHAIN'),
    registerAsPerformanceOracle: getEnvBool(
      'STORAGE_REPORTER_REGISTER_AS_PERFORMANCE_ORACLE',
    ),
    enableAutoSlashing: getEnvBool('STORAGE_REPORTER_ENABLE_AUTO_SLASHING'),
    checkSlashing: getEnvBool('STORAGE_REPORTER_CHECK_SLASHING'),
    executeSlashing: getEnvBool('STORAGE_REPORTER_EXECUTE_SLASHING'),
    runOnce: getEnvBool('STORAGE_REPORTER_RUN_ONCE'),
    endpointOverrides: parseEndpointOverrides(
      process.env.STORAGE_REPORTER_ENDPOINT_OVERRIDES,
    ),
    allowedNodeIds: parseAllowedNodeIds(process.env.STORAGE_REPORTER_NODE_IDS),
  }
}

export class StorageReporter {
  private readonly config: StorageReporterConfig
  private readonly chain: Chain
  private readonly nodeStakingAddress: Address
  private readonly autoSlasherAddress: Address | null
  private contractClient: Awaited<
    ReturnType<typeof createMigrationWalletClient>
  > | null = null
  private running = false
  private timer?: ReturnType<typeof setInterval>

  constructor(config: StorageReporterConfig) {
    this.config = config
    this.chain = getChain(config.chainId)
    this.nodeStakingAddress = getContract(
      'nodeStaking',
      'manager',
      config.network,
    ) as Address
    const autoSlasher = tryGetContract('nodeStaking', 'autoSlasher', config.network)
    this.autoSlasherAddress = autoSlasher ? (autoSlasher as Address) : null
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
      `[StorageReporter] Starting on ${this.config.network} (${this.config.chainId})`,
    )

    await this.runCycle()

    if (this.config.runOnce) {
      await this.stop()
      return
    }

    this.timer = setInterval(() => {
      void this.runCycle().catch((error) => {
        console.error('[StorageReporter] Cycle failed:', error)
      })
    }, this.config.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    console.log('[StorageReporter] Stopped')
  }

  async runCycle(): Promise<NodeReportResult[]> {
    const contractClient = await this.getContractClient()

    if (this.config.registerAsPerformanceOracle) {
      try {
        await this.ensurePerformanceOracleRegistration(contractClient)
      } catch (error) {
        console.warn(
          '[StorageReporter] Could not register performance oracle:',
          error,
        )
      }
    }
    if (this.config.enableAutoSlashing) {
      try {
        await this.ensureAutoSlashingEnabled(contractClient)
      } catch (error) {
        console.warn(
          '[StorageReporter] Could not enable auto slashing:',
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
          skipped: 'not in STORAGE_REPORTER_NODE_IDS allowlist',
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
      '[StorageReporter] Cycle complete:',
      JSON.stringify(
        results.map((result) => ({
          nodeId: result.nodeId,
          rpcUrl: result.rpcUrl,
          skipped: result.skipped,
          uptimeScore: result.metrics?.uptimeScore,
          requestsServed: result.metrics?.requestsServed,
          avgResponseTime: result.metrics?.avgResponseTime,
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

      const metrics = await this.collectNodeMetrics(nodeId, node.operator, node.rpcUrl)
      result.metrics = metrics

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

        if (this.config.checkSlashing && this.autoSlasherAddress) {
          const slashing = await this.handleSlashing(contractClient, nodeId)
          result.slashingChecked = slashing.checked
          result.slashingProposed = slashing.proposed
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
    const uptimeScore = Math.max(
      0,
      Math.min(10000, Math.round((healthRatio * 0.4 + proofSuccessRatio * 0.6) * 10000)),
    )

    return {
      uptimeScore,
      requestsServed: summary.paidOperations,
      avgResponseTime:
        proofLatencies.length > 0 ? average(proofLatencies) : healthLatencyMs,
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

  private async ensurePerformanceOracleRegistration(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
  ): Promise<void> {
    const isOracle = await contractClient.publicClient.readContract({
      address: this.nodeStakingAddress,
      abi: PERFORMANCE_ORACLE_ABI,
      functionName: 'isPerformanceOracle',
      args: [contractClient.address],
    })

    if (isOracle) return

    const txHash = await contractClient.client.writeContract({
      address: this.nodeStakingAddress,
      abi: PERFORMANCE_ORACLE_ABI,
      functionName: 'addPerformanceOracle',
      args: [contractClient.address],
      chain: this.chain,
      account: contractClient.account,
    })
    await contractClient.publicClient.waitForTransactionReceipt({ hash: txHash })
    console.log(
      `[StorageReporter] Registered ${contractClient.address} as performance oracle`,
    )
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
    console.log('[StorageReporter] Enabled AutoSlasher')
  }

  private async handleSlashing(
    contractClient: Awaited<ReturnType<typeof createMigrationWalletClient>>,
    nodeId: Hex,
  ): Promise<{ checked: boolean; proposed: boolean; executed: boolean }> {
    if (!this.autoSlasherAddress) {
      return { checked: false, proposed: false, executed: false }
    }

    const enabled = await contractClient.publicClient.readContract({
      address: this.autoSlasherAddress,
      abi: AUTO_SLASHER_ABI,
      functionName: 'autoSlashingEnabled',
    })
    if (!enabled) {
      return { checked: false, proposed: false, executed: false }
    }

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
    await contractClient.publicClient.waitForTransactionReceipt({ hash: checkHash })

    const after = (await contractClient.publicClient.readContract({
      address: this.autoSlasherAddress,
      abi: AUTO_SLASHER_ABI,
      functionName: 'slashProposals',
      args: [nodeId],
    })) as unknown as SlashProposal

    let executed = false

    if (
      this.config.executeSlashing &&
      after.proposedAt > before.proposedAt &&
      !after.executed &&
      !after.appealed &&
      after.executesAt <= BigInt(Math.floor(Date.now() / 1000))
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

    return {
      checked: true,
      proposed: after.proposedAt > before.proposedAt,
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
    console.error('[StorageReporter] Fatal error:', error)
    process.exit(1)
  })
}
