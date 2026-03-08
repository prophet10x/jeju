/**
 * Storage Routes - Multi-backend storage API
 *
 * Features:
 * - Content tiering (System, Popular, Private)
 * - Multi-backend selection (IPFS, Arweave, WebTorrent)
 * - Encryption support
 * - Popularity tracking
 * - Regional prefetching
 * - IPFS-compatible API
 * - Content moderation before upload (CSAM, malware, illegal content)
 */

// Network configuration handled internally by MultiBackendManager
import { isProductionEnv } from '@jejunetwork/config'
import {
  ContentModerationPipeline,
  type ModerationResult,
} from '@jejunetwork/shared'
import { getFormString, getFormStringOr } from '@jejunetwork/types'
import { Elysia, t } from 'elysia'
import type { Address } from 'viem'
import { z } from 'zod'
import { getDWSReputationAdapter } from '../../moderation/reputation-adapter'

// Generic JSON value schema for user-uploaded content
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

import { extractClientRegion } from '../../shared/utils/common'
import {
  storageActivityState,
  storageCommitmentState,
  storagePinState,
} from '../../state'
import type { BackendManager } from '../../storage/backends'
import {
  getAuditChunks,
  pickRandomChunkIndices,
} from '../../storage/audit'
import { getMultiBackendManager } from '../../storage/multi-backend'
import {
  type StoragePaymentOperation,
  processStoragePayment,
} from '../../storage/payments'
import type {
  ContentCategory,
  StorageAccessClass,
  ContentTier,
  ContentAuditCommitment,
  StorageBackendType,
} from '../../storage/types'

// ============ Content Moderation ============

/**
 * Determine content type from filename/mime type
 */
function getContentType(
  filename: string,
  mimeType?: string,
): 'image' | 'video' | 'text' | 'file' {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const mime = mimeType?.toLowerCase() ?? ''

  if (
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext) ||
    mime.startsWith('image/')
  ) {
    return 'image'
  }

  if (
    ['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(ext) ||
    mime.startsWith('video/')
  ) {
    return 'video'
  }

  if (
    ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts'].includes(ext) ||
    mime.startsWith('text/')
  ) {
    return 'text'
  }

  return 'file'
}

function shouldModerateUpload(filename: string, category: string): boolean {
  if (category !== 'app') return true
  const lower = filename.toLowerCase()
  return !(
    lower.endsWith('.js') ||
    lower.endsWith('.css') ||
    lower.endsWith('.html') ||
    lower.endsWith('.json') ||
    lower.endsWith('.map') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.svg')
  )
}

// Singleton pipeline with reputation provider
let moderationPipeline: ContentModerationPipeline | null = null

function getModerationPipeline(): ContentModerationPipeline {
  if (!moderationPipeline) {
    const isProduction = isProductionEnv()

    // SECURITY NOTE: In production, these API keys should be stored in KMS
    // and accessed via the API marketplace key vault, not env vars.
    // For now, log warnings about direct env var usage.
    if (isProduction) {
      if (process.env.OPENAI_API_KEY) {
        console.warn(
          '[Storage] WARNING: Using OPENAI_API_KEY from env. Consider using API marketplace vault.',
        )
      }
      if (process.env.AWS_SECRET_ACCESS_KEY) {
        // Removed - AWS credentials should not be used in decentralized deployment
      }
    }

    moderationPipeline = new ContentModerationPipeline({
      reputationProvider: getDWSReputationAdapter(),
      openai: process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : undefined,
      hive: process.env.HIVE_API_KEY
        ? { apiKey: process.env.HIVE_API_KEY }
        : undefined,
    })
  }
  return moderationPipeline
}

/**
 * Moderate content before upload
 * Returns moderation result - caller should handle blocking/warning
 */
async function moderateUpload(
  content: Buffer,
  filename: string,
  senderAddress?: string,
): Promise<ModerationResult> {
  const pipeline = getModerationPipeline()
  const contentType = getContentType(filename)

  return pipeline.moderate({
    content,
    contentType,
    senderAddress: senderAddress as Address | undefined,
  })
}

// Deterrence messages for CSAM blocks per UK Government guidance
const DETERRENCE_MESSAGES = {
  csam: {
    warning: `⚠️ WARNING: Child sexual abuse material (CSAM) is illegal.

Viewing, possessing, or distributing CSAM is a serious criminal offense
that carries severe penalties including imprisonment.

If you or someone you know needs help, please contact:
• Stop It Now: 0808 1000 900 (UK) / 1-888-773-8368 (US)
• NCMEC CyberTipline: 1-800-843-5678
• Childhelp: 1-800-422-4453

This activity has been logged and may be reported to authorities.`,
    blocked: `🚫 ACCESS BLOCKED

This content has been identified as illegal child sexual abuse material.

This incident has been logged and will be reported to:
• National Center for Missing & Exploited Children (NCMEC)
• Internet Watch Foundation (IWF)
• Relevant law enforcement authorities

Attempting to access illegal content is a criminal offense.`,
  },
  support: {
    uk: [
      {
        name: 'Stop It Now UK',
        phone: '0808 1000 900',
        url: 'https://www.stopitnow.org.uk/',
      },
      {
        name: 'Childline',
        phone: '0800 1111',
        url: 'https://www.childline.org.uk/',
      },
    ],
    us: [
      {
        name: 'Stop It Now USA',
        phone: '1-888-773-8368',
        url: 'https://www.stopitnow.org/',
      },
      {
        name: 'NCMEC CyberTipline',
        phone: '1-800-843-5678',
        url: 'https://www.missingkids.org/',
      },
    ],
  },
}

/**
 * Build error response for moderation failure
 */
function buildModerationErrorResponse(result: ModerationResult): {
  error: string
  code: string
  category?: string
  severity: string
  reviewRequired: boolean
  deterrence?: {
    message: string
    support: typeof DETERRENCE_MESSAGES.support
  }
} {
  const isCSAM = result.primaryCategory === 'csam'

  return {
    error: isCSAM
      ? DETERRENCE_MESSAGES.csam.blocked
      : result.action === 'ban'
        ? 'Content violates platform policies and has been reported'
        : result.action === 'block'
          ? 'Content blocked due to policy violation'
          : 'Content flagged for review',
    code:
      result.action === 'ban'
        ? 'CONTENT_BANNED'
        : result.action === 'block'
          ? 'CONTENT_BLOCKED'
          : 'CONTENT_FLAGGED',
    category: result.primaryCategory,
    severity: result.severity,
    reviewRequired: result.reviewRequired,
    deterrence: isCSAM
      ? {
          message: DETERRENCE_MESSAGES.csam.blocked,
          support: DETERRENCE_MESSAGES.support,
        }
      : undefined,
  }
}

// Type-safe query param accessor
function getQueryInt(
  query: Record<string, string | undefined>,
  key: string,
  defaultVal: number,
): number {
  const val = query[key]
  return val !== undefined ? parseInt(val, 10) : defaultVal
}

function requiresStoragePayment(tier?: ContentTier): boolean {
  return tier !== 'system'
}

function resolveAccessClass(
  requested: string | undefined,
  tier: ContentTier | undefined,
  encrypt: boolean,
): StorageAccessClass {
  if (requested === 'SYSTEM_PUBLIC') return requested
  if (requested === 'PRIVATE_OWNER') return requested
  if (requested === 'MANAGED_EXECUTION') return requested

  if (tier === 'private' || encrypt) {
    return 'PRIVATE_OWNER'
  }

  return 'SYSTEM_PUBLIC'
}

function resolveTier(
  requestedTier: ContentTier | undefined,
  accessClass: StorageAccessClass,
): ContentTier {
  if (accessClass === 'SYSTEM_PUBLIC') {
    if (requestedTier === 'popular') {
      return 'popular'
    }
    return 'system'
  }

  return 'private'
}

function clampReplicaRequest(requested: number | undefined): number | undefined {
  if (requested === undefined || !Number.isFinite(requested)) {
    return undefined
  }

  const rounded = Math.floor(requested)
  if (rounded <= 0) {
    return undefined
  }

  return Math.max(4, Math.min(10, rounded))
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isKmsFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('KMS') || error.message.includes('encrypted'))
  )
}

function toUploadErrorResponse(
  set: { status?: number | string },
  error: unknown,
): { error: string } {
  if (error instanceof Error) {
    set.status = isKmsFailure(error) ? 503 : 400
    return { error: error.message }
  }

  set.status = 500
  return { error: 'Unexpected storage error' }
}

function paymentRequiredResponse(
  set: { status?: number | string; headers: Record<string, string | number> },
  requirement: unknown,
  error?: string,
) {
  set.status = 402
  set.headers['X-Payment-Required'] = 'true'
  return {
    x402Version: 1,
    error: error ?? 'Payment required',
    accepts: requirement,
  }
}

async function maybeChargeStorage(params: {
  set: { status?: number | string; headers: Record<string, string | number> }
  paymentHeader?: string | null
  userAddress?: string | null
  tier?: ContentTier
  operation: StoragePaymentOperation
  sizeBytes: number
  resource: string
}): Promise<
  | {
      ok: true
      amountWei: bigint
      scheme: 'free' | 'credit' | 'x402'
      payer?: string
    }
  | { ok: false; response: unknown }
> {
  if (!requiresStoragePayment(params.tier)) {
    return { ok: true, amountWei: 0n, scheme: 'free', payer: params.userAddress ?? undefined }
  }

  const payment = await processStoragePayment({
    paymentHeader: params.paymentHeader ?? undefined,
    userAddress: params.userAddress ?? undefined,
    operation: params.operation,
    sizeBytes: params.sizeBytes,
    resource: params.resource,
  })

  if (!payment.allowed) {
    return {
      ok: false,
      response: paymentRequiredResponse(
        params.set,
        payment.requirement?.accepts ?? [],
        payment.error,
      ),
    }
  }

  return {
    ok: true,
    amountWei: payment.amountWei,
    scheme: payment.scheme,
    payer: payment.payer?.toString(),
  }
}

async function resolveStoredContentInfo(
  storageManager: ReturnType<typeof getMultiBackendManager>,
  cid: string,
): Promise<{
  sizeBytes: number
  tier?: ContentTier
  category?: ContentCategory
  owner?: string
}> {
  const metadata = storageManager.getMetadata(cid)
  if (metadata) {
    return {
      sizeBytes: metadata.size,
      tier: metadata.tier,
      category: metadata.category,
      owner: metadata.owner,
    }
  }

  const pin = await storagePinState.get(cid)
  if (pin) {
    return {
      sizeBytes: pin.size_bytes,
      tier: pin.tier as ContentTier,
      owner: pin.owner,
    }
  }

  return { sizeBytes: 0 }
}

async function persistStoredUpload(params: {
  storageManager: ReturnType<typeof getMultiBackendManager>
  cid: string
  filename: string
  sizeBytes: number
  backend?: string
  tier: ContentTier
  category: ContentCategory
  senderAddress?: string | null
  permanent?: boolean
  payment: {
    amountWei: bigint
    scheme: 'free' | 'credit' | 'x402'
    payer?: string
  }
}): Promise<void> {
  const metadata = params.storageManager.getMetadata(params.cid)

  if (metadata && params.senderAddress) {
    metadata.owner = params.senderAddress as Address
  }

  if (params.senderAddress) {
    await storagePinState.save({
      cid: params.cid,
      name: params.filename,
      sizeBytes: params.sizeBytes,
      backend: params.backend ?? 'ipfs',
      tier: params.tier,
      owner: params.senderAddress as Address,
      permanent: params.permanent,
    })
  }

  if (metadata?.audit) {
    await storageCommitmentState.save({
      cid: params.cid,
      owner: params.senderAddress ?? metadata.owner,
      tier: metadata.tier,
      category: metadata.category,
      backend: params.backend ?? metadata.addresses.backends[0],
      sizeBytes: metadata.size,
      chunkSize: metadata.audit.chunkSize,
      chunkCount: metadata.audit.chunkCount,
      storedSha256: metadata.audit.storedSha256,
      commitment: metadata.audit.commitment,
      merkleRoot: metadata.audit.merkleRoot,
      auditTimestamp: metadata.audit.timestamp,
    })
  }

  await storageActivityState.save({
    cid: params.cid,
    operation: params.permanent ? 'permanent-upload' : 'upload',
    owner: params.senderAddress ?? metadata?.owner,
    payer: params.payment.payer,
    paymentScheme: params.payment.scheme,
    amountWei: params.payment.amountWei,
    sizeBytes: params.sizeBytes,
    tier: params.tier,
    category: params.category,
    backend: params.backend,
  })
}

async function resolveStoredCommitment(
  storageManager: ReturnType<typeof getMultiBackendManager>,
  cid: string,
): Promise<
  | {
      cid: string
      owner?: string | null
      tier?: string | null
      category?: string | null
      backend?: string | null
      sizeBytes: number
      audit: ContentAuditCommitment
      createdAt: number
      updatedAt: number
    }
  | null
> {
  const stored = await storageCommitmentState.get(cid)
  if (stored) {
    return {
      cid: stored.cid,
      owner: stored.owner,
      tier: stored.tier,
      category: stored.category,
      backend: stored.backend,
      sizeBytes: stored.size_bytes,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
      audit: {
        commitment: stored.commitment as `0x${string}`,
        merkleRoot: stored.merkle_root as `0x${string}`,
        chunkSize: stored.chunk_size,
        chunkCount: stored.chunk_count,
        storedSha256: stored.stored_sha256,
        timestamp: stored.audit_timestamp,
      },
    }
  }

  const metadata = storageManager.getMetadata(cid)
  if (!metadata?.audit) {
    return null
  }

  return {
    cid,
    owner: metadata.owner,
    tier: metadata.tier,
    category: metadata.category,
    backend: metadata.addresses.backends[0] ?? null,
    sizeBytes: metadata.size,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt ?? metadata.createdAt,
    audit: metadata.audit,
  }
}

function parseChunkIndices(indicesParam: string | undefined): number[] | null {
  if (!indicesParam) {
    return null
  }

  const indices = indicesParam
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0)

  if (indices.length === 0) {
    return null
  }

  return Array.from(new Set(indices)).sort((a, b) => a - b)
}

export function createStorageRouter(_backend?: BackendManager) {
  // Always use MultiBackendManager - it handles localnet configuration internally
  const storageManager = getMultiBackendManager()

  return (
    new Elysia({ prefix: '/storage' })
      // Health & Stats
      .get('/health', async () => {
        const backends = storageManager.listBackends()
        const health = await storageManager.healthCheck()
        const encryption = await storageManager.getEncryptionHealth()
        const stats = storageManager.getNodeStats()

        return {
          service: 'dws-storage',
          status: 'healthy' as const,
          backends,
          health,
          encryption,
          stats,
        }
      })

      .get('/stats', () => storageManager.getNodeStats())

      .get('/bootstrap-manifest', () => {
        const items = storageManager.listByTier('system')
        return {
          version: '0.1.0',
          generatedAt: Date.now(),
          totalItems: items.length,
          totalSize: items.reduce((sum, item) => sum + item.size, 0),
          items: items.map((item) => ({
            cid: item.cid,
            name: item.name,
            category: item.category,
            size: item.size,
            sha256: item.sha256,
            backends: item.addresses.backends,
          })),
        }
      })

      // Upload with multipart form
      .post('/upload', async ({ request, set }) => {
        // Parse multipart form data from request
        let formData: FormData
        try {
          formData = await request.formData()
        } catch (_err) {
          set.status = 400
          return { error: 'Invalid multipart form data' }
        }

        const file = formData.get('file') as File | null

        if (!file) {
          set.status = 400
          return { error: 'No file provided' }
        }

        // Get filename from File object or fallback to 'upload'
        // (Blob uploads may not have .name set in some environments)
        const filename = file.name || 'upload'

        const requestedTier = getFormString(formData, 'tier') as
          | ContentTier
          | undefined
        const category = getFormStringOr(formData, 'category', 'data')
        const encrypt = formData.get('encrypt') === 'true'
        const permanent = formData.get('permanent') === 'true'
        const backendsStr = getFormString(formData, 'backends')
        const accessPolicy = getFormString(formData, 'accessPolicy')
        const requestedAccessClass = getFormString(formData, 'storageClass')
        const minReplicas = clampReplicaRequest(
          parseOptionalInt(getFormString(formData, 'minReplicas')),
        )
        const senderAddress = request.headers.get('x-sender-address')
        const paymentHeader = request.headers.get('x-payment')
        const accessClass = resolveAccessClass(
          requestedAccessClass,
          requestedTier,
          encrypt,
        )
        const tier = resolveTier(requestedTier, accessClass)

        const content = Buffer.from(await file.arrayBuffer())

        // ========== CONTENT MODERATION ==========
        const shouldModerate = shouldModerateUpload(filename, category)
        const moderation = shouldModerate
          ? await moderateUpload(content, filename, senderAddress ?? undefined)
          : null

        // Block banned/blocked content
        if (
          moderation &&
          (moderation.action === 'ban' || moderation.action === 'block')
        ) {
          set.status = moderation.action === 'ban' ? 451 : 403
          return buildModerationErrorResponse(moderation)
        }

        // Add warning header for flagged content
        if (moderation && moderation.action === 'warn') {
          set.headers['X-Moderation-Warning'] =
            `${moderation.primaryCategory}: ${moderation.blockedReason}`
        }

        // Queue content that needs review but allow upload
        if (moderation && moderation.action === 'queue') {
          set.headers['X-Moderation-Status'] = 'pending_review'
        }
        // ========================================

        const payment = await maybeChargeStorage({
          set,
          paymentHeader,
          userAddress: senderAddress,
          tier,
          operation: permanent ? 'permanent-upload' : 'upload',
          sizeBytes: content.length,
          resource: `/storage/upload`,
        })
        if (payment.ok === false) {
          return payment.response
        }

        const preferredBackends = backendsStr?.split(',').filter(Boolean) as
          | StorageBackendType[]
          | undefined

        const result = permanent
          ? await storageManager
              .uploadPermanent(content, {
                filename,
                tier,
                category: category as ContentCategory,
                accessClass,
                minReplicas,
              })
              .catch((error: unknown) => {
                return toUploadErrorResponse(set, error)
              })
          : await storageManager
              .upload(content, {
                filename,
                tier,
                category: category as ContentCategory,
                encrypt,
                preferredBackends,
                accessPolicy: accessPolicy ?? undefined,
                accessClass,
                minReplicas,
              })
              .catch((error: unknown) => {
                return toUploadErrorResponse(set, error)
              })

        if ('error' in result) {
          return result
        }

        await persistStoredUpload({
          storageManager,
          cid: result.cid,
          filename,
          sizeBytes: result.size,
          backend: result.backends[0],
          tier,
          category: category as ContentCategory,
          senderAddress,
          permanent,
          payment,
        })

        return result
      })

      // Raw upload (simple body as content)
      .post('/upload/raw', async ({ request, query, set }) => {
        const filename = request.headers.get('x-filename') || 'upload'
        const requestedTier = query.tier as ContentTier | undefined
        const category = (query.category as ContentCategory) || 'data'
        const requestedAccessClass =
          typeof query.storageClass === 'string' ? query.storageClass : undefined
        const minReplicas = clampReplicaRequest(
          getQueryInt(
            query as Record<string, string | undefined>,
            'minReplicas',
            0,
          ) || undefined,
        )
        const accessClass = resolveAccessClass(
          requestedAccessClass,
          requestedTier,
          query.encrypt === 'true',
        )
        const tier = resolveTier(requestedTier, accessClass)
        const senderAddress = request.headers.get('x-sender-address')
        const paymentHeader = request.headers.get('x-payment')

        const content = Buffer.from(await request.arrayBuffer())

        // ========== CONTENT MODERATION ==========
        const shouldModerate = shouldModerateUpload(filename, category)
        const moderation = shouldModerate
          ? await moderateUpload(content, filename, senderAddress ?? undefined)
          : null

        if (
          moderation &&
          (moderation.action === 'ban' || moderation.action === 'block')
        ) {
          set.status = moderation.action === 'ban' ? 451 : 403
          return buildModerationErrorResponse(moderation)
        }

        if (moderation && moderation.action === 'warn') {
          set.headers['X-Moderation-Warning'] =
            `${moderation.primaryCategory}: ${moderation.blockedReason}`
        }
        // ========================================

        const payment = await maybeChargeStorage({
          set,
          paymentHeader,
          userAddress: senderAddress,
          tier,
          operation: 'upload',
          sizeBytes: content.length,
          resource: '/storage/upload/raw',
        })
        if (payment.ok === false) {
          return payment.response
        }

        const result = await storageManager
          .upload(content, {
            filename,
            tier,
            category,
            accessClass,
            minReplicas,
          })
          .catch((error: unknown) => {
            return toUploadErrorResponse(set, error)
          })

        if ('error' in result) {
          return result
        }

        await persistStoredUpload({
          storageManager,
          cid: result.cid,
          filename,
          sizeBytes: result.size,
          backend: result.backends[0],
          tier,
          category,
          senderAddress,
          payment,
        })

        return result
      })

      // JSON upload
      .post(
        '/upload/json',
        async ({ body, request, set }) => {
          const {
            data,
            name,
            tier,
            category,
            encrypt,
            storageClass,
            minReplicas,
          } = body as {
            data: unknown
            name?: string
            tier?: string
            category?: string
            encrypt?: boolean
            storageClass?: string
            minReplicas?: number
          }
          const content = Buffer.from(JSON.stringify(data))
          const filename = name ?? 'data.json'
          const senderAddress = request.headers.get('x-sender-address')
          const paymentHeader = request.headers.get('x-payment')

          // ========== CONTENT MODERATION ==========
          const moderation = await moderateUpload(
            content,
            filename,
            senderAddress ?? undefined,
          )

          if (moderation.action === 'ban' || moderation.action === 'block') {
            set.status = moderation.action === 'ban' ? 451 : 403
            return buildModerationErrorResponse(moderation)
          }

          if (moderation.action === 'warn') {
            set.headers['X-Moderation-Warning'] =
              `${moderation.primaryCategory}: ${moderation.blockedReason}`
          }
          // ========================================

          const accessClass = resolveAccessClass(
            storageClass,
            tier as ContentTier | undefined,
            encrypt ?? false,
          )
          const resolvedTier = resolveTier(
            tier as ContentTier | undefined,
            accessClass,
          )
          const resolvedCategory =
            (category as ContentCategory | undefined) ?? 'data'

          const payment = await maybeChargeStorage({
            set,
            paymentHeader,
            userAddress: senderAddress,
            tier: resolvedTier,
            operation: 'upload',
            sizeBytes: content.length,
            resource: '/storage/upload/json',
          })
          if (payment.ok === false) {
            return payment.response
          }

          const result = await storageManager
            .upload(content, {
              filename,
              tier: resolvedTier,
              category: resolvedCategory,
              encrypt,
              accessClass,
              minReplicas: clampReplicaRequest(minReplicas),
            })
            .catch((error: unknown) => {
              return toUploadErrorResponse(set, error)
            })

          if ('error' in result) {
            return result
          }

          await persistStoredUpload({
            storageManager,
            cid: result.cid,
            filename,
            sizeBytes: result.size,
            backend: result.backends[0],
            tier: resolvedTier,
            category: resolvedCategory,
            senderAddress,
            payment,
          })

          return result
        },
        {
          body: t.Object({
            data: t.Unknown(),
            name: t.Optional(t.String()),
            tier: t.Optional(t.String()),
            category: t.Optional(t.String()),
            encrypt: t.Optional(t.Boolean()),
            storageClass: t.Optional(t.String()),
            minReplicas: t.Optional(t.Number()),
          }),
        },
      )

      // Permanent upload
      .post('/upload/permanent', async ({ body, request, set }) => {
        const formData = body as FormData
        const file = formData.get('file') as File | null

        if (!file) {
          set.status = 400
          return { error: 'No file provided' }
        }

        const filename = file.name || 'upload'
        const requestedTier = getFormString(formData, 'tier') as
          | ContentTier
          | undefined
        const category = getFormStringOr(formData, 'category', 'data')
        const content = Buffer.from(await file.arrayBuffer())
        const requestedAccessClass = getFormString(formData, 'storageClass')
        const accessClass = resolveAccessClass(
          requestedAccessClass,
          requestedTier,
          false,
        )
        const tier = resolveTier(requestedTier, accessClass)
        const minReplicas = clampReplicaRequest(
          parseOptionalInt(getFormString(formData, 'minReplicas')),
        )
        const senderAddress = request.headers.get('x-sender-address')
        const paymentHeader = request.headers.get('x-payment')

        // ========== CONTENT MODERATION ==========
        // Permanent uploads require EXTRA strict moderation
        const moderation = await moderateUpload(
          content,
          filename,
          senderAddress ?? undefined,
        )

        // Block anything that isn't clean for permanent storage
        if (moderation.action !== 'allow') {
          set.status =
            moderation.action === 'ban'
              ? 451
              : moderation.action === 'block'
                ? 403
                : 400
          return buildModerationErrorResponse(moderation)
        }
        // ========================================

        const payment = await maybeChargeStorage({
          set,
          paymentHeader,
          userAddress: senderAddress,
          tier,
          operation: 'permanent-upload',
          sizeBytes: content.length,
          resource: '/storage/upload/permanent',
        })
        if (payment.ok === false) {
          return payment.response
        }

        const result = await storageManager
          .uploadPermanent(content, {
            filename,
            tier,
            category: category as ContentCategory,
            accessClass,
            minReplicas,
          })
          .catch((error: unknown) => {
            return toUploadErrorResponse(set, error)
          })

        if ('error' in result) {
          return result
        }

        await persistStoredUpload({
          storageManager,
          cid: result.cid,
          filename,
          sizeBytes: result.size,
          backend: result.backends[0],
          tier,
          category: category as ContentCategory,
          senderAddress,
          permanent: true,
          payment,
        })

        return result
      })

      // Download
      .get('/download/:cid', async ({ params, query, request, set }) => {
        const cid = params.cid
        const region = extractClientRegion(
          request.headers.get('x-region') ?? undefined,
          request.headers.get('cf-ipcountry') ?? undefined,
        )
        const decrypt = query.decrypt === 'true'
        const preferredBackend = query.backend as StorageBackendType | undefined
        const senderAddress = request.headers.get('x-sender-address')
        const paymentHeader = request.headers.get('x-payment')

        const contentInfo = await resolveStoredContentInfo(storageManager, cid)
        const payment = await maybeChargeStorage({
          set,
          paymentHeader,
          userAddress: senderAddress,
          tier: contentInfo.tier,
          operation: 'download',
          sizeBytes: contentInfo.sizeBytes,
          resource: `/storage/download/${cid}`,
        })
        if (payment.ok === false) {
          return payment.response
        }

        const result = await storageManager.download(cid, {
          region,
          preferredBackends: preferredBackend ? [preferredBackend] : undefined,
          decryptionKeyId: decrypt
            ? (request.headers.get('x-decryption-key-id') ?? undefined)
            : undefined,
        })

        const metadata = result.metadata
        const contentType = metadata.contentType ?? 'application/octet-stream'

        set.headers['Content-Type'] = contentType
        set.headers['Content-Length'] = String(result.content.length)
        set.headers['X-Backend'] = result.backend
        set.headers['X-Latency-Ms'] = String(result.latencyMs)
        set.headers['X-From-Cache'] = String(result.fromCache)
        if (metadata.tier) {
          set.headers['X-Content-Tier'] = metadata.tier
        }

        await storageActivityState.save({
          cid,
          operation: 'download',
          owner: contentInfo.owner ?? metadata.owner,
          payer: payment.payer ?? senderAddress ?? undefined,
          paymentScheme: payment.scheme,
          amountWei: payment.amountWei,
          sizeBytes: result.content.length,
          tier: metadata.tier,
          category: metadata.category,
          backend: result.backend,
        })

        return new Response(new Uint8Array(result.content))
      })

      // Download as JSON
      .get('/download/:cid/json', async ({ params, request, set }) => {
        const cid = params.cid
        const region = request.headers.get('x-region') ?? 'unknown'
        const senderAddress = request.headers.get('x-sender-address')
        const paymentHeader = request.headers.get('x-payment')

        const contentInfo = await resolveStoredContentInfo(storageManager, cid)
        const payment = await maybeChargeStorage({
          set,
          paymentHeader,
          userAddress: senderAddress,
          tier: contentInfo.tier,
          operation: 'download',
          sizeBytes: contentInfo.sizeBytes,
          resource: `/storage/download/${cid}/json`,
        })
        if (payment.ok === false) {
          return payment.response
        }

        const result = await storageManager.download(cid, { region })

        if (!result) {
          set.status = 404
          return { error: 'Not found' }
        }

        await storageActivityState.save({
          cid,
          operation: 'download',
          owner: contentInfo.owner ?? result.metadata.owner,
          payer: payment.payer ?? senderAddress ?? undefined,
          paymentScheme: payment.scheme,
          amountWei: payment.amountWei,
          sizeBytes: result.content.length,
          tier: result.metadata.tier,
          category: result.metadata.category,
          backend: result.backend,
        })

        return JsonValueSchema.parse(
          JSON.parse(result.content.toString('utf-8')),
        )
      })

      // Get content metadata
      .get('/content/:cid', ({ params, set }) => {
        const cid = params.cid
        const metadata = storageManager.getMetadata(cid)

        if (!metadata) {
          set.status = 404
          return { error: 'Not found' }
        }

        return metadata
      })

      .get('/activity/summary', async ({ query }) => {
        const owner =
          typeof query.owner === 'string' ? query.owner : undefined
        const sinceHours = getQueryInt(
          query as Record<string, string | undefined>,
          'sinceHours',
          24 * 30,
        )
        const since = Date.now() - sinceHours * 60 * 60 * 1000
        const summary = await storageActivityState.summarize({ owner, since })

        return {
          owner: owner ?? null,
          since,
          sinceHours,
          ...summary,
          totalAmountWei: summary.totalAmountWei.toString(),
        }
      })

      .get('/audit', async ({ query }) => {
        const owner =
          typeof query.owner === 'string' ? query.owner : undefined
        const limit = getQueryInt(
          query as Record<string, string | undefined>,
          'limit',
          100,
        )
        const offset = getQueryInt(
          query as Record<string, string | undefined>,
          'offset',
          0,
        )

        const items = await storageCommitmentState.list({ owner, limit, offset })

        return {
          items: items.map((item) => ({
            cid: item.cid,
            owner: item.owner,
            tier: item.tier,
            category: item.category,
            backend: item.backend,
            sizeBytes: item.size_bytes,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            audit: {
              commitment: item.commitment,
              merkleRoot: item.merkle_root,
              chunkSize: item.chunk_size,
              chunkCount: item.chunk_count,
              storedSha256: item.stored_sha256,
              timestamp: item.audit_timestamp,
            },
          })),
          limit,
          offset,
        }
      })

      .get('/audit/:cid', async ({ params, set }) => {
        const commitment = await resolveStoredCommitment(
          storageManager,
          params.cid,
        )

        if (!commitment) {
          set.status = 404
          return { error: 'Audit commitment not found' }
        }

        return commitment
      })

      .get('/audit/:cid/challenge', async ({ params, query, set }) => {
        const commitment = await resolveStoredCommitment(
          storageManager,
          params.cid,
        )

        if (!commitment) {
          set.status = 404
          return { error: 'Audit commitment not found' }
        }

        const requestedCount = getQueryInt(
          query as Record<string, string | undefined>,
          'count',
          3,
        )
        const maxCount = Math.max(1, Math.min(16, commitment.audit.chunkCount))
        const sampleCount = Math.max(1, Math.min(requestedCount, maxCount))
        const issuedAt = Date.now()

        return {
          cid: params.cid,
          issuedAt,
          expiresAt: issuedAt + 5 * 60 * 1000,
          sampleCount,
          chunkIndices: pickRandomChunkIndices(
            commitment.audit.chunkCount,
            sampleCount,
          ),
          audit: commitment.audit,
        }
      })

      .get('/audit/:cid/prove', async ({ params, query, set }) => {
        const commitment = await resolveStoredCommitment(
          storageManager,
          params.cid,
        )

        if (!commitment) {
          set.status = 404
          return { error: 'Audit commitment not found' }
        }

        const chunkIndices = parseChunkIndices(
          typeof query.indices === 'string' ? query.indices : undefined,
        )
        if (!chunkIndices) {
          set.status = 400
          return { error: 'Provide comma-separated chunk indices' }
        }

        if (
          chunkIndices.some((index) => index >= commitment.audit.chunkCount)
        ) {
          set.status = 400
          return { error: 'Chunk index out of range' }
        }

        const result = await storageManager.download(params.cid)
        const proof = getAuditChunks(
          new Uint8Array(result.content),
          chunkIndices,
          commitment.audit.chunkSize,
        )

        if (
          proof.audit.commitment.toLowerCase() !==
            commitment.audit.commitment.toLowerCase() ||
          proof.audit.merkleRoot.toLowerCase() !==
            commitment.audit.merkleRoot.toLowerCase() ||
          proof.audit.storedSha256.toLowerCase() !==
            commitment.audit.storedSha256.toLowerCase()
        ) {
          set.status = 409
          return { error: 'Stored content no longer matches the commitment' }
        }

        return {
          cid: params.cid,
          backend: result.backend,
          latencyMs: result.latencyMs,
          chunkSize: commitment.audit.chunkSize,
          chunkCount: commitment.audit.chunkCount,
          chunks: proof.chunks.map((chunk) => ({
            index: chunk.index,
            data: Buffer.from(chunk.data).toString('base64'),
            proof: chunk.proof,
          })),
          audit: commitment.audit,
        }
      })

      // List content
      .get('/content', ({ query }) => {
        const tier = query.tier as ContentTier | undefined
        const category = query.category as ContentCategory | undefined
        const limit = getQueryInt(query, 'limit', 100)
        const offset = getQueryInt(query, 'offset', 0)

        let items = tier
          ? storageManager.listByTier(tier)
          : category
            ? storageManager.listByCategory(category)
            : [
                ...storageManager.listByTier('system'),
                ...storageManager.listByTier('popular'),
                ...storageManager.listByTier('private'),
              ]

        const total = items.length
        items = items.slice(offset, offset + limit)

        return { items, total, limit, offset }
      })

      // Check if content exists
      .get('/exists/:cid', async ({ params }) => {
        const cid = params.cid

        const exists = await storageManager.exists(cid)
        return { cid, exists }
      })

      // Popular content
      .get('/popular', ({ query }) => {
        const limit = getQueryInt(query, 'limit', 10)
        const popular = storageManager.getPopularContent(limit)
        return { items: popular }
      })

      // Underseeded content
      .get('/underseeded', ({ query }) => {
        const minSeeders = getQueryInt(query, 'min', 3)
        const underseeded = storageManager.getUnderseededContent(minSeeders)
        return { items: underseeded }
      })

      // Regional popularity
      .get('/regional/:region', ({ params }) => {
        const region = params.region
        const popularity = storageManager.getRegionalPopularity(region)
        return popularity
      })

      // WebTorrent info
      .get('/torrent/:cid', ({ params, set }) => {
        const cid = params.cid
        const metadata = storageManager.getMetadata(cid)

        if (!metadata || !metadata.addresses.magnetUri) {
          set.status = 404
          return { error: 'Torrent not found' }
        }

        return {
          cid,
          magnetUri: metadata.addresses.magnetUri,
          infoHash: metadata.addresses.cid,
          size: metadata.size,
          tier: metadata.tier,
        }
      })

      // Get magnet URI
      .get('/magnet/:cid', ({ params, set }) => {
        const cid = params.cid
        const metadata = storageManager.getMetadata(cid)

        if (!metadata || !metadata.addresses.magnetUri) {
          set.status = 404
          return { error: 'Magnet URI not found' }
        }

        set.headers['Content-Type'] = 'text/plain'
        return metadata.addresses.magnetUri
      })

      // Arweave content
      .get('/arweave/:txId', async ({ params, set }) => {
        const txId = params.txId

        const result = await storageManager.download(txId, {
          preferredBackends: ['arweave'],
        })

        if (!result) {
          set.status = 404
          return { error: 'Not found' }
        }

        const contentType =
          result.metadata.contentType ?? 'application/octet-stream'

        set.headers['Content-Type'] = contentType
        set.headers['X-Arweave-Tx'] = txId

        return new Response(new Uint8Array(result.content))
      })

      // IPFS Compatibility - Add
      .post('/api/v0/add', async ({ request, set }) => {
        // Parse multipart form data from request (same as /upload)
        let formData: FormData
        try {
          formData = await request.formData()
        } catch {
          set.status = 400
          return { error: 'Invalid multipart form data' }
        }

        const file = formData.get('file') as File | null

        if (!file) {
          set.status = 400
          return { error: 'No file provided' }
        }

        const filename = file.name || 'file'
        const content = Buffer.from(await file.arrayBuffer())
        const senderAddress = request.headers.get('x-sender-address')
        const paymentHeader = request.headers.get('x-payment')

        // ========== CONTENT MODERATION ==========
        const moderation = await moderateUpload(
          content,
          filename,
          senderAddress ?? undefined,
        )

        if (moderation.action === 'ban' || moderation.action === 'block') {
          set.status = moderation.action === 'ban' ? 451 : 403
          return buildModerationErrorResponse(moderation)
        }
        // ========================================

        const payment = await maybeChargeStorage({
          set,
          paymentHeader,
          userAddress: senderAddress,
          tier: 'popular',
          operation: 'upload',
          sizeBytes: content.length,
          resource: '/storage/api/v0/add',
        })
        if (payment.ok === false) {
          return payment.response
        }

        const result = await storageManager.upload(content, {
          filename,
          tier: 'popular',
        })

        await persistStoredUpload({
          storageManager,
          cid: result.cid,
          filename,
          sizeBytes: result.size,
          backend: result.backends[0],
          tier: 'popular',
          category: 'data',
          senderAddress,
          payment,
        })

        return {
          Hash: result.cid,
          Size: String(result.size),
          Name: filename,
        }
      })

      // IPFS Compatibility - ID
      .post('/api/v0/id', async ({ set }) => {
        const health = await storageManager.healthCheck()
        const allHealthy = Object.values(health).every((h) => h)

        if (!allHealthy) {
          set.status = 503
          return { error: 'Storage backends unhealthy' }
        }

        const backends = storageManager.listBackends()

        return {
          ID: 'dws-storage',
          AgentVersion: 'dws/2.0.0',
          Addresses: [],
          Backends: backends,
        }
      })

      // IPFS Compatibility - Unpin
      .post('/api/v0/pin/rm', ({ query }) => {
        const arg = query.arg
        return { Pins: [arg] }
      })

      // IPFS path
      .get('/ipfs/:cid', async ({ params, request, set }) => {
        const cid = params.cid
        const region = request.headers.get('x-region') ?? 'unknown'
        const senderAddress = request.headers.get('x-sender-address')
        const paymentHeader = request.headers.get('x-payment')

        const contentInfo = await resolveStoredContentInfo(storageManager, cid)
        const payment = await maybeChargeStorage({
          set,
          paymentHeader,
          userAddress: senderAddress,
          tier: contentInfo.tier,
          operation: 'download',
          sizeBytes: contentInfo.sizeBytes,
          resource: `/storage/ipfs/${cid}`,
        })
        if (payment.ok === false) {
          return payment.response
        }

        const result = await storageManager.download(cid, { region })

        if (!result) {
          set.status = 404
          return { error: 'Not found' }
        }

        const contentType =
          result.metadata.contentType ?? 'application/octet-stream'

        set.headers['Content-Type'] = contentType
        set.headers['X-Ipfs-Path'] = `/ipfs/${cid}`
        set.headers['X-Backend'] = result.backend

        await storageActivityState.save({
          cid,
          operation: 'download',
          owner: contentInfo.owner ?? result.metadata.owner,
          payer: payment.payer ?? senderAddress ?? undefined,
          paymentScheme: payment.scheme,
          amountWei: payment.amountWei,
          sizeBytes: result.content.length,
          tier: result.metadata.tier,
          category: result.metadata.category,
          backend: result.backend,
        })

        return new Response(new Uint8Array(result.content))
      })
  )
}
