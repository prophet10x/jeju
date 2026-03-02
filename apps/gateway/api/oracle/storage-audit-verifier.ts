import { concatHex, keccak256, type Hex } from 'viem'

export interface StorageAuditCommitment {
  commitment: Hex
  merkleRoot: Hex
  chunkSize: number
  chunkCount: number
  storedSha256: string
  timestamp: number
}

export interface StorageAuditChunkProof {
  merkleProof: Hex[]
  openingProof: Hex
  polynomialIndex: number
}

export interface StorageAuditChunk {
  index: number
  data: Uint8Array
  proof: StorageAuditChunkProof
}

interface BlobCommitmentLike {
  totalChunkCount: number
  chunkSize: number
  merkleRoot: Hex
}

function verifyMerkleProof(
  leaf: Hex,
  proof: Hex[],
  root: Hex,
  index: number,
): boolean {
  let hash = leaf
  let idx = index

  for (const sibling of proof) {
    const isRight = idx % 2 === 1
    hash = isRight
      ? keccak256(concatHex([sibling, hash]))
      : keccak256(concatHex([hash, sibling]))
    idx = Math.floor(idx / 2)
  }

  return hash.toLowerCase() === root.toLowerCase()
}

function verifyChunkProof(
  chunk: StorageAuditChunk,
  commitment: BlobCommitmentLike,
): boolean {
  if (chunk.index < 0 || chunk.index >= commitment.totalChunkCount) {
    return false
  }

  if (chunk.data.length > commitment.chunkSize + 32) {
    return false
  }

  if (chunk.proof.polynomialIndex !== chunk.index) {
    return false
  }

  return verifyMerkleProof(
    keccak256(chunk.data),
    chunk.proof.merkleProof,
    commitment.merkleRoot,
    chunk.index,
  )
}

export function verifyStorageAuditChunks(
  audit: StorageAuditCommitment,
  chunks: StorageAuditChunk[],
): { valid: boolean; invalidIndices: number[] } {
  const commitment: BlobCommitmentLike = {
    totalChunkCount: audit.chunkCount,
    chunkSize: audit.chunkSize,
    merkleRoot: audit.merkleRoot,
  }

  const invalidIndices = chunks
    .filter((chunk) => !verifyChunkProof(chunk, commitment))
    .map((chunk) => chunk.index)

  return {
    valid: invalidIndices.length === 0,
    invalidIndices,
  }
}
