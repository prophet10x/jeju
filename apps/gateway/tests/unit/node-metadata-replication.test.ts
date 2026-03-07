import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import {
  DEFAULT_NODE_METADATA_MAX_REPLICAS,
  DEFAULT_NODE_METADATA_MIN_REPLICAS,
  NodeMetadataReplicationService,
  resolveReplicaPolicy,
  selectReplicationCandidates,
  type MetadataReplicationTarget,
} from '../../api/services/node-metadata-replication'

const MANAGER_ADDRESS = '0x965535ae2A6Da281c31FbDbD56D93ECB5cb139a0' as Address
const SAMPLE_NODE_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
const SAMPLE_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

function makeTargets(count: number): MetadataReplicationTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `target-${index + 1}`,
    apiUrl: `https://target-${index + 1}.example.com/storage`,
  }))
}

class TestReplicationService extends NodeMetadataReplicationService {
  constructor(
    targets: MetadataReplicationTarget[],
    dependencies: ConstructorParameters<typeof NodeMetadataReplicationService>[1],
  ) {
    super(
      {
        rpcUrl: 'https://example-rpc.invalid',
        managerAddress: MANAGER_ADDRESS,
        sourceGatewayUrl: 'https://source.example.com/storage',
        targets,
        minReplicas: DEFAULT_NODE_METADATA_MIN_REPLICAS,
        maxReplicas: DEFAULT_NODE_METADATA_MAX_REPLICAS,
      },
      dependencies,
    )
  }

  async loadNodeMetadataRecords() {
    return [
      {
        nodeId: SAMPLE_NODE_ID,
        metadataURI: `ipfs://${SAMPLE_CID}`,
        cid: SAMPLE_CID,
      },
    ]
  }
}

describe('node metadata replication policy', () => {
  test('caps deterministic candidate set at maxReplicas', () => {
    const targets = makeTargets(20)
    const candidates = selectReplicationCandidates(
      SAMPLE_CID,
      targets,
      DEFAULT_NODE_METADATA_MAX_REPLICAS,
    )

    expect(candidates).toHaveLength(15)
    expect(
      selectReplicationCandidates(
        SAMPLE_CID,
        targets,
        DEFAULT_NODE_METADATA_MAX_REPLICAS,
      ),
    ).toEqual(candidates)
  })

  test('uses min=8 and max=15 replica policy by default', () => {
    expect(
      resolveReplicaPolicy(
        20,
        DEFAULT_NODE_METADATA_MIN_REPLICAS,
        DEFAULT_NODE_METADATA_MAX_REPLICAS,
      ),
    ).toEqual({
      candidateCount: 15,
      requiredReplicaCount: 8,
    })
  })

  test('stops uploading once the minimum replica count is reached', async () => {
    const targets = makeTargets(20)
    const expectedPrimaries = selectReplicationCandidates(
      SAMPLE_CID,
      targets,
      DEFAULT_NODE_METADATA_MAX_REPLICAS,
    ).slice(0, DEFAULT_NODE_METADATA_MIN_REPLICAS)
    const uploadTargets: string[] = []
    let retrieveCalls = 0

    const service = new TestReplicationService(targets, {
      fileExistsOnIPFS: async () => false,
      retrieveFromIPFS: async () => {
        retrieveCalls += 1
        return new Blob(['node-metadata'])
      },
      uploadToIPFS: async (apiUrl) => {
        uploadTargets.push(apiUrl)
        return SAMPLE_CID
      },
    })

    const result = await service.replicateOnce()

    expect(result.errors).toEqual([])
    expect(result.replicatedWrites).toBe(DEFAULT_NODE_METADATA_MIN_REPLICAS)
    expect(retrieveCalls).toBe(1)
    expect(uploadTargets).toEqual(expectedPrimaries.map((target) => target.apiUrl))
  })

  test('spills into backup candidates when early uploads fail', async () => {
    const targets = makeTargets(20)
    const candidateTargets = selectReplicationCandidates(
      SAMPLE_CID,
      targets,
      DEFAULT_NODE_METADATA_MAX_REPLICAS,
    )
    const failingTargets = new Set(candidateTargets.slice(0, 2).map((target) => target.apiUrl))
    const uploadAttempts: string[] = []

    const service = new TestReplicationService(targets, {
      fileExistsOnIPFS: async () => false,
      retrieveFromIPFS: async () => new Blob(['node-metadata']),
      uploadToIPFS: async (apiUrl) => {
        uploadAttempts.push(apiUrl)
        if (failingTargets.has(apiUrl)) {
          throw new Error(`failed ${apiUrl}`)
        }
        return SAMPLE_CID
      },
    })

    const result = await service.replicateOnce()

    expect(result.replicatedWrites).toBe(DEFAULT_NODE_METADATA_MIN_REPLICAS)
    expect(result.errors).toHaveLength(2)
    expect(uploadAttempts).toEqual(
      candidateTargets
        .slice(0, DEFAULT_NODE_METADATA_MIN_REPLICAS + failingTargets.size)
        .map((target) => target.apiUrl),
    )
  })
})
