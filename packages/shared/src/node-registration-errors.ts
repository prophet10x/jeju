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

const NETWORK_OWNERSHIP_EXCEEDED_SELECTOR = '0x7d246ea2'
const TOO_MANY_TAGS_SELECTOR = '0xee39e855'
const SERVICE_NOT_AVAILABLE_SELECTOR = '0x47df41de'

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

export function describeNodeRegistrationError(
  error: unknown,
  fallback = 'Node registration failed',
): string {
  const message = getMessageFromUnknown(error)

  const ownershipExceeded = decodeNetworkOwnershipExceeded(message)
  if (ownershipExceeded) {
    const { wouldBe, max } = ownershipExceeded
    return `Node registration exceeds the operator ownership cap (${formatBpsAsPercent(
      wouldBe,
    )} requested, ${formatBpsAsPercent(
      max,
    )} max). Use a different operator identity or increase total network stake before retrying.`
  }

  const unavailableService = decodeServiceNotAvailable(message)
  if (unavailableService) {
    return `Paymaster service unavailable: "${unavailableService}". Ask the network operator to register this service in ServiceRegistry, then retry.`
  }

  if (isTooManyTagsError(message)) {
    return 'Node identity metadata update exceeded the on-chain tag limit. Retry after reducing tag count (max 10), or use the latest app build which auto-limits on-chain tags.'
  }

  if (message.includes('UserOperation reverted during simulation')) {
    return `UserOperation simulation reverted during node registration. ${message}`
  }

  return message || fallback
}
