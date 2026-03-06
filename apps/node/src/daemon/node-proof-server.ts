import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  QOS_ATTESTATION_PATH,
  QoSAttestationProofSchema,
  QoSAttestationRequestSchema,
  buildQoSAttestationMessage,
  normalizeAttestationOrigin,
} from '@jejunetwork/shared'
import type { Address } from 'viem'
import { z } from 'zod'
import { createSecureSigner } from '../../api/lib/secure-signer'

export const NODE_PROOF_PATH = '/.well-known/jeju-node-proof.json'

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/)
const ProofQuerySchema = z.object({
  challengeId: z.string().uuid(),
  operatorAddress: AddressSchema,
  operatorAgentId: z.coerce.number().int().positive(),
  endpointOrigin: z.string().url(),
  expiresAt: z.coerce.number().int().positive(),
  message: z.string().min(1).max(8192),
})

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export interface NodeProofServerConfig {
  keyId: string
  host?: string
  port?: number
  attestationChallengeWindowMs?: number
  attestationAllowedSkewMs?: number
  attestationNonceTtlMs?: number
  attestationMaxNonceCacheSize?: number
}

export class NodeProofServer {
  private readonly config: Required<NodeProofServerConfig>
  private readonly signer
  private server: Server | null = null
  private walletAddress: Address | null = null
  private readonly usedAttestationNonces = new Map<string, number>()
  private attestationSeq = 0

  constructor(config: NodeProofServerConfig) {
    this.config = {
      keyId: config.keyId,
      host: config.host ?? '0.0.0.0',
      port: config.port ?? 4040,
      attestationChallengeWindowMs: Math.max(
        10_000,
        config.attestationChallengeWindowMs ??
          parseEnvInt(
            process.env.QOS_ATTESTATION_CHALLENGE_WINDOW_MS ?? '90000',
            90_000,
          ),
      ),
      attestationAllowedSkewMs: Math.max(
        0,
        config.attestationAllowedSkewMs ??
          parseEnvInt(process.env.QOS_ATTESTATION_ALLOWED_SKEW_MS, 30_000),
      ),
      attestationNonceTtlMs: Math.max(
        60_000,
        config.attestationNonceTtlMs ??
          parseEnvInt(process.env.QOS_ATTESTATION_NONCE_TTL_MS, 600_000),
      ),
      attestationMaxNonceCacheSize: Math.max(
        1_000,
        config.attestationMaxNonceCacheSize ??
          parseEnvInt(process.env.QOS_ATTESTATION_MAX_NONCE_CACHE_SIZE, 100_000),
      ),
    }
    this.signer = createSecureSigner(this.config.keyId)
  }

  async start(): Promise<void> {
    if (this.server) return

    this.walletAddress = await this.signer.getAddress()
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server?.once('error', onError)
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off('error', onError)
        resolve()
      })
    })

    console.log(
      `[NodeProof] Started on http://${this.config.host}:${this.config.port}${NODE_PROOF_PATH}`,
    )
  }

  async stop(): Promise<void> {
    if (!this.server) return

    const server = this.server
    this.server = null

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

    console.log('[NodeProof] Stopped')
  }

  private async getWalletAddress(): Promise<Address> {
    if (this.walletAddress) {
      return this.walletAddress
    }

    this.walletAddress = await this.signer.getAddress()
    return this.walletAddress
  }

  private writeJson(
    res: ServerResponse<IncomingMessage>,
    statusCode: number,
    payload: unknown,
  ) {
    res.writeHead(statusCode, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(JSON.stringify(payload))
  }

  private cleanupExpiredAttestationNonces(now: number) {
    const expiryCutoff = now - this.config.attestationNonceTtlMs
    for (const [nonce, timestamp] of this.usedAttestationNonces.entries()) {
      if (timestamp < expiryCutoff) {
        this.usedAttestationNonces.delete(nonce)
      }
    }
  }

  private markAttestationNonceUsed(nonce: string, now: number): boolean {
    if (this.usedAttestationNonces.has(nonce)) {
      return false
    }

    if (
      this.usedAttestationNonces.size >= this.config.attestationMaxNonceCacheSize
    ) {
      this.cleanupExpiredAttestationNonces(now)

      if (
        this.usedAttestationNonces.size >=
        this.config.attestationMaxNonceCacheSize
      ) {
        const entries = [...this.usedAttestationNonces.entries()].sort(
          (a, b) => a[1] - b[1],
        )
        const toTrim = Math.ceil(entries.length * 0.1)
        for (let index = 0; index < toTrim; index++) {
          const entry = entries[index]
          if (entry) {
            this.usedAttestationNonces.delete(entry[0])
          }
        }
      }
    }

    this.usedAttestationNonces.set(nonce, now)
    return true
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let totalBytes = 0

    return new Promise((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes > 64 * 1024) {
          reject(new Error('Request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        if (chunks.length === 0) {
          resolve({})
          return
        }
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve(JSON.parse(raw))
        } catch {
          reject(new Error('Invalid JSON payload'))
        }
      })

      req.on('error', reject)
    })
  }

  private async handleQoSAttestationRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    endpointOrigin: string,
  ): Promise<void> {
    if (req.method !== 'POST') {
      this.writeJson(res, 405, { error: 'Method not allowed' })
      return
    }

    const requestBody = await this.readJsonBody(req)
    const parsed = QoSAttestationRequestSchema.safeParse(requestBody)
    if (!parsed.success) {
      this.writeJson(res, 400, {
        error: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      })
      return
    }

    const challenge = parsed.data
    if (challenge.expiresAt <= challenge.issuedAt) {
      this.writeJson(res, 400, { error: 'expiresAt must be greater than issuedAt' })
      return
    }

    const challengeWindow = challenge.expiresAt - challenge.issuedAt
    if (challengeWindow > this.config.attestationChallengeWindowMs) {
      this.writeJson(res, 400, { error: 'Attestation challenge window too large' })
      return
    }

    const now = Date.now()
    this.cleanupExpiredAttestationNonces(now)
    if (!this.markAttestationNonceUsed(challenge.nonce, now)) {
      this.writeJson(res, 409, { error: 'Nonce already used' })
      return
    }

    if (now < challenge.issuedAt - this.config.attestationAllowedSkewMs) {
      this.writeJson(res, 400, { error: 'Challenge is not valid yet' })
      return
    }
    if (now > challenge.expiresAt + this.config.attestationAllowedSkewMs) {
      this.writeJson(res, 400, { error: 'Challenge expired' })
      return
    }

    const nodeWalletAddress = await this.getWalletAddress()
    const seq = ++this.attestationSeq
    const message = buildQoSAttestationMessage({
      ...challenge,
      endpointOrigin,
      seq,
    })
    const signature = await this.signer.signMessage({ message })

    const proof = QoSAttestationProofSchema.parse({
      signer: nodeWalletAddress,
      signature,
      signedAt: Date.now(),
      seq,
    })

    this.writeJson(res, 200, proof)
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
  ): Promise<void> {
    try {
      const hostHeader = req.headers.host ?? `${this.config.host}:${this.config.port}`
      const url = new URL(req.url ?? '/', `http://${hostHeader}`)

      if (url.pathname === '/health') {
        this.writeJson(res, 200, { status: 'healthy' })
        return
      }

      if (url.pathname === QOS_ATTESTATION_PATH) {
        await this.handleQoSAttestationRequest(
          req,
          res,
          normalizeAttestationOrigin(url.origin),
        )
        return
      }

      if (url.pathname !== NODE_PROOF_PATH) {
        this.writeJson(res, 404, { error: 'Not found' })
        return
      }

      const nodeWalletAddress = await this.getWalletAddress()
      const message = url.searchParams.get('message')

      if (!message) {
        this.writeJson(res, 200, {
          nodeWalletAddress,
          proofPath: NODE_PROOF_PATH,
          proofMode: 'stateless',
          signerType: 'kms',
        })
        return
      }

      const parsed = ProofQuerySchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      )
      if (!parsed.success) {
        this.writeJson(res, 400, {
          error: parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        })
        return
      }

      const currentOrigin = url.origin.toLowerCase().replace(/\/$/, '')
      const endpointOrigin = parsed.data.endpointOrigin
        .toLowerCase()
        .replace(/\/$/, '')

      if (currentOrigin !== endpointOrigin) {
        this.writeJson(res, 400, {
          error: 'Proof request origin does not match endpoint origin',
        })
        return
      }

      const signature = await this.signer.signMessage({
        message: parsed.data.message,
      })

      this.writeJson(res, 200, {
        challengeId: parsed.data.challengeId,
        operatorAddress: parsed.data.operatorAddress,
        operatorAgentId: parsed.data.operatorAgentId,
        endpointOrigin,
        nodeWalletAddress,
        message: parsed.data.message,
        signature,
        signedAt: Date.now(),
      })
    } catch (error) {
      this.writeJson(res, 500, {
        error:
          error instanceof Error ? error.message : 'Failed to serve node proof',
      })
    }
  }
}
