import {
  JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
  JEJU_AGENT_REGISTRATION_SERVICE,
  JEJU_NODE_IDENTITY_METADATA_SERVICE,
  JEJU_NODE_IDENTITY_REGISTRATION_SERVICE,
  JEJU_NODE_REGISTRATION_SERVICE,
} from '@jejunetwork/shared'
import { parseAbi, createPublicClient, http, type Address } from 'viem'

const MULTI_TOKEN_PAYMASTER_ABI = parseAbi([
  'function serviceRegistry() view returns (address)',
])

const SERVICE_REGISTRY_ABI = parseAbi([
  'function isServiceAvailable(string serviceName) view returns (bool)',
])

const REQUIRED_SERVICES = [
  JEJU_AGENT_REGISTRATION_SERVICE,
  JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
  JEJU_NODE_REGISTRATION_SERVICE,
  JEJU_NODE_IDENTITY_REGISTRATION_SERVICE,
  JEJU_NODE_IDENTITY_METADATA_SERVICE,
]

function asAddress(value: string | undefined, name: string): Address {
  if (!value || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${name} must be a valid 0x address`)
  }
  return value as Address
}

async function main() {
  const rpcUrl = process.env.RPC_URL
  const paymasterAddress = asAddress(
    process.env.PAYMASTER_ADDRESS,
    'PAYMASTER_ADDRESS',
  )

  if (!rpcUrl) {
    throw new Error('RPC_URL is required')
  }

  const client = createPublicClient({
    transport: http(rpcUrl),
  })

  const serviceRegistry = (await client.readContract({
    address: paymasterAddress,
    abi: MULTI_TOKEN_PAYMASTER_ABI,
    functionName: 'serviceRegistry',
  })) as Address

  console.log(`Paymaster: ${paymasterAddress}`)
  console.log(`ServiceRegistry: ${serviceRegistry}`)

  const missing: string[] = []
  for (const serviceName of REQUIRED_SERVICES) {
    const available = (await client.readContract({
      address: serviceRegistry,
      abi: SERVICE_REGISTRY_ABI,
      functionName: 'isServiceAvailable',
      args: [serviceName],
    })) as boolean

    if (!available) {
      missing.push(serviceName)
      console.log(`[MISSING] ${serviceName}`)
      continue
    }

    console.log(`[OK] ${serviceName}`)
  }

  if (missing.length > 0) {
    console.error(`Missing services: ${missing.join(', ')}`)
    process.exit(1)
  }

  console.log('All required paymaster services are available.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
