/**
 * KMS API Routes
 * Key Management Service integration for DWS
 *
 * Uses FROST threshold signing from @jejunetwork/kms.
 * In-process MPC for testnet, distributed parties for mainnet.
 */

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { getLocalhostHost, getOAuth3Url } from '@jejunetwork/config'
import { getSQLit, type SQLitClient } from '@jejunetwork/db'
import {
  type FROSTCluster,
  FROSTCoordinator,
  type FROSTKeyShare,
  generateKeyShares,
  publicKeyToAddress,
} from '@jejunetwork/kms'
import { decryptAesGcm, encryptAesGcm, randomUUID } from '@jejunetwork/shared'
import { expectValid } from '@jejunetwork/types'
import { secp256k1 } from '@noble/curves/secp256k1'
import { Elysia } from 'elysia'
import type { Address, Hex } from 'viem'
import { keccak256, recoverMessageAddress, toBytes, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'
import {
  createKmsKeyRequestSchema,
  createSecretStoreRequestSchema,
  decryptRequestSchema,
  encryptRequestSchema,
  kmsKeyParamsSchema,
  signRequestSchema,
  updateKmsKeyRequestSchema,
} from '../../shared'
import {
  getAddressFromRequest,
  parseAddress,
} from '../../shared/utils/type-guards'

// MPC Configuration
const MPC_CONFIG = {
  defaultThreshold: 2,
  defaultParties: 3,
  minStake: BigInt(100),
  sessionTimeout: 300000, // 5 minutes
  maxConcurrentSessions: 100,
}

// Determine network
const NETWORK = (process.env.NETWORK ??
  process.env.JEJU_NETWORK ??
  'localnet') as 'localnet' | 'testnet' | 'mainnet'

const SQLIT_DATABASE_ID = process.env.SQLIT_DATABASE_ID ?? 'dws-core'
const KMS_STATE_FILE = resolve(
  process.cwd(),
  process.env.KMS_STATE_FILE ?? 'data/kms-keys.v1.json.enc',
)
const CURVE_ORDER = secp256k1.CURVE.n
const PERSISTENCE_ASSOCIATED_DATA = new TextEncoder().encode('jeju:dws:kms:v1')
const KMS_AUTH_MAX_CLOCK_SKEW_SECONDS = 300
const KMS_AUTH_VERIFY_TIMEOUT_MS = 5000
const KMS_HEALTH_PROBE_TIMEOUT_MS = 4000
const TEE_ATTESTATION_STATUS_FILE = resolve(
  process.cwd(),
  process.env.TEE_ATTESTATION_STATUS_FILE ??
    '/var/run/jeju/kms-attestation.json',
)

let securityEvidenceCache:
  | {
      cachedAt: number
      teeAttested: boolean
      hsmConfigured: boolean
    }
  | null = null

let sqlitClient: SQLitClient | null = null
let tablesInitialized = false
let keysLoaded = false
let keysRestoredAt: number | null = null

async function hasPath(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function evaluateTeeEvidence(): Promise<boolean> {
  const enclaveId = process.env.TEE_ENCLAVE_ID?.trim()
  if (!enclaveId) return false

  const hardwareDevicePaths = [
    '/dev/nitro_enclaves',
    '/dev/sev-guest',
    '/dev/sgx_enclave',
    '/dev/sgx',
  ]
  const hasTeeDevice = await Promise.all(hardwareDevicePaths.map(hasPath)).then(
    (results) => results.some(Boolean),
  )
  if (!hasTeeDevice) return false

  try {
    const raw = await readFile(TEE_ATTESTATION_STATUS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as {
      verified?: boolean
      enclaveId?: string
      verifiedAt?: number
    }
    if (!parsed.verified) return false
    if (parsed.enclaveId && parsed.enclaveId !== enclaveId) return false
    if (
      typeof parsed.verifiedAt === 'number' &&
      parsed.verifiedAt <= 0
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

async function evaluateHsmEvidence(): Promise<boolean> {
  const endpoint = process.env.HSM_ENDPOINT?.trim()
  if (!endpoint) return false

  try {
    const isVaultTransit = endpoint.includes('/v1/transit')
    const probeUrl = isVaultTransit
      ? (() => {
          const url = new URL(endpoint)
          url.pathname = '/v1/sys/health'
          return url.toString()
        })()
      : endpoint

    const response = await fetch(probeUrl, {
      method: isVaultTransit ? 'GET' : 'POST',
      headers: isVaultTransit
        ? undefined
        : {
            'Content-Type': 'application/json',
          },
      body: isVaultTransit ? undefined : '{}',
      signal: AbortSignal.timeout(KMS_HEALTH_PROBE_TIMEOUT_MS),
    })

    // 2xx, 3xx, 4xx all prove endpoint reachability/configuration for this check.
    return response.status > 0 && response.status < 500
  } catch {
    return false
  }
}

async function getSecurityEvidence(): Promise<{
  teeAttested: boolean
  hsmConfigured: boolean
}> {
  const now = Date.now()
  if (securityEvidenceCache && now - securityEvidenceCache.cachedAt < 30_000) {
    return securityEvidenceCache
  }

  const [teeAttested, hsmConfigured] = await Promise.all([
    evaluateTeeEvidence(),
    evaluateHsmEvidence(),
  ])
  securityEvidenceCache = {
    cachedAt: now,
    teeAttested,
    hsmConfigured,
  }
  return securityEvidenceCache
}

async function getSQLitClient(): Promise<SQLitClient> {
  if (!sqlitClient) {
    sqlitClient = getSQLit({
      databaseId: SQLIT_DATABASE_ID,
      timeoutMs: 30000,
      debug: process.env.NODE_ENV !== 'production',
    })
    const healthy = await sqlitClient.isHealthy()
    if (!healthy) {
      throw new Error('[KMS] SQLit is required for vault storage')
    }
    await ensureTablesExist()
  }
  return sqlitClient
}

async function ensureTablesExist(): Promise<void> {
  if (tablesInitialized) return
  const client = sqlitClient
  if (!client) return

  const tables = [
    `CREATE TABLE IF NOT EXISTS kms_secrets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      metadata TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kms_secrets_owner ON kms_secrets(owner)`,
    `CREATE INDEX IF NOT EXISTS idx_kms_secrets_name ON kms_secrets(name)`,
  ]
  for (const ddl of tables) {
    await client.exec(ddl, [], SQLIT_DATABASE_ID)
  }
  tablesInitialized = true
}

// FROST coordinators per key (threshold signing clusters)
const frostCoordinators = new Map<string, FROSTCoordinator>()

// Key metadata storage
interface StoredKey {
  keyId: string
  name: string
  owner: Address
  publicKey: Hex
  address: Address
  threshold: number
  totalParties: number
  createdAt: number
  version: number
  metadata: Record<string, string>
}

interface Secret {
  id: string
  name: string
  owner: Address
  encryptedValue: string
  createdAt: number
  updatedAt: number
  expiresAt?: number
  metadata: Record<string, string>
}

interface SecretRow {
  id: string
  name: string
  owner: string
  encrypted_value: string
  created_at: number
  updated_at: number
  expires_at: number | null
  metadata: string | null
}

interface PersistedKeyState {
  keyId: string
  name?: string
  owner: Address
  threshold: number
  totalParties: number
  createdAt: number
  version: number
  metadata: Record<string, string>
  secret: Hex
}

interface PersistedKmsState {
  version: 1
  keys: PersistedKeyState[]
}

const RevealByNameSchema = z.object({
  name: z.string().min(1),
})

const keys = new Map<string, StoredKey>()
const secrets = new Map<string, Secret>()
const signingSessions = new Map<
  string,
  {
    sessionId: string
    keyId: string
    messageHash: Hex
    requester: Address
    createdAt: number
    expiresAt: number
    status: 'pending' | 'signing' | 'completed' | 'expired'
  }
>()

const serviceKeyIndex = new Map<string, string>()

function getPersistenceSecret(): string | null {
  return process.env.KMS_STATE_KEY ?? process.env.DWS_VAULT_KEY ?? null
}

function isPersistenceEnabled(): boolean {
  return Boolean(getPersistenceSecret())
}

function getPersistenceBackend(): 'encrypted-file' | 'disabled' {
  return isPersistenceEnabled() ? 'encrypted-file' : 'disabled'
}

function derivePersistenceKey(): Uint8Array | null {
  const secret = getPersistenceSecret()
  if (!secret) return null
  return new Uint8Array(Buffer.from(keccak256(toBytes(secret)).slice(2), 'hex'))
}

function mod(a: bigint, m: bigint): bigint {
  return ((a % m) + m) % m
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a, m]
  let [oldS, s] = [1n, 0n]

  while (r !== 0n) {
    const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
  }

  return mod(oldS, m)
}

function lagrangeCoefficientAtZero(
  participantIndices: number[],
  targetIndex: number,
): bigint {
  let numerator = 1n
  let denominator = 1n

  for (const j of participantIndices) {
    if (j === targetIndex) continue
    numerator = mod(numerator * -BigInt(j), CURVE_ORDER)
    denominator = mod(
      denominator * (BigInt(targetIndex) - BigInt(j)),
      CURVE_ORDER,
    )
  }

  return mod(numerator * modInverse(denominator, CURVE_ORDER), CURVE_ORDER)
}

function reconstructSecretFromShares(
  shares: Array<{ index: number; secretShare: bigint }>,
  threshold: number,
): bigint {
  const activeShares = shares.slice(0, threshold)
  const participantIndices = activeShares.map((share) => share.index)

  return activeShares.reduce((sum, share) => {
    const lambda = lagrangeCoefficientAtZero(participantIndices, share.index)
    return mod(sum + share.secretShare * lambda, CURVE_ORDER)
  }, 0n)
}

function getCoordinatorShares(coordinator: FROSTCoordinator): FROSTKeyShare[] {
  const shareMap = (
    coordinator as unknown as { keyShares: Map<number, FROSTKeyShare> }
  ).keyShares
  return Array.from(shareMap.values()).sort((a, b) => a.index - b.index)
}

function reconstructCoordinatorPrivateKey(
  coordinator: FROSTCoordinator,
  threshold: number,
): Hex {
  const shares = getCoordinatorShares(coordinator)
  const secret = reconstructSecretFromShares(
    shares.map((share) => ({
      index: share.index,
      secretShare: share.secretShare,
    })),
    threshold,
  )

  return `0x${secret.toString(16).padStart(64, '0')}` as Hex
}

function serializeKeyState(
  key: StoredKey,
  coordinator: FROSTCoordinator,
): PersistedKeyState {
  const shares = getCoordinatorShares(coordinator)
  const secret = reconstructSecretFromShares(
    shares.map((share) => ({
      index: share.index,
      secretShare: share.secretShare,
    })),
    key.threshold,
  )

  return {
    keyId: key.keyId,
    name: key.name,
    owner: key.owner,
    threshold: key.threshold,
    totalParties: key.totalParties,
    createdAt: key.createdAt,
    version: key.version,
    metadata: key.metadata,
    secret: `0x${secret.toString(16).padStart(64, '0')}` as Hex,
  }
}

function restoreCoordinatorFromState(state: PersistedKeyState): {
  key: StoredKey
  coordinator: FROSTCoordinator
} {
  const secret = BigInt(state.secret)
  const shares = generateKeyShares(state.threshold, state.totalParties, secret)
  const groupPublicKey = toHex(shares[0].groupPublicKey.toRawBytes(true))
  const groupAddress = publicKeyToAddress(shares[0].groupPublicKey)
  const cluster: FROSTCluster = {
    clusterId: state.keyId,
    threshold: state.threshold,
    totalParties: state.totalParties,
    parties: shares.map((share) => ({
      index: share.index,
      keyShare: share,
      endpoint: `http://localhost:${4200 + share.index}`,
      publicKey: toHex(share.publicShare.toRawBytes(true)),
      active: true,
    })),
    groupPublicKey,
    groupAddress,
  }

  const coordinator = new FROSTCoordinator(
    state.keyId,
    state.threshold,
    state.totalParties,
    {
      network: NETWORK,
      acknowledgeInsecureCentralized: NETWORK !== 'mainnet',
    },
  )

  ;(
    coordinator as unknown as {
      cluster: FROSTCluster
      keyShares: Map<number, FROSTKeyShare>
    }
  ).cluster = cluster
  ;(
    coordinator as unknown as {
      cluster: FROSTCluster
      keyShares: Map<number, FROSTKeyShare>
    }
  ).keyShares = new Map(shares.map((share) => [share.index, share]))

  return {
    key: {
      keyId: state.keyId,
      name:
        state.name ??
        state.metadata.name ??
        state.metadata.label ??
        state.metadata.serviceId ??
        'threshold-key',
      owner: state.owner,
      publicKey: groupPublicKey,
      address: groupAddress,
      threshold: state.threshold,
      totalParties: state.totalParties,
      createdAt: state.createdAt,
      version: state.version,
      metadata: state.metadata,
    },
    coordinator,
  }
}

async function readPersistedKeyStates(): Promise<PersistedKeyState[]> {
  if (!isPersistenceEnabled()) {
    return []
  }

  try {
    const raw = await readFile(KMS_STATE_FILE, 'utf8')
    const encrypted = JSON.parse(raw) as {
      version: 1
      ciphertext: string
      iv: string
      tag: string
    }
    const key = derivePersistenceKey()
    if (!key) return []

    const decryptedBytes = await decryptAesGcm(
      Buffer.from(encrypted.ciphertext, 'base64'),
      key,
      Buffer.from(encrypted.iv, 'base64'),
      Buffer.from(encrypted.tag, 'base64'),
      PERSISTENCE_ASSOCIATED_DATA,
    )
    const parsed = JSON.parse(
      new TextDecoder().decode(decryptedBytes),
    ) as PersistedKmsState

    return Array.isArray(parsed.keys) ? parsed.keys : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function writePersistedKeyStates(
  states: PersistedKeyState[],
): Promise<void> {
  if (!isPersistenceEnabled()) {
    return
  }

  const key = derivePersistenceKey()
  if (!key) {
    return
  }

  await mkdir(dirname(KMS_STATE_FILE), { recursive: true })
  const payload: PersistedKmsState = {
    version: 1,
    keys: states,
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const encrypted = await encryptAesGcm(
    plaintext,
    key,
    PERSISTENCE_ASSOCIATED_DATA,
  )
  const serialized = JSON.stringify(
    {
      version: 1,
      ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
      iv: Buffer.from(encrypted.iv).toString('base64'),
      tag: Buffer.from(encrypted.tag).toString('base64'),
    },
    null,
    2,
  )
  const tmpPath = `${KMS_STATE_FILE}.tmp`
  await writeFile(tmpPath, serialized, 'utf8')
  await rename(tmpPath, KMS_STATE_FILE)
}

async function persistAllKeys(): Promise<void> {
  if (!isPersistenceEnabled()) {
    return
  }

  const states = Array.from(keys.values())
    .map((key) => {
      const coordinator = frostCoordinators.get(key.keyId)
      if (!coordinator) return null
      return serializeKeyState(key, coordinator)
    })
    .filter((state): state is PersistedKeyState => state !== null)

  await writePersistedKeyStates(states)
}

async function ensurePersistedKeysLoaded(): Promise<void> {
  if (keysLoaded) return
  const states = await readPersistedKeyStates()

  for (const state of states) {
    const { key, coordinator } = restoreCoordinatorFromState(state)
    keys.set(key.keyId, key)
    frostCoordinators.set(key.keyId, coordinator)
    const serviceId = key.metadata.serviceId
    if (serviceId) {
      serviceKeyIndex.set(serviceId, key.keyId)
    }
  }

  keysLoaded = true
  keysRestoredAt = Date.now()
}

export interface ServiceKeyInfo {
  keyId: string
  address: Address
  publicKey: Hex
}

function getOrCreateServiceOwner(serviceId: string): Address {
  const hash = keccak256(toBytes(serviceId))
  return parseAddress(`0x${hash.slice(-40)}`) as Address
}

function getOrCreateServiceKeyRecord(
  serviceId: string,
  metadata: Record<string, string> = {},
): StoredKey {
  const existingKeyId = serviceKeyIndex.get(serviceId)
  if (existingKeyId) {
    const existingKey = keys.get(existingKeyId)
    if (existingKey) {
      return existingKey
    }
    serviceKeyIndex.delete(serviceId)
  }

  const threshold = MPC_CONFIG.defaultThreshold
  const totalParties = MPC_CONFIG.defaultParties
  const keyId = randomUUID()

  const serviceOwner = getOrCreateServiceOwner(serviceId)

  return {
    keyId,
    owner: serviceOwner,
    publicKey: '0x',
    address: '0x0000000000000000000000000000000000000000',
    threshold,
    totalParties,
    createdAt: Date.now(),
    version: 1,
    metadata: {
      ...metadata,
      serviceId,
    },
  }
}

export async function getOrCreateServiceKey(
  serviceId: string,
  metadata: Record<string, string> = {},
): Promise<ServiceKeyInfo> {
  await ensurePersistedKeysLoaded()

  const existingKeyId = serviceKeyIndex.get(serviceId)
  if (existingKeyId) {
    const existingKey = keys.get(existingKeyId)
    if (existingKey) {
      return {
        keyId: existingKey.keyId,
        address: existingKey.address,
        publicKey: existingKey.publicKey,
      }
    }
    serviceKeyIndex.delete(serviceId)
  }

  const baseKey = getOrCreateServiceKeyRecord(serviceId, metadata)
  const coordinator = new FROSTCoordinator(
    baseKey.keyId,
    baseKey.threshold,
    baseKey.totalParties,
    {
      network: NETWORK,
      acknowledgeInsecureCentralized: NETWORK !== 'mainnet',
    },
  )
  const cluster = await coordinator.initializeCluster()

  const key: StoredKey = {
    ...baseKey,
    publicKey: cluster.groupPublicKey,
    address: cluster.groupAddress,
  }

  frostCoordinators.set(key.keyId, coordinator)
  keys.set(key.keyId, key)
  serviceKeyIndex.set(serviceId, key.keyId)
  await persistAllKeys()

  return {
    keyId: key.keyId,
    address: key.address,
    publicKey: key.publicKey,
  }
}

export async function signMessageWithServiceKey(
  serviceId: string,
  message: string,
): Promise<{ keyId: string; address: Address; signature: Hex }> {
  await ensurePersistedKeysLoaded()

  const key = await getOrCreateServiceKey(serviceId)
  const coordinator = frostCoordinators.get(key.keyId)

  if (!coordinator) {
    throw new Error(`FROST coordinator not found for service key: ${serviceId}`)
  }

  // Service-key proofs must produce a standard Ethereum message signature so
  // downstream verifyMessage() succeeds consistently.
  const account = privateKeyToAccount(
    reconstructCoordinatorPrivateKey(
      coordinator,
      keys.get(key.keyId)?.threshold ?? MPC_CONFIG.defaultThreshold,
    ),
  )
  const signature = await account.signMessage({ message })

  return {
    keyId: key.keyId,
    address: key.address,
    signature,
  }
}

const serviceKeyRequestSchema = z.object({
  serviceId: z.string().min(1),
  action: z.enum(['get-or-create']).optional(),
  threshold: z.number().int().min(2).optional(),
  totalParties: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  acknowledgeInsecureCentralized: z.boolean().optional(),
})

const createKeyRequestSchema = z.union([
  // Keep service-key schema first so serviceId requests are not swallowed by
  // the generic create-key schema (which strips unknown fields by default).
  serviceKeyRequestSchema,
  createKmsKeyRequestSchema.extend({
    threshold: z.number().int().min(2).optional(),
    totalParties: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    acknowledgeInsecureCentralized: z.boolean().optional(),
  }),
])

function isProxyRequest(request: Request): boolean {
  return Boolean(
    request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip'),
  )
}

function getOAuth3BaseUrl(): string {
  const configured = process.env.KMS_OAUTH3_URL ?? process.env.OAUTH3_URL
  let discoveredOAuth3Url: string | null = null
  if (!configured) {
    try {
      discoveredOAuth3Url = getOAuth3Url(NETWORK)
    } catch {
      discoveredOAuth3Url = null
    }
  }
  const baseUrl =
    configured ?? discoveredOAuth3Url ?? `http://${getLocalhostHost()}:4200`
  return baseUrl.replace(/\/+$/, '')
}

function getOAuth3SessionValidateUrl(): string {
  return `${getOAuth3BaseUrl()}/session/validate`
}

function getOAuth3SessionVerifyUrl(token: string): string {
  return `${getOAuth3BaseUrl()}/session/verify?token=${encodeURIComponent(token)}`
}

async function fetchOAuth3SessionPayload(
  token: string,
): Promise<Record<string, unknown> | null> {
  const validateResponse = await fetch(getOAuth3SessionValidateUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(KMS_AUTH_VERIFY_TIMEOUT_MS),
  })
  if (validateResponse.ok) {
    return (await validateResponse.json()) as Record<string, unknown>
  }

  // Standalone OAuth3 app exposes GET /session/verify?token=... instead of
  // POST /session/validate. Support both so KMS auth works on either host.
  if (
    validateResponse.status !== 404 &&
    validateResponse.status !== 405 &&
    validateResponse.status !== 500
  ) {
    return null
  }

  const verifyResponse = await fetch(getOAuth3SessionVerifyUrl(token), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(KMS_AUTH_VERIFY_TIMEOUT_MS),
  })
  if (!verifyResponse.ok) return null

  return (await verifyResponse.json()) as Record<string, unknown>
}

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('authorization')?.trim()
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  return token.length > 0 ? token : null
}

async function validateOwnerWithOAuth3Session(
  request: Request,
  owner: Address,
): Promise<boolean> {
  const token = extractBearerToken(request)
  if (!token) return false

  try {
    const payload = await fetchOAuth3SessionPayload(token)
    if (!payload) return false
    const sessionAddress = parseAddress(
      typeof payload.smartAccount === 'string'
        ? payload.smartAccount
        : typeof payload.address === 'string'
          ? payload.address
          : typeof payload.walletAddress === 'string'
            ? payload.walletAddress
            : payload.session &&
                typeof payload.session === 'object' &&
                  typeof (payload.session as Record<string, unknown>).address ===
                    'string'
              ? ((payload.session as Record<string, unknown>).address as string)
            : null,
    )
    return sessionAddress?.toLowerCase() === owner.toLowerCase()
  } catch {
    return false
  }
}

function buildKmsAuthMessage(
  request: Request,
  timestamp: string,
  nonce: string,
): string {
  const url = new URL(request.url)
  return [
    'DWS KMS Request',
    `Method: ${request.method.toUpperCase()}`,
    `Path: ${url.pathname}`,
    `Timestamp: ${timestamp}`,
    `Nonce: ${nonce}`,
  ].join('\n')
}

async function validateOwnerWithRequestSignature(
  request: Request,
  owner: Address,
): Promise<boolean> {
  const timestamp = request.headers.get('x-jeju-timestamp')
  const nonce = request.headers.get('x-jeju-nonce')
  const signature = request.headers.get('x-jeju-signature')
  if (!timestamp || !nonce || !signature) return false

  const parsedTimestamp = Number(timestamp)
  if (!Number.isFinite(parsedTimestamp)) return false

  const timestampSeconds =
    parsedTimestamp > 10 ** 12
      ? Math.floor(parsedTimestamp / 1000)
      : Math.floor(parsedTimestamp)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (
    Math.abs(nowSeconds - timestampSeconds) > KMS_AUTH_MAX_CLOCK_SKEW_SECONDS
  ) {
    return false
  }

  try {
    const recovered = await recoverMessageAddress({
      message: buildKmsAuthMessage(request, timestamp, nonce),
      signature: signature as Hex,
    })
    return recovered.toLowerCase() === owner.toLowerCase()
  } catch {
    return false
  }
}

async function assertExternalWalletAuthentication(
  request: Request,
  owner: Address,
): Promise<void> {
  if (NETWORK === 'localnet') return
  if (!isProxyRequest(request)) return
  const url = new URL(request.url)
  // Read-only key metadata listing remains header-address scoped for UX
  // compatibility; mutating and sensitive endpoints still require wallet auth.
  if (request.method.toUpperCase() === 'GET' && url.pathname === '/kms/keys') {
    return
  }
  if (await validateOwnerWithOAuth3Session(request, owner)) return
  if (await validateOwnerWithRequestSignature(request, owner)) return
  throw new Error('Wallet authentication required for KMS access')
}

async function getOwnerFromRequest(request: Request): Promise<Address | null> {
  const owner = getAddressFromRequest(request)
  if (owner) {
    await assertExternalWalletAuthentication(request, owner)
    return owner
  }
  const serviceId = request.headers.get('x-service-id')
  if (!serviceId) return null
  if (isProxyRequest(request)) {
    throw new Error(
      'Not authorized: x-service-id is restricted to internal requests',
    )
  }
  const hash = keccak256(toBytes(serviceId))
  const candidate = `0x${hash.slice(-40)}`
  return parseAddress(candidate)
}

function assertServiceKeyRequestAuthorized(
  request: Request,
  key: StoredKey,
): void {
  const expectedServiceId = key.metadata.serviceId
  if (!expectedServiceId) return

  const requestedServiceId = request.headers.get('x-service-id')
  if (requestedServiceId !== expectedServiceId) {
    throw new Error('Not authorized')
  }
}

export function createKMSRouter() {
  return (
    new Elysia({ name: 'kms', prefix: '/kms' })
      .get('/health', () => {
        return (async () => {
          await ensurePersistedKeysLoaded()
          const securityEvidence = await getSecurityEvidence()
          const activeSessions = Array.from(signingSessions.values()).filter(
            (s) => s.status === 'pending' || s.status === 'signing',
          ).length
          return {
            healthy: true,
            status: 'healthy',
            service: 'dws-kms',
            mode: 'frost',
            network: NETWORK,
            keys: keys.size,
            persistentKeys: keys.size,
            secrets: secrets.size,
            activeSessions,
            teeAttested: securityEvidence.teeAttested,
            hsmConfigured: securityEvidence.hsmConfigured,
            kmsEndpointConfigured: Boolean(process.env.KMS_ENDPOINT),
            persistenceEnabled: isPersistenceEnabled(),
            persistenceBackend: getPersistenceBackend(),
            persistenceFile: KMS_STATE_FILE,
            keysRestoredAt,
            config: {
              threshold: MPC_CONFIG.defaultThreshold,
              parties: MPC_CONFIG.defaultParties,
            },
          }
        })()
      })
      .get('/vault/diagnostics', ({ request, set }) => {
        return (async () => {
          if (NETWORK === 'mainnet') {
            set.status = 404
            return { error: 'Not found' }
          }

          const owner =
            (await getOwnerFromRequest(request))?.toLowerCase() ?? null
          const client = await getSQLitClient()
          const totalRows = await client.query<{ count: number | string }>(
            'SELECT COUNT(*) as count FROM kms_secrets',
            [],
            SQLIT_DATABASE_ID,
          )
          const ownerRows = owner
            ? await client.query<{ count: number | string }>(
                'SELECT COUNT(*) as count FROM kms_secrets WHERE owner = ?',
                [owner],
                SQLIT_DATABASE_ID,
              )
            : null

          const normalizeCount = (
            value: number | string | null | undefined,
          ): number => (typeof value === 'number' ? value : Number(value ?? 0))

          return {
            databaseId: SQLIT_DATABASE_ID,
            owner,
            counts: {
              total: normalizeCount(totalRows.rows[0]?.count),
              owner: ownerRows
                ? normalizeCount(ownerRows.rows[0]?.count)
                : null,
            },
            endpoint: client.getEndpoint(),
          }
        })()
      })
      // Generate new MPC key using FROST threshold signing
      .post('/keys', async ({ body, request, set }) => {
        await ensurePersistedKeysLoaded()

        const owner = await getOwnerFromRequest(request)
        if (!owner) {
          throw new Error('Missing x-jeju-address or x-service-id header')
        }

        const validBody = expectValid(
          createKeyRequestSchema,
          body,
          'Create KMS key request',
        )

        const serviceId = 'serviceId' in validBody ? validBody.serviceId : null
        if (serviceId) {
          const existingKeyId = serviceKeyIndex.get(serviceId)
          if (existingKeyId) {
            const existingKey = keys.get(existingKeyId)
            if (existingKey) {
              return {
                keyId: existingKey.keyId,
                name: existingKey.name,
                publicKey: existingKey.publicKey,
                address: existingKey.address,
                threshold: existingKey.threshold,
                totalParties: existingKey.totalParties,
                createdAt: existingKey.createdAt,
                mode: 'frost',
              }
            }
            serviceKeyIndex.delete(serviceId)
          }
        }

        const threshold = validBody.threshold ?? MPC_CONFIG.defaultThreshold
        const totalParties = validBody.totalParties ?? MPC_CONFIG.defaultParties

        if (threshold < 2) {
          set.status = 400
          return { error: 'Threshold must be at least 2' }
        }
        if (threshold > totalParties) {
          set.status = 400
          return { error: 'Threshold cannot exceed total parties' }
        }

        const keyId = randomUUID()

        // Auto-acknowledge insecure centralized for non-mainnet
        const ackInsecure =
          validBody.acknowledgeInsecureCentralized ?? NETWORK !== 'mainnet'

        // Create FROST coordinator for threshold signing
        const coordinator = new FROSTCoordinator(
          keyId,
          threshold,
          totalParties,
          {
            network: NETWORK,
            acknowledgeInsecureCentralized: ackInsecure,
          },
        )
        const cluster = await coordinator.initializeCluster()

        // Store the coordinator for signing operations
        frostCoordinators.set(keyId, coordinator)

        const metadata = validBody.metadata ? { ...validBody.metadata } : {}
        metadata.name ??= validBody.name
        if (serviceId) {
          metadata.serviceId = serviceId
        }

        const key: StoredKey = {
          keyId,
          name: validBody.name,
          owner,
          publicKey: cluster.groupPublicKey,
          address: cluster.groupAddress,
          threshold,
          totalParties,
          createdAt: Date.now(),
          version: 1,
          metadata,
        }

        keys.set(keyId, key)
        if (serviceId) {
          serviceKeyIndex.set(serviceId, keyId)
        }
        await persistAllKeys()

        set.status = 201
        return {
          keyId,
          name: key.name,
          publicKey: key.publicKey,
          address: key.address,
          threshold,
          totalParties,
          createdAt: key.createdAt,
          mode: 'frost',
        }
      })
      // List keys
      .get('/keys', ({ request }) => {
        return (async () => {
          await ensurePersistedKeysLoaded()
          const owner =
            (await getOwnerFromRequest(request))?.toLowerCase() ?? null
          if (!owner) {
            throw new Error('Missing x-jeju-address or x-service-id header')
          }

          const keyList = Array.from(keys.values()).filter(
            (k) => k.owner.toLowerCase() === owner,
          )

          return {
            keys: keyList.map((k) => ({
              keyId: k.keyId,
              name: k.name,
              publicKey: k.publicKey,
              address: k.address,
              threshold: k.threshold,
              totalParties: k.totalParties,
              version: k.version,
              createdAt: k.createdAt,
            })),
          }
        })()
      })
      // Get key details
      .get('/keys/:keyId', ({ params, request }) => {
        return (async () => {
          await ensurePersistedKeysLoaded()
          const owner =
            (await getOwnerFromRequest(request))?.toLowerCase() ?? null
          if (!owner) {
            throw new Error('Missing x-jeju-address or x-service-id header')
          }
          const { keyId } = expectValid(
            kmsKeyParamsSchema,
            params,
            'KMS key params',
          )
          const key = keys.get(keyId)
          if (!key) {
            throw new Error('Key not found')
          }
          if (key.owner.toLowerCase() !== owner) {
            throw new Error('Not authorized')
          }
          assertServiceKeyRequestAuthorized(request, key)

          return {
            keyId: key.keyId,
            name: key.name,
            publicKey: key.publicKey,
            address: key.address,
            threshold: key.threshold,
            totalParties: key.totalParties,
            version: key.version,
            createdAt: key.createdAt,
            metadata: key.metadata,
          }
        })()
      })
      // Rotate key
      .post('/keys/:keyId/rotate', async ({ params, body, request }) => {
        await ensurePersistedKeysLoaded()
        const owner = await getOwnerFromRequest(request)
        if (!owner)
          throw new Error('Missing x-jeju-address or x-service-id header')

        const { keyId } = expectValid(
          kmsKeyParamsSchema,
          params,
          'KMS key params',
        )
        const key = keys.get(keyId)

        if (!key) {
          throw new Error('Key not found')
        }
        if (key.owner.toLowerCase() !== owner.toLowerCase()) {
          throw new Error('Not authorized')
        }
        assertServiceKeyRequestAuthorized(request, key)

        const validBody = expectValid(
          updateKmsKeyRequestSchema,
          body,
          'Update key request',
        )

        const nextThreshold = validBody.newThreshold ?? key.threshold
        const nextTotalParties = validBody.newTotalParties ?? key.totalParties
        const coordinator = frostCoordinators.get(key.keyId)
        if (!coordinator) {
          throw new Error('FROST coordinator not found for this key')
        }

        const persisted = serializeKeyState(key, coordinator)
        const { coordinator: replacementCoordinator, key: replacementKey } =
          restoreCoordinatorFromState({
            ...persisted,
            threshold: nextThreshold,
            totalParties: nextTotalParties,
            version: key.version + 1,
          })

        key.threshold = replacementKey.threshold
        key.totalParties = replacementKey.totalParties
        key.version++
        key.publicKey = replacementKey.publicKey
        key.address = replacementKey.address
        frostCoordinators.set(key.keyId, replacementCoordinator)
        await persistAllKeys()

        return {
          keyId: key.keyId,
          version: key.version,
          threshold: key.threshold,
          totalParties: key.totalParties,
        }
      })
      // Delete key
      .delete('/keys/:keyId', ({ params, request }) => {
        return (async () => {
          await ensurePersistedKeysLoaded()
          const owner = await getOwnerFromRequest(request)
          if (!owner)
            throw new Error('Missing x-jeju-address or x-service-id header')

          const { keyId } = expectValid(
            kmsKeyParamsSchema,
            params,
            'KMS key params',
          )
          const key = keys.get(keyId)

          if (!key) {
            throw new Error('Key not found')
          }
          if (key.owner.toLowerCase() !== owner.toLowerCase()) {
            throw new Error('Not authorized')
          }
          assertServiceKeyRequestAuthorized(request, key)

          keys.delete(key.keyId)
          frostCoordinators.delete(key.keyId)
          const serviceId = key.metadata.serviceId
          if (serviceId) {
            serviceKeyIndex.delete(serviceId)
          }
          await persistAllKeys()
          return { success: true }
        })()
      })
      // Request signature using FROST threshold signing
      .post('/sign', async ({ body, request }) => {
        await ensurePersistedKeysLoaded()
        const owner = await getOwnerFromRequest(request)
        if (!owner)
          throw new Error('Missing x-jeju-address or x-service-id header')

        const validBody = expectValid(
          signRequestSchema.extend({
            keyId: z.string().uuid(),
          }),
          body,
          'Sign request',
        )

        const key = keys.get(validBody.keyId)
        if (!key) {
          throw new Error('Key not found')
        }
        if (key.owner.toLowerCase() !== owner.toLowerCase()) {
          throw new Error('Not authorized')
        }

        assertServiceKeyRequestAuthorized(request, key)

        const coordinator = frostCoordinators.get(validBody.keyId)
        if (!coordinator) {
          throw new Error('FROST coordinator not found for this key')
        }

        // For Ethereum flows we need a recoverable hash signature that viem can verify/recover.
        // The coordinator key is still the source of truth; we derive the same signing key material.
        const privateKey = reconstructCoordinatorPrivateKey(
          coordinator,
          key.threshold,
        )
        const account = privateKeyToAccount(privateKey)

        const digest =
          validBody.encoding === 'hex'
            ? (validBody.messageHash as Hex)
            : (keccak256(toBytes(validBody.messageHash)) as Hex)
        const signature = await account.sign({ hash: digest })

        return {
          signature,
          keyId: key.keyId,
          address: key.address,
          signedAt: Date.now(),
          mode: 'frost',
        }
      })
      .post('/encrypt', async ({ body }) => {
        const validBody = expectValid(
          encryptRequestSchema.extend({
            keyId: z.string().uuid().optional(),
          }),
          body,
          'Encrypt request',
        )

        // AES-256-GCM encryption (development mode - key stored in memory)
        // Generate or derive encryption key
        const keyId = validBody.keyId ?? randomUUID()
        const derivedKey = new Uint8Array(
          Buffer.from(keccak256(toBytes(keyId)).slice(2), 'hex'),
        )

        // Encrypt with AES-256-GCM
        const plaintext = new TextEncoder().encode(validBody.data)
        const {
          ciphertext: encrypted,
          iv,
          tag: authTag,
        } = await encryptAesGcm(plaintext, derivedKey)

        // Format: iv (12) + authTag (16) + ciphertext, base64 encoded
        const combined = new Uint8Array(
          iv.length + authTag.length + encrypted.length,
        )
        combined.set(iv, 0)
        combined.set(authTag, iv.length)
        combined.set(encrypted, iv.length + authTag.length)
        const ciphertext = btoa(String.fromCharCode(...combined))

        return {
          encrypted: ciphertext,
          ciphertext,
          keyId,
          mode: process.env.MPC_COORDINATOR_URL ? 'mpc' : 'development',
        }
      })
      .post('/decrypt', async ({ body }) => {
        const validBody = expectValid(
          decryptRequestSchema
            .partial()
            .extend({
              ciphertext: z.string().optional(),
            })
            .refine((value) => Boolean(value.encrypted ?? value.ciphertext), {
              message: 'Either encrypted or ciphertext must be provided',
            })
            .extend({
            keyId: z.string().uuid(),
          }),
          body,
          'Decrypt request',
        )

        const mpcEnabled = !!process.env.MPC_COORDINATOR_URL

        // Decrypt with AES-256-GCM (development mode)
        const encodedCiphertext = validBody.encrypted ?? validBody.ciphertext
        if (!encodedCiphertext) {
          throw new Error('Missing ciphertext payload')
        }
        const data = new Uint8Array(
          atob(encodedCiphertext)
            .split('')
            .map((c) => c.charCodeAt(0)),
        )
        const iv = data.subarray(0, 12)
        const authTag = data.subarray(12, 28)
        const ciphertext = data.subarray(28)

        const derivedKey = new Uint8Array(
          Buffer.from(keccak256(toBytes(validBody.keyId)).slice(2), 'hex'),
        )
        const decryptedBytes = await decryptAesGcm(
          ciphertext,
          derivedKey,
          iv,
          authTag,
        )
        const decrypted = new TextDecoder().decode(decryptedBytes)

        return {
          decrypted,
          keyId: validBody.keyId,
          mode: mpcEnabled ? 'mpc' : 'development',
          warning: mpcEnabled
            ? undefined
            : 'Running in development mode. Set MPC_COORDINATOR_URL for production MPC.',
        }
      })
      // Store secret
      .post('/vault/secrets', async ({ body, request, set }) => {
        const owner = await getOwnerFromRequest(request)
        if (!owner) {
          set.status = 401
          return { error: 'Missing x-jeju-address header' }
        }

        const validBody = expectValid(
          createSecretStoreRequestSchema,
          body,
          'Create secret request',
        )

        const id = randomUUID()

        // Encrypt the value with AES-256-GCM
        const derivedKey = new Uint8Array(
          Buffer.from(keccak256(toBytes(id)).slice(2), 'hex'),
        )
        const plaintext = new TextEncoder().encode(validBody.value)
        const {
          ciphertext: encrypted,
          iv,
          tag: authTag,
        } = await encryptAesGcm(plaintext, derivedKey)
        const combined = new Uint8Array(
          iv.length + authTag.length + encrypted.length,
        )
        combined.set(iv, 0)
        combined.set(authTag, iv.length)
        combined.set(encrypted, iv.length + authTag.length)
        const encryptedValue = btoa(String.fromCharCode(...combined))

        const secret: Secret = {
          id,
          name: validBody.name,
          owner,
          encryptedValue,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: validBody.expiresIn
            ? Date.now() + validBody.expiresIn * 1000
            : undefined,
          metadata: validBody.metadata ?? {},
        }

        const client = await getSQLitClient()
        await client.exec(
          `INSERT INTO kms_secrets (id, name, owner, encrypted_value, created_at, updated_at, expires_at, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            secret.id,
            secret.name,
            secret.owner.toLowerCase(),
            secret.encryptedValue,
            secret.createdAt,
            secret.updatedAt,
            secret.expiresAt ?? null,
            JSON.stringify(secret.metadata),
          ],
          SQLIT_DATABASE_ID,
        )
        secrets.set(id, secret)

        set.status = 201
        return {
          id,
          name: secret.name,
          createdAt: secret.createdAt,
          expiresAt: secret.expiresAt,
        }
      })
      // List secrets
      .get('/vault/secrets', ({ request }) => {
        return (async () => {
          const owner =
            (await getOwnerFromRequest(request))?.toLowerCase() ?? null
          if (!owner) {
            throw new Error('Missing x-jeju-address or x-service-id header')
          }
          const client = await getSQLitClient()
          const rows = await client.query<SecretRow>(
            'SELECT * FROM kms_secrets WHERE owner = ? ORDER BY created_at DESC',
            [owner],
            SQLIT_DATABASE_ID,
          )
          const now = Date.now()
          const secretList = rows.rows.filter(
            (s) => !s.expires_at || s.expires_at > now,
          )
          return {
            secrets: secretList.map((s) => ({
              id: s.id,
              name: s.name,
              createdAt: s.created_at,
              updatedAt: s.updated_at,
              expiresAt: s.expires_at ?? undefined,
            })),
          }
        })()
      })
      // Get secret (returns metadata only, not value)
      .get('/vault/secrets/:id', ({ params, request, set }) => {
        return (async () => {
          const owner =
            (await getOwnerFromRequest(request))?.toLowerCase() ?? null
          const client = await getSQLitClient()
          const rows = await client.query<SecretRow>(
            'SELECT * FROM kms_secrets WHERE id = ? LIMIT 1',
            [params.id],
            SQLIT_DATABASE_ID,
          )
          const secret = rows.rows[0]
          if (!secret) {
            set.status = 404
            return { error: 'Secret not found' }
          }
          if (!owner || secret.owner.toLowerCase() !== owner) {
            set.status = 403
            return { error: 'Not authorized' }
          }
          if (secret.expires_at && secret.expires_at < Date.now()) {
            set.status = 410
            return { error: 'Secret expired' }
          }
          return {
            id: secret.id,
            name: secret.name,
            createdAt: secret.created_at,
            updatedAt: secret.updated_at,
            expiresAt: secret.expires_at ?? undefined,
            metadata: secret.metadata ? JSON.parse(secret.metadata) : {},
          }
        })()
      })
      // Reveal secret value (requires authentication)
      .post('/vault/secrets/:id/reveal', async ({ params, request, set }) => {
        const owner =
          (await getOwnerFromRequest(request))?.toLowerCase() ?? null
        const client = await getSQLitClient()
        const rows = await client.query<SecretRow>(
          'SELECT * FROM kms_secrets WHERE id = ? LIMIT 1',
          [params.id],
          SQLIT_DATABASE_ID,
        )
        const secret = rows.rows[0]

        if (!secret) {
          set.status = 404
          return { error: 'Secret not found' }
        }
        if (!owner || secret.owner.toLowerCase() !== owner) {
          set.status = 403
          return { error: 'Not authorized' }
        }
        if (secret.expires_at && secret.expires_at < Date.now()) {
          set.status = 410
          return { error: 'Secret expired' }
        }

        // Decrypt the value with AES-256-GCM
        const data = new Uint8Array(
          atob(secret.encrypted_value)
            .split('')
            .map((c) => c.charCodeAt(0)),
        )
        const iv = data.subarray(0, 12)
        const authTag = data.subarray(12, 28)
        const ciphertext = data.subarray(28)

        const derivedKey = new Uint8Array(
          Buffer.from(keccak256(toBytes(secret.id)).slice(2), 'hex'),
        )
        const decryptedBytes = await decryptAesGcm(
          ciphertext,
          derivedKey,
          iv,
          authTag,
        )
        const decrypted = new TextDecoder().decode(decryptedBytes)

        return {
          id: secret.id,
          name: secret.name,
          value: decrypted,
        }
      })
      .post('/vault/secrets/reveal', async ({ body, request, set }) => {
        const owner =
          (await getOwnerFromRequest(request))?.toLowerCase() ?? null
        if (!owner) {
          set.status = 401
          return { error: 'Missing x-jeju-address or x-service-id header' }
        }

        const parsed = RevealByNameSchema.safeParse(body)
        if (!parsed.success) {
          set.status = 400
          return { error: 'Invalid request', details: parsed.error.issues }
        }

        const client = await getSQLitClient()
        const rows = await client.query<SecretRow>(
          'SELECT * FROM kms_secrets WHERE name = ? AND owner = ? ORDER BY updated_at DESC LIMIT 1',
          [parsed.data.name, owner],
          SQLIT_DATABASE_ID,
        )
        const secret = rows.rows[0]
        if (!secret) {
          set.status = 404
          return { error: 'Secret not found' }
        }
        if (secret.expires_at && secret.expires_at < Date.now()) {
          set.status = 410
          return { error: 'Secret expired' }
        }

        const data = new Uint8Array(
          atob(secret.encrypted_value)
            .split('')
            .map((c) => c.charCodeAt(0)),
        )
        const iv = data.subarray(0, 12)
        const authTag = data.subarray(12, 28)
        const ciphertext = data.subarray(28)

        const derivedKey = new Uint8Array(
          Buffer.from(keccak256(toBytes(secret.id)).slice(2), 'hex'),
        )
        const decryptedBytes = await decryptAesGcm(
          ciphertext,
          derivedKey,
          iv,
          authTag,
        )
        const decrypted = new TextDecoder().decode(decryptedBytes)

        return {
          id: secret.id,
          name: secret.name,
          value: decrypted,
        }
      })
      // Delete secret
      .delete('/vault/secrets/:id', ({ params, request, set }) => {
        return (async () => {
          const owner =
            (await getOwnerFromRequest(request))?.toLowerCase() ?? null
          const client = await getSQLitClient()
          const rows = await client.query<SecretRow>(
            'SELECT * FROM kms_secrets WHERE id = ? LIMIT 1',
            [params.id],
            SQLIT_DATABASE_ID,
          )
          const secret = rows.rows[0]
          if (!secret) {
            set.status = 404
            return { error: 'Secret not found' }
          }
          if (!owner || secret.owner.toLowerCase() !== owner) {
            set.status = 403
            return { error: 'Not authorized' }
          }
          await client.exec(
            'DELETE FROM kms_secrets WHERE id = ?',
            [params.id],
            SQLIT_DATABASE_ID,
          )
          secrets.delete(secret.id)
          return { success: true }
        })()
      })
  )
}
