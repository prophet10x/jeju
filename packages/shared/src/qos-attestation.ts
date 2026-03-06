import { z } from 'zod'

export const QOS_ATTESTATION_PATH = '/qos/attestation/prove'

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/)
const Bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/)
const HexSignatureSchema = z.string().regex(/^0x[a-fA-F0-9]+$/)
const NonceSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,256}$/)

export const QoSAttestationRequestSchema = z.object({
  nodeId: Bytes32Schema,
  nonce: NonceSchema,
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  chainId: z.number().int().positive(),
  validatorId: z.string().min(1).max(256),
})

export type QoSAttestationRequest = z.infer<typeof QoSAttestationRequestSchema>

export const QoSAttestationProofSchema = z.object({
  signer: AddressSchema,
  signature: HexSignatureSchema,
  signedAt: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
})

export type QoSAttestationProof = z.infer<typeof QoSAttestationProofSchema>

export interface QoSAttestationMessageInput extends QoSAttestationRequest {
  endpointOrigin: string
  seq: number
}

export function normalizeAttestationOrigin(endpoint: string): string {
  const url = new URL(endpoint)
  return url.origin.toLowerCase().replace(/\/$/, '')
}

export function buildQoSAttestationMessage(
  payload: QoSAttestationMessageInput,
): string {
  return [
    'Jeju QoS Attestation v1',
    `nodeId:${payload.nodeId.toLowerCase()}`,
    `nonce:${payload.nonce}`,
    `issuedAt:${payload.issuedAt}`,
    `expiresAt:${payload.expiresAt}`,
    `chainId:${payload.chainId}`,
    `validatorId:${payload.validatorId}`,
    `endpointOrigin:${normalizeAttestationOrigin(payload.endpointOrigin)}`,
    `seq:${payload.seq}`,
  ].join('\n')
}
