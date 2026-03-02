import { getContract, getCurrentNetwork, getRpcUrl } from '@jejunetwork/config'
import { expectValid } from '@jejunetwork/types'
import { Elysia } from 'elysia'
import {
  createPublicClient,
  http,
  type Address,
  verifyMessage,
} from 'viem'
import { z } from 'zod'
import {
  getOrCreateServiceKey,
  signMessageWithServiceKey,
} from './kms'

const NETWORK = getCurrentNetwork()
const CHALLENGE_TTL_MS = 10 * 60 * 1000
const PROOF_PATH = '/.well-known/jeju-node-proof.json'
const NODE_PROOF_SERVICE_ID =
  process.env.DWS_NODE_PROOF_SERVICE_ID ??
  `dws-node-proof:${process.env.HOSTNAME ?? 'default'}`

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/)
const ChallengeRequestSchema = z.object({
  endpoint: z.string().url(),
  operatorAddress: AddressSchema,
  operatorAgentId: z.number().int().positive(),
})
const VerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  operatorSignature: z.string().regex(/^0x[a-fA-F0-9]+$/),
})
const ProofDocumentSchema = z.object({
  challengeId: z.string().uuid(),
  operatorAddress: AddressSchema,
  operatorAgentId: z.number().int().positive(),
  endpointOrigin: z.string().url(),
  nodeWalletAddress: AddressSchema,
  message: z.string().min(1),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  signedAt: z.number().int().positive(),
})

const IDENTITY_REGISTRY_ABI = [
  {
    name: 'ownerOf',
    type: 'function',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'owner', type: 'address' }],
    stateMutability: 'view',
  },
  {
    name: 'getAgentWallet',
    type: 'function',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: 'wallet', type: 'address' }],
    stateMutability: 'view',
  },
] as const

interface ChallengeRecord {
  challengeId: string
  operatorAddress: Address
  operatorAgentId: bigint
  endpoint: string
  endpointOrigin: string
  proofUrl: string
  nodeWalletAddress: Address
  operatorMessage: string
  nodeMessage: string
  issuedAt: number
  expiresAt: number
}

const challenges = new Map<string, ChallengeRecord>()

function getClient() {
  return createPublicClient({
    transport: http(getRpcUrl(NETWORK)),
  })
}

function getIdentityRegistryAddress(): Address | null {
  try {
    return getContract('registry', 'identity', NETWORK) as Address
  } catch {
    return null
  }
}

function normalizeEndpoint(endpoint: string): {
  endpoint: string
  endpointOrigin: string
  proofUrl: string
} {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https endpoints are supported')
  }
  url.hash = ''

  const originUrl = new URL(url.origin)
  const proofUrl = new URL(PROOF_PATH, originUrl)

  return {
    endpoint: url.toString(),
    endpointOrigin: originUrl.toString().replace(/\/$/, ''),
    proofUrl: proofUrl.toString(),
  }
}

function normalizeAddress(address: Address | string | null | undefined) {
  return address?.toLowerCase() ?? ''
}

function buildOperatorMessage(record: {
  challengeId: string
  operatorAgentId: bigint
  operatorAddress: Address
  nodeWalletAddress: Address
  endpointOrigin: string
  issuedAt: number
  expiresAt: number
}) {
  return [
    'Jeju Node Registration Operator Authorization',
    `challengeId:${record.challengeId}`,
    `agentId:${record.operatorAgentId}`,
    `operator:${record.operatorAddress}`,
    `nodeWallet:${record.nodeWalletAddress}`,
    `endpoint:${record.endpointOrigin}`,
    `issuedAt:${record.issuedAt}`,
    `expiresAt:${record.expiresAt}`,
  ].join('\n')
}

function buildNodeMessage(record: {
  challengeId: string
  operatorAgentId: bigint
  operatorAddress: Address
  nodeWalletAddress: Address
  endpointOrigin: string
  issuedAt: number
  expiresAt: number
}) {
  return [
    'Jeju Node Registration Endpoint Proof',
    `challengeId:${record.challengeId}`,
    `agentId:${record.operatorAgentId}`,
    `operator:${record.operatorAddress}`,
    `nodeWallet:${record.nodeWalletAddress}`,
    `endpoint:${record.endpointOrigin}`,
    `issuedAt:${record.issuedAt}`,
    `expiresAt:${record.expiresAt}`,
  ].join('\n')
}

function cleanupExpiredChallenges() {
  const now = Date.now()
  for (const [challengeId, record] of challenges.entries()) {
    if (record.expiresAt <= now) {
      challenges.delete(challengeId)
    }
  }
}

async function getAgentOwner(
  identityRegistry: Address,
  agentId: bigint,
): Promise<Address> {
  return getClient().readContract({
    address: identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'ownerOf',
    args: [agentId],
  }) as Promise<Address>
}

async function getAgentWallet(
  identityRegistry: Address,
  agentId: bigint,
): Promise<Address | null> {
  try {
    return (await getClient().readContract({
      address: identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'getAgentWallet',
      args: [agentId],
    })) as Address
  } catch {
    return null
  }
}

export function createNodeRegistrationRouter() {
  return new Elysia({ name: 'node-registration' })
    .post('/node-registration/challenge', async ({ body, set }) => {
      cleanupExpiredChallenges()

      const identityRegistry = getIdentityRegistryAddress()
      if (!identityRegistry) {
        set.status = 503
        return { error: 'Identity registry not configured' }
      }

      const validBody = expectValid(
        ChallengeRequestSchema,
        body,
        'Node registration challenge request',
      )

      const operatorAgentId = BigInt(validBody.operatorAgentId)
      const owner = await getAgentOwner(identityRegistry, operatorAgentId)
      if (
        normalizeAddress(owner) !== normalizeAddress(validBody.operatorAddress)
      ) {
        set.status = 403
        return { error: 'Selected agent is not owned by the provided wallet' }
      }

      const endpoint = normalizeEndpoint(validBody.endpoint)
      const serviceKey = await getOrCreateServiceKey(NODE_PROOF_SERVICE_ID, {
        purpose: 'node-registration-proof',
      })
      const issuedAt = Date.now()
      const expiresAt = issuedAt + CHALLENGE_TTL_MS
      const challengeId = crypto.randomUUID()

      const baseRecord = {
        challengeId,
        operatorAddress: validBody.operatorAddress as Address,
        operatorAgentId,
        endpoint: endpoint.endpoint,
        endpointOrigin: endpoint.endpointOrigin,
        proofUrl: `${endpoint.proofUrl}?challengeId=${challengeId}`,
        nodeWalletAddress: serviceKey.address,
        issuedAt,
        expiresAt,
      }

      const record: ChallengeRecord = {
        ...baseRecord,
        operatorMessage: buildOperatorMessage(baseRecord),
        nodeMessage: buildNodeMessage(baseRecord),
      }

      challenges.set(challengeId, record)

      const currentAgentWallet = await getAgentWallet(
        identityRegistry,
        operatorAgentId,
      )

      return {
        challengeId,
        expiresAt,
        endpoint: record.endpoint,
        endpointOrigin: record.endpointOrigin,
        proofUrl: record.proofUrl,
        nodeWalletAddress: record.nodeWalletAddress,
        currentAgentWallet,
        delegatedWalletContractReady: currentAgentWallet !== null,
        requiresDelegatedWalletUpdate:
          normalizeAddress(currentAgentWallet) !==
          normalizeAddress(record.nodeWalletAddress),
        operatorMessage: record.operatorMessage,
        nodeMessage: record.nodeMessage,
      }
    })
    .post('/node-registration/verify', async ({ body, set }) => {
      cleanupExpiredChallenges()

      const identityRegistry = getIdentityRegistryAddress()
      if (!identityRegistry) {
        set.status = 503
        return { error: 'Identity registry not configured' }
      }

      const validBody = expectValid(
        VerifyRequestSchema,
        body,
        'Node registration verification request',
      )
      const challenge = challenges.get(validBody.challengeId)

      if (!challenge) {
        set.status = 404
        return { error: 'Challenge not found or expired' }
      }
      if (challenge.expiresAt <= Date.now()) {
        challenges.delete(challenge.challengeId)
        set.status = 410
        return { error: 'Challenge expired' }
      }

      const owner = await getAgentOwner(
        identityRegistry,
        challenge.operatorAgentId,
      )
      if (
        normalizeAddress(owner) !== normalizeAddress(challenge.operatorAddress)
      ) {
        set.status = 409
        return { error: 'Agent ownership changed before verification completed' }
      }

      const currentAgentWallet = await getAgentWallet(
        identityRegistry,
        challenge.operatorAgentId,
      )
      if (currentAgentWallet === null) {
        set.status = 409
        return {
          error:
            'Identity registry does not expose delegated wallet methods on this deployment yet',
        }
      }
      if (
        normalizeAddress(currentAgentWallet) !==
        normalizeAddress(challenge.nodeWalletAddress)
      ) {
        set.status = 409
        return {
          error:
            'Delegated node wallet is not authorized on-chain for this agent yet',
          expectedNodeWalletAddress: challenge.nodeWalletAddress,
          currentAgentWallet,
        }
      }

      const operatorAuthorized = await verifyMessage({
        address: challenge.operatorAddress,
        message: challenge.operatorMessage,
        signature: validBody.operatorSignature as `0x${string}`,
      })

      if (!operatorAuthorized) {
        set.status = 400
        return { error: 'Operator signature verification failed' }
      }

      const proofResponse = await fetch(challenge.proofUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      }).catch(() => null)

      if (!proofResponse || !proofResponse.ok) {
        set.status = 502
        return { error: 'Failed to fetch proof document from the claimed endpoint' }
      }

      const proofJson = await proofResponse.json()
      const proof = expectValid(
        ProofDocumentSchema,
        proofJson,
        'Node proof document',
      )

      if (proof.challengeId !== challenge.challengeId) {
        set.status = 400
        return { error: 'Proof document challenge ID mismatch' }
      }
      if (
        normalizeAddress(proof.nodeWalletAddress) !==
        normalizeAddress(challenge.nodeWalletAddress)
      ) {
        set.status = 400
        return { error: 'Proof document signer address mismatch' }
      }
      if (proof.endpointOrigin !== challenge.endpointOrigin) {
        set.status = 400
        return { error: 'Proof document endpoint origin mismatch' }
      }
      if (proof.message !== challenge.nodeMessage) {
        set.status = 400
        return { error: 'Proof document message mismatch' }
      }

      const nodeProofValid = await verifyMessage({
        address: challenge.nodeWalletAddress,
        message: challenge.nodeMessage,
        signature: proof.signature as `0x${string}`,
      })

      if (!nodeProofValid) {
        set.status = 400
        return { error: 'Node proof signature verification failed' }
      }

      return {
        verified: true,
        challengeId: challenge.challengeId,
        nodeWalletAddress: challenge.nodeWalletAddress,
        endpointOrigin: challenge.endpointOrigin,
        proofUrl: challenge.proofUrl,
        verifiedAt: Date.now(),
      }
    })
    .get(PROOF_PATH, async ({ query, request, set }) => {
      cleanupExpiredChallenges()

      const parsed = z
        .object({
          challengeId: z.string().uuid(),
        })
        .safeParse(query)

      if (!parsed.success) {
        set.status = 400
        return { error: 'challengeId query parameter is required' }
      }

      const challenge = challenges.get(parsed.data.challengeId)
      if (!challenge) {
        set.status = 404
        return { error: 'Challenge not found or expired' }
      }
      if (challenge.expiresAt <= Date.now()) {
        challenges.delete(challenge.challengeId)
        set.status = 410
        return { error: 'Challenge expired' }
      }

      const currentOrigin = new URL(request.url).origin.toLowerCase()
      if (currentOrigin !== challenge.endpointOrigin.toLowerCase()) {
        set.status = 404
        return { error: 'Challenge is not bound to this endpoint origin' }
      }

      const signature = await signMessageWithServiceKey(
        NODE_PROOF_SERVICE_ID,
        challenge.nodeMessage,
      )

      set.headers['cache-control'] = 'no-store'
      return {
        challengeId: challenge.challengeId,
        operatorAddress: challenge.operatorAddress,
        operatorAgentId: Number(challenge.operatorAgentId),
        endpointOrigin: challenge.endpointOrigin,
        nodeWalletAddress: signature.address,
        message: challenge.nodeMessage,
        signature: signature.signature,
        signedAt: Date.now(),
      }
    })
}
