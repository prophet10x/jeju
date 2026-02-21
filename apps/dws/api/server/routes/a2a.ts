/**
 * A2A Routes - Agent-to-Agent protocol for DWS
 * Enables AI agents to discover and communicate with DWS services
 */

import { getContract, getCurrentNetwork, getRpcUrl } from '@jejunetwork/config'
import { Elysia } from 'elysia'
import { type Address, createPublicClient, http } from 'viem'

const CAPABILITIES = [
  'storage',
  'compute',
  'cdn',
  'git',
  'pkg',
  'kms',
  'vpn',
  'scraping',
  'workerd',
  'workers',
  'containers',
  'k8s',
  'helm',
  'terraform',
  'ingress',
  'mesh',
  'cache',
] as const

// IdentityRegistry ABI (read-only functions for agent discovery)
const IDENTITY_REGISTRY_ABI = [
  {
    name: 'getActiveAgents',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: 'agentIds', type: 'uint256[]' }],
  },
  {
    name: 'getMarketplaceInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'a2aEndpoint', type: 'string' },
      { name: 'mcpEndpoint', type: 'string' },
      { name: 'serviceType', type: 'string' },
      { name: 'category', type: 'string' },
      { name: 'x402Supported', type: 'bool' },
      { name: 'tier', type: 'uint8' },
      { name: 'banned', type: 'bool' },
    ],
  },
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'agents',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'owner', type: 'address' },
      { name: 'tier', type: 'uint8' },
      { name: 'stakedToken', type: 'address' },
      { name: 'stakedAmount', type: 'uint256' },
      { name: 'registeredAt', type: 'uint256' },
      { name: 'lastActivityAt', type: 'uint256' },
      { name: 'isBanned', type: 'bool' },
      { name: 'isSlashed', type: 'bool' },
    ],
  },
] as const

const STAKE_TIERS = ['None', 'Small', 'Medium', 'Large'] as const

function getClient() {
  const rpcUrl = getRpcUrl(getCurrentNetwork())
  return createPublicClient({ transport: http(rpcUrl) })
}

function getIdentityRegistryAddress(): Address | null {
  const network = getCurrentNetwork()
  const address = getContract('registry', 'identity', network)
  return address as Address | null
}

export function createA2ARouter() {
  return (
    new Elysia({ prefix: '/a2a' })
      // Get available capabilities
      .get('/capabilities', () => ({
        capabilities: CAPABILITIES,
        version: '1.0.0',
        protocol: 'a2a',
      }))

      // Agent card endpoint (discovery)
      .get('/agent-card', () => ({
        name: 'DWS',
        description:
          'Decentralized Web Services - compute, storage, CDN, git, packages, infrastructure',
        version: '1.0.0',
        capabilities: CAPABILITIES,
        endpoints: {
          storage: '/storage',
          compute: '/compute',
          cdn: '/cdn',
          git: '/git',
          pkg: '/pkg',
          kms: '/kms',
          vpn: '/vpn',
          scraping: '/scraping',
          workerd: '/workerd',
          workers: '/workers',
          containers: '/containers',
          k8s: '/k3s',
          helm: '/helm',
          terraform: '/terraform',
          ingress: '/ingress',
          mesh: '/mesh',
          cache: '/cache',
        },
      }))

      // List registered agents from IdentityRegistry contract
      .get('/agents', async ({ set }) => {
        try {
          const registryAddress = getIdentityRegistryAddress()
          if (!registryAddress) {
            set.status = 503
            return { error: 'IdentityRegistry not configured', agents: [] }
          }

          const client = getClient()

          // Get active agent IDs (up to 100)
          const agentIds = (await client.readContract({
            address: registryAddress,
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'getActiveAgents',
            args: [0n, 100n],
          })) as bigint[]

          // Fetch details for each agent
          const agents = await Promise.all(
            agentIds.map(async (id) => {
              try {
                const [marketplaceInfo, agentData, uri] = await Promise.all([
                  client.readContract({
                    address: registryAddress,
                    abi: IDENTITY_REGISTRY_ABI,
                    functionName: 'getMarketplaceInfo',
                    args: [id],
                  }) as Promise<
                    [string, string, string, string, boolean, number, boolean]
                  >,
                  client.readContract({
                    address: registryAddress,
                    abi: IDENTITY_REGISTRY_ABI,
                    functionName: 'agents',
                    args: [id],
                  }) as Promise<
                    [
                      bigint,
                      string,
                      number,
                      string,
                      bigint,
                      bigint,
                      bigint,
                      boolean,
                      boolean,
                    ]
                  >,
                  client
                    .readContract({
                      address: registryAddress,
                      abi: IDENTITY_REGISTRY_ABI,
                      functionName: 'tokenURI',
                      args: [id],
                    })
                    .catch(() => ''),
                ])

                const [
                  a2aEndpoint,
                  mcpEndpoint,
                  serviceType,
                  category,
                  x402Supported,
                  tier,
                ] = marketplaceInfo
                const [
                  ,
                  owner,
                  ,
                  ,
                  ,
                  registeredAt,
                  lastActivityAt,
                ] = agentData

                return {
                  id: Number(id).toString(),
                  name: `Agent #${id}`,
                  owner: owner as string,
                  status: Number(lastActivityAt) > 0 ? 'active' : 'registered',
                  endpoint: a2aEndpoint || mcpEndpoint || '',
                  serviceType: serviceType || 'agent',
                  category: category || '',
                  tier: STAKE_TIERS[tier] || 'None',
                  x402Supported,
                  tokenURI: uri as string,
                  registeredAt: Number(registeredAt),
                  capabilities: category ? [category] : [],
                }
              } catch {
                return null
              }
            }),
          )

          return { agents: agents.filter(Boolean) }
        } catch (err) {
          set.status = 500
          return {
            error:
              err instanceof Error ? err.message : 'Failed to fetch agents',
            agents: [],
          }
        }
      })

      // Health check for A2A protocol
      .get('/health', () => ({ status: 'healthy', protocol: 'a2a' }))
  )
}
