import { getContract, getCurrentNetwork, getRpcUrl } from '@jejunetwork/config'
import { expectValid } from '@jejunetwork/types'
import {
  createPublicClient,
  http,
  type Address,
  verifyMessage,
} from 'viem'
import { z } from 'zod'

const NETWORK = getCurrentNetwork()
const CHALLENGE_TTL_MS = 10 * 60 * 1000
export const NODE_PROOF_PATH = '/.well-known/jeju-node-proof.json'

export const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/)
export const ChallengeRequestSchema = z.object({
  endpoint: z.string().url(),
  operatorAddress: AddressSchema,
  operatorAgentId: z.number().int().positive(),
})
export const VerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  operatorSignature: z.string().regex(/^0x[a-fA-F0-9]+$/),
})
export const ProofDocumentSchema = z.object({
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

const SIMPLE_ACCOUNT_FACTORY_ABI = [
  {
    name: 'getAddress',
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'salt', type: 'uint256' },
    ],
    outputs: [{ name: 'account', type: 'address' }],
    stateMutability: 'view',
  },
] as const

export interface NodeProofChallenge {
  challengeId: string
  expiresAt: number
  endpoint: string
  endpointOrigin: string
  proofUrl: string
  nodeWalletAddress: Address
  currentAgentWallet: Address | null
  delegatedWalletContractReady: boolean
  requiresDelegatedWalletUpdate: boolean
  operatorMessage: string
  nodeMessage: string
}

export interface NodeProofVerification {
  verified: true
  challengeId: string
  nodeWalletAddress: Address
  endpointOrigin: string
  proofUrl: string
  verifiedAt: number
}

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

export interface NodeProofSigner {
  getNodeWalletAddress(): Promise<Address>
  signNodeMessage(message: string): Promise<{
    address: Address
    signature: `0x${string}`
  }>
}

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

function getSimpleAccountFactoryAddress(): Address | null {
  try {
    return getContract('accountAbstraction', 'simpleAccountFactory', NETWORK) as Address
  } catch {
    return null
  }
}

function normalizeAddress(address: Address | string | null | undefined) {
  return address?.toLowerCase() ?? ''
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
  const proofUrl = new URL(NODE_PROOF_PATH, originUrl)

  return {
    endpoint: url.toString(),
    endpointOrigin: originUrl.toString().replace(/\/$/, ''),
    proofUrl: proofUrl.toString(),
  }
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

async function predictSimpleAccountOwner(
  ownerAddress: Address,
): Promise<Address | null> {
  const factoryAddress = getSimpleAccountFactoryAddress()
  if (!factoryAddress) return null

  try {
    return (await getClient().readContract({
      address: factoryAddress,
      abi: SIMPLE_ACCOUNT_FACTORY_ABI,
      functionName: 'getAddress',
      args: [ownerAddress, 0n],
    })) as Address
  } catch {
    return null
  }
}

async function isAuthorizedAgentController(
  identityRegistry: Address,
  agentId: bigint,
  operatorAddress: Address,
): Promise<boolean> {
  const owner = await getAgentOwner(identityRegistry, agentId)
  if (normalizeAddress(owner) === normalizeAddress(operatorAddress)) {
    return true
  }

  const predictedSmartAccount = await predictSimpleAccountOwner(operatorAddress)
  return normalizeAddress(predictedSmartAccount) === normalizeAddress(owner)
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

export function createNodeProofService(signer: NodeProofSigner) {
  const challenges = new Map<string, ChallengeRecord>()

  function cleanupExpiredChallenges() {
    const now = Date.now()
    for (const [challengeId, record] of challenges.entries()) {
      if (record.expiresAt <= now) {
        challenges.delete(challengeId)
      }
    }
  }

  async function createChallenge(body: unknown): Promise<NodeProofChallenge> {
    cleanupExpiredChallenges()

    const identityRegistry = getIdentityRegistryAddress()
    if (!identityRegistry) {
      throw new Error('Identity registry not configured')
    }

    const validBody = expectValid(
      ChallengeRequestSchema,
      body,
      'Node registration challenge request',
    )

    const operatorAgentId = BigInt(validBody.operatorAgentId)
    const authorized = await isAuthorizedAgentController(
      identityRegistry,
      operatorAgentId,
      validBody.operatorAddress as Address,
    )
    if (!authorized) {
      throw new Error('Selected agent is not owned by the provided wallet')
    }

    const endpoint = normalizeEndpoint(validBody.endpoint)
    const nodeWalletAddress = await signer.getNodeWalletAddress()
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
      nodeWalletAddress,
      issuedAt,
      expiresAt,
    }

    const record: ChallengeRecord = {
      ...baseRecord,
      operatorMessage: buildOperatorMessage(baseRecord),
      nodeMessage: buildNodeMessage(baseRecord),
    }

    challenges.set(challengeId, record)

    const currentAgentWallet = await getAgentWallet(identityRegistry, operatorAgentId)

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
  }

  async function verifyChallenge(body: unknown): Promise<NodeProofVerification> {
    cleanupExpiredChallenges()

    const identityRegistry = getIdentityRegistryAddress()
    if (!identityRegistry) {
      throw new Error('Identity registry not configured')
    }

    const validBody = expectValid(
      VerifyRequestSchema,
      body,
      'Node registration verification request',
    )
    const challenge = challenges.get(validBody.challengeId)

    if (!challenge) {
      throw new Error('Challenge not found or expired')
    }
    if (challenge.expiresAt <= Date.now()) {
      challenges.delete(challenge.challengeId)
      throw new Error('Challenge expired')
    }

    const operatorAuthorized = await isAuthorizedAgentController(
      identityRegistry,
      challenge.operatorAgentId,
      challenge.operatorAddress,
    )
    if (!operatorAuthorized) {
      throw new Error('Agent ownership changed before verification completed')
    }

    const currentAgentWallet = await getAgentWallet(
      identityRegistry,
      challenge.operatorAgentId,
    )
    if (currentAgentWallet === null) {
      throw new Error(
        'Identity registry does not expose delegated wallet methods on this deployment yet',
      )
    }
    if (
      normalizeAddress(currentAgentWallet) !==
      normalizeAddress(challenge.nodeWalletAddress)
    ) {
      const error = new Error(
        'Delegated node wallet is not authorized on-chain for this agent yet',
      ) as Error & {
        expectedNodeWalletAddress?: Address
        currentAgentWallet?: Address
      }
      error.expectedNodeWalletAddress = challenge.nodeWalletAddress
      error.currentAgentWallet = currentAgentWallet
      throw error
    }

    const operatorSignatureValid = await verifyMessage({
      address: challenge.operatorAddress,
      message: challenge.operatorMessage,
      signature: validBody.operatorSignature as `0x${string}`,
    })

    if (!operatorSignatureValid) {
      throw new Error('Operator signature verification failed')
    }

    const proofResponse = await fetch(challenge.proofUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)

    if (!proofResponse || !proofResponse.ok) {
      throw new Error('Failed to fetch proof document from the claimed endpoint')
    }

    const proofJson = await proofResponse.json()
    const proof = expectValid(ProofDocumentSchema, proofJson, 'Node proof document')

    if (proof.challengeId !== challenge.challengeId) {
      throw new Error('Proof document challenge ID mismatch')
    }
    if (
      normalizeAddress(proof.nodeWalletAddress) !==
      normalizeAddress(challenge.nodeWalletAddress)
    ) {
      throw new Error('Proof document signer address mismatch')
    }
    if (proof.endpointOrigin !== challenge.endpointOrigin) {
      throw new Error('Proof document endpoint origin mismatch')
    }
    if (proof.message !== challenge.nodeMessage) {
      throw new Error('Proof document message mismatch')
    }

    const nodeProofValid = await verifyMessage({
      address: challenge.nodeWalletAddress,
      message: challenge.nodeMessage,
      signature: proof.signature as `0x${string}`,
    })

    if (!nodeProofValid) {
      throw new Error('Node proof signature verification failed')
    }

    return {
      verified: true,
      challengeId: challenge.challengeId,
      nodeWalletAddress: challenge.nodeWalletAddress,
      endpointOrigin: challenge.endpointOrigin,
      proofUrl: challenge.proofUrl,
      verifiedAt: Date.now(),
    }
  }

  async function getProof(
    requestUrl: string,
    challengeId: string,
  ): Promise<z.infer<typeof ProofDocumentSchema>> {
    cleanupExpiredChallenges()

    const challenge = challenges.get(challengeId)
    if (!challenge) {
      throw new Error('Challenge not found or expired')
    }
    if (challenge.expiresAt <= Date.now()) {
      challenges.delete(challenge.challengeId)
      throw new Error('Challenge expired')
    }

    const signed = await signer.signNodeMessage(challenge.nodeMessage)

    return {
      challengeId: challenge.challengeId,
      operatorAddress: challenge.operatorAddress,
      operatorAgentId: Number(challenge.operatorAgentId),
      endpointOrigin: challenge.endpointOrigin,
      nodeWalletAddress: signed.address,
      message: challenge.nodeMessage,
      signature: signed.signature,
      signedAt: Date.now(),
    }
  }

  return {
    createChallenge,
    verifyChallenge,
    getProof,
  }
}
