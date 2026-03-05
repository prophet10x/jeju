import {
  createNodeProofService,
  ChallengeRequestSchema,
  VerifyRequestSchema,
  type NodeProofSigner,
} from '@jejunetwork/shared'
import { createKMSSigner } from '@jejunetwork/kms'
import type { Address } from 'viem'

const NODE_PROOF_SERVICE_ID =
  process.env.GATEWAY_NODE_PROOF_SERVICE_ID ??
  `gateway-node-proof:${process.env.HOSTNAME ?? 'default'}`

const kmsTimeoutMs = Number.parseInt(
  process.env.GATEWAY_NODE_PROOF_KMS_TIMEOUT_MS ?? '8000',
  10,
)

function createNodeProofSignerClient() {
  return createKMSSigner({
    serviceId: NODE_PROOF_SERVICE_ID,
    timeoutMs: Number.isFinite(kmsTimeoutMs) ? kmsTimeoutMs : 8000,
  })
}
const remoteChallengeOrigins = new Map<string, string>()

const proofSigner: NodeProofSigner = {
  async getNodeWalletAddress() {
    const signer = createNodeProofSignerClient()
    await signer.initialize()
    return signer.getAddress() as Address
  },
  async signNodeMessage(message) {
    let activeSigner = createNodeProofSignerClient()
    await activeSigner.initialize()
    const signed = await activeSigner.signMessage(message).catch(async (error) => {
      const messageText = error instanceof Error ? error.message : String(error)
      if (!messageText.includes('Key not found')) {
        throw error
      }

      // KMS may have lost volatile key state (e.g. restart without restored key map).
      // Recreate signer + key mapping once and retry signing.
      activeSigner = createNodeProofSignerClient()
      await activeSigner.initialize()
      return activeSigner.signMessage(message)
    })
    return {
      address: activeSigner.getAddress() as Address,
      signature: signed.signature,
    }
  },
}

const service = createNodeProofService(proofSigner)

function normalizeOrigin(endpoint: string) {
  return new URL(endpoint).origin.replace(/\/$/, '')
}

function resolveRequestOrigin(request: Request): string {
  const requestUrl = new URL(request.url)
  const forwardedHost =
    request.headers.get('x-forwarded-host')?.trim() ??
    request.headers.get('host')?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.trim()
  if (forwardedHost) {
    const protocol = forwardedProto && forwardedProto.length > 0
      ? forwardedProto
      : requestUrl.protocol.replace(/:$/, '')
    return `${protocol}://${forwardedHost}`.replace(/\/$/, '')
  }
  return requestUrl.origin.replace(/\/$/, '')
}

async function proxyJson<T>(
  url: string,
  init: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response = await fetch(url, init).catch((error) => {
    throw new Error(
      error instanceof Error ? error.message : fallbackError,
    )
  })

  const text = await response.text()
  const payload = text ? (JSON.parse(text) as T | { error?: string }) : {}

  if (!response.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : fallbackError
    throw new Error(message)
  }

  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    throw new Error(payload.error)
  }

  return payload as T
}

export async function createNodeRegistrationChallenge(
  body: unknown,
  request?: Request,
) {
  const validBody = ChallengeRequestSchema.parse(body)
  const endpointOrigin = normalizeOrigin(validBody.endpoint)
  const localOrigin = request ? resolveRequestOrigin(request) : null

  if (localOrigin && endpointOrigin === localOrigin) {
    return service.createChallenge(validBody)
  }

  const challenge = await proxyJson<
    Awaited<ReturnType<typeof service.createChallenge>>
  >(
    `${endpointOrigin}/node-registration/challenge`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(validBody),
    },
    'Failed to prepare node proof challenge',
  )

  remoteChallengeOrigins.set(challenge.challengeId, endpointOrigin)
  return challenge
}

export async function verifyNodeRegistrationChallenge(body: unknown) {
  const validBody = VerifyRequestSchema.parse(body)
  const endpointOrigin = remoteChallengeOrigins.get(validBody.challengeId)

  if (!endpointOrigin) {
    return service.verifyChallenge(validBody)
  }

  return proxyJson<Awaited<ReturnType<typeof service.verifyChallenge>>>(
    `${endpointOrigin}/node-registration/verify`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(validBody),
    },
    'Failed to verify node proof',
  )
}

export const getNodeRegistrationProof = service.getProof
