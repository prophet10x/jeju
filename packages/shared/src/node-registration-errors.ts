import { decodeErrorResult, type Hex } from 'viem'

const NODE_STAKING_ERROR_ABI = [
  {
    type: 'error',
    name: 'NetworkOwnershipExceeded',
    inputs: [
      { name: 'wouldBe', type: 'uint256' },
      { name: 'max', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'StrictProfileRegistrationRequired',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidMetadataURI',
    inputs: [{ name: 'metadataURI', type: 'string' }],
  },
  {
    type: 'error',
    name: 'InvalidServicesHash',
    inputs: [],
  },
  {
    type: 'error',
    name: 'RegistrationNonceMismatch',
    inputs: [
      { name: 'expected', type: 'uint256' },
      { name: 'provided', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'OperatorAgentNotStaked',
    inputs: [{ name: 'operatorAgentId', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'OperatorAgentIneligible',
    inputs: [{ name: 'operatorAgentId', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'NodeAlreadyExists',
    inputs: [{ name: 'nodeId', type: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'InvalidAgentId',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotAgentOwner',
    inputs: [],
  },
] as const

const IDENTITY_REGISTRY_ERROR_ABI = [
  {
    type: 'error',
    name: 'TooManyTags',
    inputs: [],
  },
] as const

const PAYMASTER_ERROR_ABI = [
  {
    type: 'error',
    name: 'ServiceNotAvailable',
    inputs: [{ name: 'serviceName', type: 'string' }],
  },
] as const

const ENTRYPOINT_ERROR_ABI = [
  {
    type: 'error',
    name: 'FailedOpWithRevert',
    inputs: [
      { name: 'opIndex', type: 'uint256' },
      { name: 'reason', type: 'string' },
      { name: 'inner', type: 'bytes' },
    ],
  },
  {
    type: 'error',
    name: 'PostOpReverted',
    inputs: [{ name: 'inner', type: 'bytes' }],
  },
] as const

const NETWORK_OWNERSHIP_EXCEEDED_SELECTOR = '0x7d246ea2'
const TOO_MANY_TAGS_SELECTOR = '0xee39e855'
const SERVICE_NOT_AVAILABLE_SELECTOR = '0x47df41de'
const ENTRYPOINT_FAILED_OP_WITH_REVERT_SELECTOR = '0x5a154675'
const ENTRYPOINT_POST_OP_REVERTED_SELECTOR = '0xad7954bc'

function formatBpsAsPercent(bps: bigint): string {
  const whole = bps / 100n
  const fraction = bps % 100n
  if (fraction === 0n) {
    return `${whole}%`
  }

  return `${whole}.${fraction.toString().padStart(2, '0')}%`
}

function getMessageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : String(error)
}

function extractEncodedErrorData(
  message: string,
  selector: string,
): Hex | null {
  const selectorWithoutPrefix = selector.slice(2).toLowerCase()
  const lowered = message.toLowerCase()

  let selectorIndex = lowered.indexOf(selector.toLowerCase())
  if (selectorIndex === -1) {
    selectorIndex = lowered.indexOf(selectorWithoutPrefix)
  }
  if (selectorIndex === -1) {
    return null
  }

  const hasPrefix =
    lowered.slice(selectorIndex, selectorIndex + 2) === '0x' &&
    lowered.slice(selectorIndex + 2, selectorIndex + 10) ===
      selectorWithoutPrefix
  const hexStart = hasPrefix ? selectorIndex + 2 : selectorIndex
  const hexCandidate = message.slice(hexStart).match(/^[0-9a-fA-F]+/)?.[0]

  return hexCandidate ? (`0x${hexCandidate}` as Hex) : null
}

function extractHexCandidates(message: string): Hex[] {
  const matches = message.match(/0x[0-9a-fA-F]{8,}/g) ?? []
  return Array.from(new Set(matches.map((match) => match as Hex)))
}

function decodeNodeStakingError(
  message: string,
):
  | { errorName: 'StrictProfileRegistrationRequired' }
  | { errorName: 'InvalidMetadataURI'; metadataURI: string }
  | { errorName: 'InvalidServicesHash' }
  | {
      errorName: 'RegistrationNonceMismatch'
      expected: bigint
      provided: bigint
    }
  | { errorName: 'OperatorAgentNotStaked'; operatorAgentId: bigint }
  | { errorName: 'OperatorAgentIneligible'; operatorAgentId: bigint }
  | { errorName: 'NodeAlreadyExists'; nodeId: Hex }
  | { errorName: 'InvalidAgentId' }
  | { errorName: 'NotAgentOwner' }
  | null {
  for (const candidate of extractHexCandidates(message)) {
    try {
      const decoded = decodeErrorResult({
        abi: NODE_STAKING_ERROR_ABI,
        data: candidate,
      })

      switch (decoded.errorName) {
        case 'StrictProfileRegistrationRequired':
          return { errorName: decoded.errorName }
        case 'InvalidMetadataURI': {
          const [metadataURI] = decoded.args as [string]
          return { errorName: decoded.errorName, metadataURI }
        }
        case 'InvalidServicesHash':
          return { errorName: decoded.errorName }
        case 'RegistrationNonceMismatch': {
          const [expected, provided] = decoded.args as [bigint, bigint]
          return { errorName: decoded.errorName, expected, provided }
        }
        case 'OperatorAgentNotStaked': {
          const [operatorAgentId] = decoded.args as [bigint]
          return { errorName: decoded.errorName, operatorAgentId }
        }
        case 'OperatorAgentIneligible': {
          const [operatorAgentId] = decoded.args as [bigint]
          return { errorName: decoded.errorName, operatorAgentId }
        }
        case 'NodeAlreadyExists': {
          const [nodeId] = decoded.args as [Hex]
          return { errorName: decoded.errorName, nodeId }
        }
        case 'InvalidAgentId':
          return { errorName: decoded.errorName }
        case 'NotAgentOwner':
          return { errorName: decoded.errorName }
      }
    } catch {
      // Ignore non-matching hex blobs.
    }
  }

  return null
}

function decodeNetworkOwnershipExceeded(
  message: string,
): { wouldBe: bigint; max: bigint } | null {
  const encoded = extractEncodedErrorData(
    message,
    NETWORK_OWNERSHIP_EXCEEDED_SELECTOR,
  )
  if (!encoded) return null

  try {
    const decoded = decodeErrorResult({
      abi: NODE_STAKING_ERROR_ABI,
      data: encoded,
    })
    if (decoded.errorName !== 'NetworkOwnershipExceeded') {
      return null
    }

    const [wouldBe, max] = decoded.args as [bigint, bigint]
    return { wouldBe, max }
  } catch {
    return null
  }
}

function decodeServiceNotAvailable(message: string): string | null {
  const encoded = extractEncodedErrorData(
    message,
    SERVICE_NOT_AVAILABLE_SELECTOR,
  )
  if (!encoded) return null

  try {
    const decoded = decodeErrorResult({
      abi: PAYMASTER_ERROR_ABI,
      data: encoded,
    })
    if (decoded.errorName !== 'ServiceNotAvailable') {
      return null
    }

    const [serviceName] = decoded.args as [string]
    return serviceName
  } catch {
    return null
  }
}

function isTooManyTagsError(message: string): boolean {
  const encoded = extractEncodedErrorData(message, TOO_MANY_TAGS_SELECTOR)
  if (!encoded) return false

  try {
    const decoded = decodeErrorResult({
      abi: IDENTITY_REGISTRY_ERROR_ABI,
      data: encoded,
    })
    return decoded.errorName === 'TooManyTags'
  } catch {
    return false
  }
}

function decodeEntryPointNestedRevertData(message: string): {
  reason?: string
  nestedData?: Hex
} | null {
  const encodedFailedOpWithRevert = extractEncodedErrorData(
    message,
    ENTRYPOINT_FAILED_OP_WITH_REVERT_SELECTOR,
  )
  if (encodedFailedOpWithRevert) {
    try {
      const decoded = decodeErrorResult({
        abi: ENTRYPOINT_ERROR_ABI,
        data: encodedFailedOpWithRevert,
      })
      if (decoded.errorName === 'FailedOpWithRevert') {
        const [, reason, nestedData] = decoded.args as [bigint, string, Hex]
        return {
          reason,
          nestedData:
            nestedData && nestedData !== '0x' ? (nestedData as Hex) : undefined,
        }
      }
    } catch {
      // Continue with post-op decoding path.
    }
  }

  const encodedPostOpReverted = extractEncodedErrorData(
    message,
    ENTRYPOINT_POST_OP_REVERTED_SELECTOR,
  )
  if (!encodedPostOpReverted) {
    return null
  }

  try {
    const decoded = decodeErrorResult({
      abi: ENTRYPOINT_ERROR_ABI,
      data: encodedPostOpReverted,
    })
    if (decoded.errorName !== 'PostOpReverted') {
      return null
    }

    const [nestedData] = decoded.args as [Hex]
    return {
      reason: 'EntryPoint post-op reverted',
      nestedData:
        nestedData && nestedData !== '0x' ? (nestedData as Hex) : undefined,
    }
  } catch {
    return null
  }
}

export function describeNodeRegistrationError(
  error: unknown,
  fallback = 'Node registration failed',
): string {
  const message = getMessageFromUnknown(error)
  const entryPointRevert = decodeEntryPointNestedRevertData(message)
  const messageForDecoding =
    entryPointRevert?.nestedData !== undefined
      ? `${message} ${entryPointRevert.nestedData}`
      : message

  const ownershipExceeded = decodeNetworkOwnershipExceeded(messageForDecoding)
  if (ownershipExceeded) {
    const { wouldBe, max } = ownershipExceeded
    return `Node registration exceeds the operator ownership cap (${formatBpsAsPercent(
      wouldBe,
    )} requested, ${formatBpsAsPercent(
      max,
    )} max). Use a different operator identity or increase total network stake before retrying.`
  }

  const unavailableService = decodeServiceNotAvailable(messageForDecoding)
  if (unavailableService) {
    return `Paymaster service unavailable: "${unavailableService}". Ask the network operator to register this service in ServiceRegistry, then retry.`
  }

  if (isTooManyTagsError(messageForDecoding)) {
    return 'Node identity metadata update exceeded the on-chain tag limit. Retry after reducing tag count (max 10), or use the latest app build which auto-limits on-chain tags.'
  }

  const stakingError = decodeNodeStakingError(messageForDecoding)
  if (stakingError) {
    switch (stakingError.errorName) {
      case 'StrictProfileRegistrationRequired':
        return 'This staking manager only accepts strict atomic registration with a deterministic node ID, services hash, and IPFS metadata URI.'
      case 'InvalidMetadataURI':
        return `Node metadata must be uploaded to IPFS before registration. Rejected metadata URI: ${stakingError.metadataURI}`
      case 'InvalidServicesHash':
        return 'The selected services could not be committed on-chain. Recompute the canonical services hash and retry.'
      case 'RegistrationNonceMismatch':
        return `Node registration preview is stale. Expected nonce ${stakingError.expected.toString()}, but the submitted transaction used ${stakingError.provided.toString()}. Refresh the preview and retry.`
      case 'OperatorAgentNotStaked':
        return `Operator agent #${stakingError.operatorAgentId.toString()} is not staked. Only staked operator identities can register nodes.`
      case 'OperatorAgentIneligible':
        return `Operator agent #${stakingError.operatorAgentId.toString()} is not eligible for node registration. Check its staking, ban, and slashing state.`
      case 'NodeAlreadyExists':
        return `This node profile was already registered on-chain (${stakingError.nodeId}). Refresh the node preview before retrying.`
      case 'InvalidAgentId':
        return 'Selected operator agent does not exist on the active identity registry.'
      case 'NotAgentOwner':
        return 'Selected operator agent is not owned by the connected wallet or smart account.'
    }
  }

  if (entryPointRevert?.reason && entryPointRevert.nestedData) {
    return `${entryPointRevert.reason}. Nested revert: ${entryPointRevert.nestedData}`
  }

  if (entryPointRevert?.reason) {
    return entryPointRevert.reason
  }

  if (message.includes('UserOperation reverted during simulation')) {
    return `UserOperation simulation reverted during node registration. ${message}`
  }

  return message || fallback
}
