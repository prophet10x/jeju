import {
  ChallengeRequestSchema,
  createNodeProofService,
  NODE_PROOF_PATH,
  VerifyRequestSchema,
  type NodeProofSigner,
} from '@jejunetwork/shared'
import { expectValid } from '@jejunetwork/types'
import { Elysia } from 'elysia'
import type { Address } from 'viem'
import { z } from 'zod'
import {
  getOrCreateServiceKey,
  signMessageWithServiceKey,
} from './kms'

const NODE_PROOF_SERVICE_ID =
  process.env.DWS_NODE_PROOF_SERVICE_ID ??
  `dws-node-proof:${process.env.HOSTNAME ?? 'default'}`

const QuerySchema = z.object({
  challengeId: z.string().uuid(),
})

const proofSigner: NodeProofSigner = {
  async getNodeWalletAddress() {
    const serviceKey = await getOrCreateServiceKey(NODE_PROOF_SERVICE_ID, {
      purpose: 'node-registration-proof',
    })
    return serviceKey.address as Address
  },
  async signNodeMessage(message) {
    const signature = await signMessageWithServiceKey(
      NODE_PROOF_SERVICE_ID,
      message,
    )
    return {
      address: signature.address as Address,
      signature: signature.signature,
    }
  },
}

const proofService = createNodeProofService(proofSigner)
const remoteChallengeOrigins = new Map<string, string>()

function getForwardedRequestUrl(request: Request) {
  const url = new URL(request.url)
  const forwardedProto =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || ''
  const forwardedHost =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host')?.trim() ||
    ''

  if (!forwardedHost) {
    return request.url
  }

  const protocol = forwardedProto || url.protocol.replace(/:$/, '')
  return `${protocol}://${forwardedHost}${url.pathname}${url.search}`
}

function getForwardedOrigin(request: Request) {
  const forwardedUrl = new URL(getForwardedRequestUrl(request))
  return forwardedUrl.origin.replace(/\/$/, '')
}

function normalizeOrigin(endpoint: string) {
  return new URL(endpoint).origin.replace(/\/$/, '')
}

async function proxyJson<T>(
  url: string,
  init: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response = await fetch(url, init).catch((error) => {
    throw new Error(error instanceof Error ? error.message : fallbackError)
  })

  const rawPayload = await response.text()
  let payload: T | { error?: string } | null = null
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload) as T | { error?: string }
    } catch {
      throw new Error(
        response.ok ? 'Remote endpoint returned invalid JSON.' : fallbackError,
      )
    }
  }

  if (payload && typeof payload === 'object' && 'error' in payload) {
    throw new Error(payload.error ?? fallbackError)
  }

  if (!response.ok) {
    throw new Error(fallbackError)
  }

  return payload as T
}

export function createNodeRegistrationRouter() {
  return new Elysia({ name: 'node-registration' })
    .post('/node-registration/challenge', async ({ body, request, set }) => {
      try {
        const validBody = expectValid(
          ChallengeRequestSchema,
          body,
          'Node registration challenge request',
        )
        const endpointOrigin = normalizeOrigin(validBody.endpoint)
        const localOrigin = getForwardedOrigin(request)

        if (endpointOrigin === localOrigin) {
          return await proofService.createChallenge(validBody)
        }

        const challenge = await proxyJson<
          Awaited<ReturnType<typeof proofService.createChallenge>>
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
          `Failed to prepare node proof challenge on ${endpointOrigin}`,
        )

        remoteChallengeOrigins.set(challenge.challengeId, endpointOrigin)
        return challenge
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to prepare node proof challenge'

        if (message.includes('not owned')) {
          set.status = 403
        } else if (message.includes('not configured')) {
          set.status = 503
        } else {
          set.status = 400
        }

        return { error: message }
      }
    })
    .post('/node-registration/verify', async ({ body, set }) => {
      try {
        const validBody = expectValid(
          VerifyRequestSchema,
          body,
          'Node registration verification request',
        )
        const endpointOrigin = remoteChallengeOrigins.get(validBody.challengeId)

        if (!endpointOrigin) {
          return await proofService.verifyChallenge(validBody)
        }

        return await proxyJson<Awaited<ReturnType<typeof proofService.verifyChallenge>>>(
          `${endpointOrigin}/node-registration/verify`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify(validBody),
          },
          `Failed to verify node proof on ${endpointOrigin}`,
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to verify node proof'

        if (message.includes('not found') || message.includes('expired')) {
          set.status = 404
        } else if (
          message.includes('changed before verification') ||
          message.includes('not authorized on-chain') ||
          message.includes('does not expose delegated wallet methods')
        ) {
          set.status = 409
        } else if (message.includes('Failed to fetch proof document')) {
          set.status = 502
        } else {
          set.status = 400
        }

        return { error: message }
      }
    })
    .get(NODE_PROOF_PATH, async ({ query, request, set }) => {
      const parsed = expectValid(
        QuerySchema,
        query,
        'Node registration proof query',
      )

      try {
        set.headers['cache-control'] = 'no-store'
        return await proofService.getProof(
          getForwardedRequestUrl(request),
          parsed.challengeId,
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to fetch proof'

        if (message.includes('not found') || message.includes('expired')) {
          set.status = 404
        } else {
          set.status = 400
        }

        return { error: message }
      }
    })
}
