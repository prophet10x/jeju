import { getContractsConfig, getCurrentNetwork, getServicesConfig } from '@jejunetwork/config'
import {
  fileExistsOnIPFS,
  retrieveFromIPFS,
  toIpfsMetadataUri,
  uploadToIPFS,
} from '@jejunetwork/shared'
import {
  type Address,
  createPublicClient,
  http,
  isAddress,
  parseAbi,
} from 'viem'
import { getChain } from '../../lib/chains'
import { getRpcUrl, JEJU_CHAIN_ID } from '../../lib/config/networks'

const NODE_STAKING_METADATA_ABI = parseAbi([
  'function getAllNodes() view returns (bytes32[])',
  'function getNodeMetadataURI(bytes32 nodeId) view returns (string)',
])

export interface MetadataReplicationTarget {
  name: string
  apiUrl: string
}

export interface NodeMetadataRecord {
  nodeId: `0x${string}`
  metadataURI: string
  cid: string
}

export interface NodeMetadataReplicationResult {
  nodesScanned: number
  uniqueCids: number
  replicatedWrites: number
  skippedExisting: number
  mismatchedUploads: Array<{
    target: string
    nodeId: `0x${string}`
    expectedCid: string
    actualCid: string
  }>
  errors: Array<{
    target?: string
    nodeId?: `0x${string}`
    cid?: string
    message: string
  }>
}

function parseCsvOrJsonList(value: string | undefined): string[] {
  if (!value) return []

  const trimmed = value.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => String(entry).trim())
          .filter((entry) => entry.length > 0)
      }
    } catch {
      // Fall through to CSV parsing.
    }
  }

  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function normalizeStorageApiUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function parseReplicationTargets(raw: string | undefined): MetadataReplicationTarget[] {
  return parseCsvOrJsonList(raw).map((entry, index) => {
    const [namePart, urlPart] = entry.includes('=')
      ? entry.split('=', 2)
      : [`target-${index + 1}`, entry]

    return {
      name: namePart.trim() || `target-${index + 1}`,
      apiUrl: normalizeStorageApiUrl(urlPart.trim()),
    }
  })
}

function normalizeMetadataCid(metadataURI: string): string | null {
  const normalized = toIpfsMetadataUri(metadataURI)
  if (!normalized.startsWith('ipfs://')) return null
  const cid = normalized.slice('ipfs://'.length).trim()
  return cid.length > 0 ? cid : null
}

export function getDefaultMetadataReplicationConfig() {
  const network = getCurrentNetwork()
  const contracts = getContractsConfig(network)
  const services = getServicesConfig(network)
  const managerAddress = process.env.NODE_METADATA_REPLICATION_MANAGER_ADDRESS
    ?? contracts.nodeStaking?.managerV2
    ?? contracts.nodeStaking?.manager
  const sourceGatewayUrl = (
    process.env.NODE_METADATA_REPLICATION_SOURCE_GATEWAY
    ?? services.storage?.ipfsGateway
  )?.replace(/\/+$/, '')

  return {
    rpcUrl: process.env.NODE_METADATA_REPLICATION_RPC_URL ?? getRpcUrl(JEJU_CHAIN_ID),
    managerAddress:
      managerAddress && isAddress(managerAddress)
        ? (managerAddress as Address)
        : null,
    sourceGatewayUrl: sourceGatewayUrl ?? '',
    targets: parseReplicationTargets(
      process.env.NODE_METADATA_REPLICATION_TARGETS,
    ),
  }
}

export class NodeMetadataReplicationService {
  private readonly publicClient

  constructor(
    private readonly config: {
      rpcUrl: string
      managerAddress: Address
      sourceGatewayUrl: string
      targets: MetadataReplicationTarget[]
    },
  ) {
    this.publicClient = createPublicClient({
      chain: getChain(JEJU_CHAIN_ID),
      transport: http(this.config.rpcUrl),
    })
  }

  async loadNodeMetadataRecords(): Promise<NodeMetadataRecord[]> {
    const nodeIds = (await this.publicClient.readContract({
      address: this.config.managerAddress,
      abi: NODE_STAKING_METADATA_ABI,
      functionName: 'getAllNodes',
    })) as `0x${string}`[]

    if (nodeIds.length === 0) return []

    const metadataResults = await this.publicClient.multicall({
      allowFailure: true,
      contracts: nodeIds.map((nodeId) => ({
        address: this.config.managerAddress,
        abi: NODE_STAKING_METADATA_ABI,
        functionName: 'getNodeMetadataURI' as const,
        args: [nodeId] as const,
      })),
    })

    return nodeIds
      .map<NodeMetadataRecord | null>((nodeId, index) => {
        const result = metadataResults[index]
        if (!result || result.status !== 'success') return null
        const metadataURI = result.result
        if (typeof metadataURI !== 'string' || metadataURI.length === 0) {
          return null
        }
        const cid = normalizeMetadataCid(metadataURI)
        if (!cid) return null
        return { nodeId, metadataURI, cid }
      })
      .filter((record): record is NodeMetadataRecord => record !== null)
  }

  async replicateOnce(): Promise<NodeMetadataReplicationResult> {
    const records = await this.loadNodeMetadataRecords()
    const uniqueRecords = Array.from(
      new Map(records.map((record) => [record.cid, record])).values(),
    )
    const result: NodeMetadataReplicationResult = {
      nodesScanned: records.length,
      uniqueCids: uniqueRecords.length,
      replicatedWrites: 0,
      skippedExisting: 0,
      mismatchedUploads: [],
      errors: [],
    }

    if (uniqueRecords.length === 0 || this.config.targets.length === 0) {
      return result
    }

    const blobCache = new Map<string, Blob>()

    for (const record of uniqueRecords) {
      for (const target of this.config.targets) {
        try {
          const alreadyPresent = await fileExistsOnIPFS(target.apiUrl, record.cid)
          if (alreadyPresent) {
            result.skippedExisting += 1
            continue
          }

          let content = blobCache.get(record.cid)
          if (!content) {
            content = await retrieveFromIPFS(this.config.sourceGatewayUrl, record.cid)
            blobCache.set(record.cid, content)
          }

          const uploadedCid = await uploadToIPFS(target.apiUrl, content)
          if (uploadedCid !== record.cid) {
            result.mismatchedUploads.push({
              target: target.name,
              nodeId: record.nodeId,
              expectedCid: record.cid,
              actualCid: uploadedCid,
            })
            continue
          }

          result.replicatedWrites += 1
        } catch (error) {
          result.errors.push({
            target: target.name,
            nodeId: record.nodeId,
            cid: record.cid,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    return result
  }
}

export async function runNodeMetadataReplicationOnce() {
  const config = getDefaultMetadataReplicationConfig()
  if (!config.managerAddress) {
    throw new Error('NODE_METADATA_REPLICATION_MANAGER_ADDRESS is not configured')
  }
  if (!config.sourceGatewayUrl) {
    throw new Error('NODE_METADATA_REPLICATION_SOURCE_GATEWAY is not configured')
  }

  const service = new NodeMetadataReplicationService({
    rpcUrl: config.rpcUrl,
    managerAddress: config.managerAddress,
    sourceGatewayUrl: config.sourceGatewayUrl,
    targets: config.targets,
  })

  return service.replicateOnce()
}
