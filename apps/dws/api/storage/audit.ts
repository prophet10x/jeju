import { hash256 } from '@jejunetwork/shared'
import { type Hex, keccak256 } from 'viem'
import {
  createCommitment,
  createOpeningProof,
  verifyProof,
} from '../da/commitment'
import type { BlobCommitment, Chunk } from '../da/types'
import type { ContentAuditCommitment } from './types'

export const DEFAULT_STORAGE_CHUNK_SIZE = 64 * 1024

function splitIntoChunks(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.slice(offset, Math.min(offset + chunkSize, data.length)))
  }
  if (chunks.length === 0) {
    chunks.push(new Uint8Array())
  }
  return chunks
}

function computeBlobId(data: Uint8Array): Hex {
  return keccak256(data)
}

export function createStorageAuditCommitment(
  data: Uint8Array,
  chunkSize = DEFAULT_STORAGE_CHUNK_SIZE,
): {
  blobId: Hex
  blobCommitment: BlobCommitment
  audit: ContentAuditCommitment
} {
  const chunks = splitIntoChunks(data, chunkSize)
  const blobCommitment = createCommitment(chunks, chunkSize, chunks.length, 0)
  return {
    blobId: computeBlobId(data),
    blobCommitment,
    audit: {
      commitment: blobCommitment.commitment,
      merkleRoot: blobCommitment.merkleRoot,
      chunkSize: blobCommitment.chunkSize,
      chunkCount: blobCommitment.totalChunkCount,
      storedSha256: Buffer.from(hash256(data)).toString('hex'),
      timestamp: blobCommitment.timestamp,
    },
  }
}

export function blobCommitmentFromAudit(
  audit: ContentAuditCommitment,
): BlobCommitment {
  return {
    commitment: audit.commitment,
    dataChunkCount: audit.chunkCount,
    parityChunkCount: 0,
    totalChunkCount: audit.chunkCount,
    chunkSize: audit.chunkSize,
    merkleRoot: audit.merkleRoot,
    timestamp: audit.timestamp,
  }
}

export function getAuditChunks(
  data: Uint8Array,
  indices: number[],
  chunkSize = DEFAULT_STORAGE_CHUNK_SIZE,
): {
  blobId: Hex
  blobCommitment: BlobCommitment
  audit: ContentAuditCommitment
  chunks: Chunk[]
} {
  const { blobId, blobCommitment, audit } = createStorageAuditCommitment(
    data,
    chunkSize,
  )
  const allChunks = splitIntoChunks(data, chunkSize)
  const chunks = indices.map((index) => ({
    index,
    data: allChunks[index] ?? new Uint8Array(),
    blobId,
    proof: createOpeningProof(allChunks, index, blobCommitment),
  }))

  return { blobId, blobCommitment, audit, chunks }
}

export function verifyAuditChunks(
  chunks: Chunk[],
  blobCommitment: BlobCommitment,
): { valid: boolean; invalidIndices: number[] } {
  const invalidIndices = chunks
    .filter((chunk) => !verifyProof(chunk, blobCommitment))
    .map((chunk) => chunk.index)

  return {
    valid: invalidIndices.length === 0,
    invalidIndices,
  }
}

export function pickRandomChunkIndices(
  chunkCount: number,
  requestedCount: number,
): number[] {
  const count = Math.max(1, Math.min(requestedCount, chunkCount))
  const selected = new Set<number>()
  while (selected.size < count) {
    selected.add(Math.floor(Math.random() * chunkCount))
  }
  return Array.from(selected.values()).sort((a, b) => a - b)
}
