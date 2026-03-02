import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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

export interface NodeProofServerConfig {
  keyId: string
  host?: string
  port?: number
}

export class NodeProofServer {
  private readonly config: Required<NodeProofServerConfig>
  private readonly signer
  private server: Server | null = null
  private walletAddress: Address | null = null

  constructor(config: NodeProofServerConfig) {
    this.config = {
      keyId: config.keyId,
      host: config.host ?? '0.0.0.0',
      port: config.port ?? 4040,
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
