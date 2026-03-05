import { type Address, decodeEventLog, type Hex, type PublicClient } from 'viem'
import type { NodeIdentityMetadata, NodeServiceId } from './node-services'

export const IDENTITY_REGISTRY_ABI = [
  {
    inputs: [
      { internalType: 'string', name: 'tokenURI_', type: 'string' },
      {
        components: [
          { internalType: 'string', name: 'key', type: 'string' },
          { internalType: 'bytes', name: 'value', type: 'bytes' },
        ],
        internalType: 'struct IIdentityRegistry.MetadataEntry[]',
        name: 'metadata',
        type: 'tuple[]',
      },
    ],
    name: 'register',
    outputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'offset', type: 'uint256' },
      { internalType: 'uint256', name: 'limit', type: 'uint256' },
    ],
    name: 'getAllAgents',
    outputs: [
      { internalType: 'uint256[]', name: 'agentIds', type: 'uint256[]' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getAgentTags',
    outputs: [{ internalType: 'string[]', name: 'tags', type: 'string[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getServiceType',
    outputs: [{ internalType: 'string', name: 'serviceType', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getCategory',
    outputs: [{ internalType: 'string', name: 'category', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getAgentWallet',
    outputs: [{ internalType: 'address', name: 'wallet', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    name: 'agents',
    outputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'uint8', name: 'tier', type: 'uint8' },
      { internalType: 'address', name: 'stakedToken', type: 'address' },
      { internalType: 'uint256', name: 'stakedAmount', type: 'uint256' },
      { internalType: 'uint256', name: 'registeredAt', type: 'uint256' },
      { internalType: 'uint256', name: 'lastActivityAt', type: 'uint256' },
      { internalType: 'bool', name: 'isBanned', type: 'bool' },
      { internalType: 'bool', name: 'isSlashed', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string', name: 'serviceType', type: 'string' },
    ],
    name: 'setServiceType',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string', name: 'category', type: 'string' },
    ],
    name: 'setCategory',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string[]', name: 'tags_', type: 'string[]' },
    ],
    name: 'updateTags',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

export const REGISTERED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'agentId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
      { indexed: false, internalType: 'uint8', name: 'tier', type: 'uint8' },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'stakedAmount',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'tokenURI',
        type: 'string',
      },
    ],
    name: 'Registered',
    type: 'event',
  },
] as const

const TRANSFER_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      {
        indexed: true,
        internalType: 'uint256',
        name: 'tokenId',
        type: 'uint256',
      },
    ],
    name: 'Transfer',
    type: 'event',
  },
] as const

export const NODE_REGISTERED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'nodeId',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'operator',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'stakingToken',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'rewardToken',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'stakeAmount',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'stakeValueUSD',
        type: 'uint256',
      },
    ],
    name: 'NodeRegistered',
    type: 'event',
  },
] as const

export const NODE_IDENTITY_LINKED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'nodeId',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'uint256',
        name: 'nodeIdentityAgentId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'uint256',
        name: 'operatorAgentId',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
    ],
    name: 'NodeIdentityLinked',
    type: 'event',
  },
] as const

export interface IdentityRegistryMetadataEntry {
  key: string
  value: Hex
}

export interface OwnedAgentIdentity {
  id: string
  name: string
  owner: string
  tokenURI: string
  serviceType: string
  category: string
  tags: string[]
  tier: string
}

export interface OwnedIdentityLookupResult {
  agents: OwnedAgentIdentity[]
  smartAccountAddress: string | null
}

export interface NodeIdentityPresentation {
  category: string
  serviceType: string
  tags: string[]
}

function hasOwnRecordKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key)
}

type ContractReadResult<T> =
  | { status: 'success'; result: T }
  | { status: 'failure'; error: unknown }

function encodeUtf8Hex(value: string): Hex {
  const bytes = new TextEncoder().encode(value)
  return `0x${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}` as Hex
}

function normalizeAddress(value: string | Address | null | undefined): string {
  return value?.toLowerCase() ?? ''
}

function parseTokenUriJson(tokenURI: string): Record<string, unknown> | null {
  if (!tokenURI) return null

  try {
    return JSON.parse(tokenURI) as Record<string, unknown>
  } catch {
    // Continue to data URI parsing.
  }

  if (tokenURI.startsWith('data:application/json;base64,')) {
    try {
      const encoded = tokenURI.slice('data:application/json;base64,'.length)
      if (typeof atob !== 'function') {
        return null
      }

      const decoded = atob(encoded)
      return JSON.parse(decoded) as Record<string, unknown>
    } catch {
      return null
    }
  }

  if (tokenURI.startsWith('data:application/json,')) {
    try {
      const encoded = tokenURI.slice('data:application/json,'.length)
      return JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>
    } catch {
      return null
    }
  }

  return null
}

function parseAgentName(tokenURI: string): string {
  const parsed = parseTokenUriJson(tokenURI)
  const rawName = parsed?.name
  return typeof rawName === 'string' ? rawName : ''
}

export function isNodeIdentityAgent(
  agent: Pick<OwnedAgentIdentity, 'tokenURI'>,
): boolean {
  const parsed = parseTokenUriJson(agent.tokenURI)
  if (!parsed) return false

  const description =
    typeof parsed.description === 'string'
      ? parsed.description.toLowerCase()
      : ''

  if (description.includes('node identity for operator agent')) {
    return true
  }

  const hasOperatorAgentId = hasOwnRecordKey(parsed, 'operatorAgentId')
  const hasNodeId = hasOwnRecordKey(parsed, 'nodeId')
  const hasServices = Array.isArray(parsed.services)
  const hasEndpoint = hasOwnRecordKey(parsed, 'rpcUrl')

  return hasOperatorAgentId && (hasNodeId || hasServices || hasEndpoint)
}

function definedString(value: bigint | number | string | undefined): string {
  if (value === undefined) return ''
  return String(value)
}

async function readContractsWithFallback<T>(params: {
  publicClient: PublicClient
  contracts: Array<{
    address: Address
    abi: typeof IDENTITY_REGISTRY_ABI
    functionName:
      | 'ownerOf'
      | 'tokenURI'
      | 'getServiceType'
      | 'getCategory'
      | 'getAgentTags'
      | 'agents'
    args: readonly [bigint]
  }>
}): Promise<Array<ContractReadResult<T>>> {
  const { publicClient, contracts } = params

  try {
    return (await publicClient.multicall({
      contracts,
      allowFailure: true,
    })) as Array<ContractReadResult<T>>
  } catch {
    return Promise.all(
      contracts.map(async (contract) => {
        try {
          const result = (await publicClient.readContract(contract)) as T
          return { status: 'success', result } satisfies ContractReadResult<T>
        } catch (error) {
          return { status: 'failure', error } satisfies ContractReadResult<T>
        }
      }),
    )
  }
}

export function buildNodeIdentityPresentation(
  services: NodeServiceId[],
): NodeIdentityPresentation {
  const MAX_ONCHAIN_TAGS = 10
  const uniqueServices = Array.from(new Set(services.filter(Boolean)))
  const tags = Array.from(new Set(['node', ...uniqueServices])).slice(
    0,
    MAX_ONCHAIN_TAGS,
  )

  return {
    category: 'service',
    serviceType: uniqueServices[0] ?? 'node',
    tags,
  }
}

export function buildNodeIdentityTokenUri(
  metadata: NodeIdentityMetadata,
): string {
  const presentation = buildNodeIdentityPresentation(metadata.services)
  return JSON.stringify({
    name:
      metadata.nodeName ||
      `${presentation.serviceType
        .split('-')
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ')} Node`,
    description: `Node identity for operator agent #${metadata.operatorAgentId}`,
    nodeId: metadata.nodeId ?? null,
    operatorAgentId: metadata.operatorAgentId,
    services: metadata.services,
    rpcUrl: metadata.rpcUrl,
    region: metadata.region,
    status: metadata.status,
    createdAt: new Date().toISOString(),
  })
}

export function buildNodeIdentityMetadataEntries(
  metadata: NodeIdentityMetadata,
): IdentityRegistryMetadataEntry[] {
  const entries: Array<[string, string]> = [
    ['nodeId', metadata.nodeId ?? ''],
    ['operatorAgentId', definedString(metadata.operatorAgentId)],
    ['rpcUrl', metadata.rpcUrl],
    ['region', metadata.region],
    ['services', JSON.stringify(metadata.services)],
    ['serviceTags', JSON.stringify(metadata.serviceTags ?? metadata.services)],
    ['nodeName', metadata.nodeName ?? ''],
    ['zone', metadata.zone ?? ''],
    ['cpuCores', definedString(metadata.cpuCores)],
    ['memoryGb', definedString(metadata.memoryGb)],
    ['diskGb', definedString(metadata.diskGb)],
    ['stakingToken', metadata.stakingToken],
    ['stakeAmount', definedString(metadata.stakeAmount)],
    ['rewardToken', metadata.rewardToken],
    ['status', metadata.status],
  ]

  return entries
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => ({
      key,
      value: encodeUtf8Hex(value),
    }))
}

export async function fetchOwnedAgentIdentities(params: {
  publicClient: PublicClient
  registryAddress: Address
  ownerAddresses: readonly string[]
  pageSize?: number
  maxAgents?: number
}): Promise<OwnedAgentIdentity[]> {
  const { publicClient, registryAddress } = params
  const pageSize = BigInt(params.pageSize ?? 100)
  const maxAgents = BigInt(params.maxAgents ?? 500)
  const owners = new Set(
    params.ownerAddresses
      .map((address) => normalizeAddress(address))
      .filter((address) => address.length > 0),
  )

  if (owners.size === 0) {
    return []
  }

  let allAgentIds: bigint[] = []
  let offset = 0n

  try {
    while (offset < maxAgents) {
      const page = (await publicClient.readContract({
        address: registryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'getAllAgents',
        args: [offset, pageSize],
      })) as bigint[]

      if (page.length === 0) break

      allAgentIds.push(...page)
      if (page.length < Number(pageSize)) break
      offset += pageSize
    }
  } catch {
    const discoveredAgentIds = new Set<bigint>()

    for (const owner of owners) {
      const [registeredLogs, receivedTransferLogs] = await Promise.all([
        publicClient.getLogs({
          address: registryAddress,
          event: REGISTERED_EVENT_ABI[0],
          args: { owner: owner as Address },
          fromBlock: 0n,
          toBlock: 'latest',
        }),
        publicClient.getLogs({
          address: registryAddress,
          event: TRANSFER_EVENT_ABI[0],
          args: { to: owner as Address },
          fromBlock: 0n,
          toBlock: 'latest',
        }),
      ])

      for (const log of registeredLogs) {
        const agentId = log.args.agentId
        if (agentId !== undefined) {
          discoveredAgentIds.add(agentId)
        }
      }

      for (const log of receivedTransferLogs) {
        if (log.args.tokenId !== undefined) {
          discoveredAgentIds.add(log.args.tokenId)
        }
      }
    }

    allAgentIds = Array.from(discoveredAgentIds)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, Number(maxAgents))
  }

  if (allAgentIds.length === 0) {
    return []
  }

  const ownerResults = await readContractsWithFallback<Address>({
    publicClient,
    contracts: allAgentIds.map((agentId) => ({
      address: registryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'ownerOf',
      args: [agentId],
    })),
  })

  const ownedAgentIds = allAgentIds.filter((_, index) => {
    const ownerResult = ownerResults[index]
    return (
      ownerResult.status === 'success' &&
      owners.has(normalizeAddress(ownerResult.result))
    )
  })

  if (ownedAgentIds.length === 0) {
    return []
  }

  const [
    tokenUriResults,
    serviceTypeResults,
    categoryResults,
    tagResults,
    agentResults,
  ] = await Promise.all([
    readContractsWithFallback<string>({
      publicClient,
      contracts: ownedAgentIds.map((agentId) => ({
        address: registryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'tokenURI',
        args: [agentId],
      })),
    }),
    readContractsWithFallback<string>({
      publicClient,
      contracts: ownedAgentIds.map((agentId) => ({
        address: registryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'getServiceType',
        args: [agentId],
      })),
    }),
    readContractsWithFallback<string>({
      publicClient,
      contracts: ownedAgentIds.map((agentId) => ({
        address: registryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'getCategory',
        args: [agentId],
      })),
    }),
    readContractsWithFallback<string[]>({
      publicClient,
      contracts: ownedAgentIds.map((agentId) => ({
        address: registryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'getAgentTags',
        args: [agentId],
      })),
    }),
    readContractsWithFallback<{
      agentId: bigint
      owner: Address
      tier: number
      stakedToken: Address
      stakedAmount: bigint
      registeredAt: bigint
      lastActivityAt: bigint
      isBanned: boolean
      isSlashed: boolean
    }>({
      publicClient,
      contracts: ownedAgentIds.map((agentId) => ({
        address: registryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'agents',
        args: [agentId],
      })),
    }),
  ])

  return ownedAgentIds
    .map<OwnedAgentIdentity | null>((agentId, index) => {
      const ownerResult = ownerResults[allAgentIds.indexOf(agentId)]
      if (!ownerResult || ownerResult.status !== 'success') return null

      const tokenURI =
        tokenUriResults[index]?.status === 'success'
          ? tokenUriResults[index].result
          : ''
      const serviceType =
        serviceTypeResults[index]?.status === 'success'
          ? serviceTypeResults[index].result
          : ''
      const category =
        categoryResults[index]?.status === 'success'
          ? categoryResults[index].result
          : ''
      const tags =
        tagResults[index]?.status === 'success' ? tagResults[index].result : []
      const tierValue =
        agentResults[index]?.status === 'success'
          ? agentResults[index].result.tier
          : 0

      return {
        id: agentId.toString(),
        name: parseAgentName(tokenURI),
        owner: ownerResult.result,
        tokenURI,
        serviceType,
        category,
        tags,
        tier: String(tierValue),
      }
    })
    .filter((agent): agent is OwnedAgentIdentity => agent !== null)
}

export function getRegisteredAgentIdFromReceipt(receipt: {
  logs: Array<{ data: Hex; topics: readonly Hex[] }>
}): bigint | undefined {
  for (const log of receipt.logs) {
    try {
      const topics = (log.topics.length > 0 ? [...log.topics] : []) as
        | []
        | [Hex, ...Hex[]]
      const decoded = decodeEventLog({
        abi: REGISTERED_EVENT_ABI,
        data: log.data,
        topics,
      })

      if (decoded.eventName === 'Registered') {
        return decoded.args.agentId
      }
    } catch {
      // Ignore unrelated logs.
    }
  }

  return undefined
}

export function getNodeRegisteredIdFromReceipt(receipt: {
  logs: Array<{ data: Hex; topics: readonly Hex[] }>
}): Hex | undefined {
  for (const log of receipt.logs) {
    try {
      const topics = (log.topics.length > 0 ? [...log.topics] : []) as
        | []
        | [Hex, ...Hex[]]
      const decoded = decodeEventLog({
        abi: NODE_REGISTERED_EVENT_ABI,
        data: log.data,
        topics,
      })

      if (decoded.eventName === 'NodeRegistered') {
        return decoded.args.nodeId
      }
    } catch {
      // Ignore unrelated logs.
    }
  }

  return undefined
}

export function getNodeIdentityLinkedAgentIdFromReceipt(receipt: {
  logs: Array<{ data: Hex; topics: readonly Hex[] }>
}): bigint | undefined {
  for (const log of receipt.logs) {
    try {
      const topics = (log.topics.length > 0 ? [...log.topics] : []) as
        | []
        | [Hex, ...Hex[]]
      const decoded = decodeEventLog({
        abi: NODE_IDENTITY_LINKED_EVENT_ABI,
        data: log.data,
        topics,
      })

      if (decoded.eventName === 'NodeIdentityLinked') {
        return decoded.args.nodeIdentityAgentId
      }
    } catch {
      // Ignore unrelated logs.
    }
  }

  return undefined
}

export async function fetchAgentWallet(params: {
  publicClient: PublicClient
  registryAddress: Address
  agentId: bigint
}): Promise<Address | null> {
  const { publicClient, registryAddress, agentId } = params

  try {
    const wallet = (await publicClient.readContract({
      address: registryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'getAgentWallet',
      args: [agentId],
    })) as Address

    return normalizeAddress(wallet) ===
      normalizeAddress('0x0000000000000000000000000000000000000000')
      ? null
      : wallet
  } catch {
    return null
  }
}

export async function waitForAgentWallet(params: {
  publicClient: PublicClient
  registryAddress: Address
  agentId: bigint
  expectedWallet: Address
  attempts?: number
  delayMs?: number
}): Promise<Address | null> {
  const {
    publicClient,
    registryAddress,
    agentId,
    expectedWallet,
    attempts = 6,
    delayMs = 1250,
  } = params

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const currentWallet = await fetchAgentWallet({
      publicClient,
      registryAddress,
      agentId,
    })

    if (
      currentWallet &&
      normalizeAddress(currentWallet) === normalizeAddress(expectedWallet)
    ) {
      return currentWallet
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  return null
}
