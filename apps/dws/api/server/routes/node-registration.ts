import { createNodeProofService, NODE_PROOF_PATH, type NodeProofSigner } from '@jejunetwork/shared'
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

export function createNodeRegistrationRouter() {
  return new Elysia({ name: 'node-registration' })
    .post('/node-registration/challenge', async ({ body, set }) => {
      try {
        return await proofService.createChallenge(body)
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
        return await proofService.verifyChallenge(body)
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
