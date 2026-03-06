import {
  JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
  JEJU_AGENT_REGISTRATION_SERVICE,
} from '@jejunetwork/shared'
import { ZERO_ADDRESS } from '@jejunetwork/types'
import { useState } from 'react'
import {
  type Address,
  decodeEventLog,
  encodeFunctionData,
  type TransactionReceipt,
} from 'viem'
import {
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { CONTRACTS } from '../../lib/config'
import { IERC20_ABI } from '../lib/constants'
import type { GaslessCall } from './useGaslessSmartAccount'
import { useGaslessSmartAccount } from './useGaslessSmartAccount'
import { useTypedWriteContract } from './useTypedWriteContract'

export const IDENTITY_REGISTRY_ADDRESS = CONTRACTS.identityRegistry
const REGISTRY_ADDRESS = IDENTITY_REGISTRY_ADDRESS

/**
 * Stake tiers matching IdentityRegistry.sol
 * NONE=0, SMALL=1, MEDIUM=2, HIGH=3
 */
export const StakeTier = {
  NONE: 0,
  SMALL: 1,
  MEDIUM: 2,
  HIGH: 3,
} as const
export type StakeTierValue = (typeof StakeTier)[keyof typeof StakeTier]

const IDENTITY_REGISTRY_ABI = [
  // Register without staking
  {
    inputs: [{ internalType: 'string', name: 'tokenURI_', type: 'string' }],
    name: 'register',
    outputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Register with metadata (no staking)
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
  // Register with staking (tier-based)
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
      { internalType: 'uint8', name: 'tier_', type: 'uint8' },
      { internalType: 'address', name: 'stakeToken_', type: 'address' },
    ],
    name: 'registerWithStake',
    outputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'withdrawStake',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'uint8', name: 'newTier', type: 'uint8' },
    ],
    name: 'increaseStake',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  // Get stake amount for a tier
  {
    inputs: [{ internalType: 'uint8', name: 'tier', type: 'uint8' }],
    name: 'getStakeAmount',
    outputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'string', name: 'tag', type: 'string' }],
    name: 'getAgentsByTag',
    outputs: [
      { internalType: 'uint256[]', name: 'agentIds', type: 'uint256[]' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string', name: 'key', type: 'string' },
    ],
    name: 'getMetadata',
    outputs: [{ internalType: 'bytes', name: 'value', type: 'bytes' }],
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
    name: 'getA2AEndpoint',
    outputs: [{ internalType: 'string', name: 'endpoint', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getMCPEndpoint',
    outputs: [{ internalType: 'string', name: 'endpoint', type: 'string' }],
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
    name: 'getX402Support',
    outputs: [{ internalType: 'bool', name: 'supported', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Auto-generated getter for public `agents` mapping
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
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getMarketplaceInfo',
    outputs: [
      { internalType: 'string', name: 'a2aEndpoint', type: 'string' },
      { internalType: 'string', name: 'mcpEndpoint', type: 'string' },
      { internalType: 'string', name: 'serviceType', type: 'string' },
      { internalType: 'string', name: 'category', type: 'string' },
      { internalType: 'bool', name: 'x402Supported', type: 'bool' },
      { internalType: 'uint8', name: 'tier', type: 'uint8' },
      { internalType: 'bool', name: 'banned', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'offset', type: 'uint256' },
      { internalType: 'uint256', name: 'limit', type: 'uint256' },
    ],
    name: 'getActiveAgents',
    outputs: [
      { internalType: 'uint256[]', name: 'agentIds', type: 'uint256[]' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string', name: 'endpoint', type: 'string' },
    ],
    name: 'setA2AEndpoint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string', name: 'endpoint', type: 'string' },
    ],
    name: 'setMCPEndpoint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string', name: 'a2aEndpoint', type: 'string' },
      { internalType: 'string', name: 'mcpEndpoint', type: 'string' },
    ],
    name: 'setEndpoints',
    outputs: [],
    stateMutability: 'nonpayable',
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
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'bool', name: 'supported', type: 'bool' },
    ],
    name: 'setX402Support',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'string', name: 'newTokenURI', type: 'string' },
    ],
    name: 'setAgentUri',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'agentId', type: 'uint256' },
      { internalType: 'address', name: 'wallet', type: 'address' },
    ],
    name: 'setAgentWallet',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getAgentWallet',
    outputs: [{ internalType: 'address', name: 'wallet', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Supported tokens
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'isSupportedStakeToken',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export interface RegisterAppParams {
  tokenURI: string
  a2aEndpoint: string
  tier: StakeTierValue
  stakeToken: Address
  stakeAmount: bigint
  tags?: string[]
  category?: string
  serviceType?: string
}

interface RegisterAppOptions {
  gasless?: boolean
}

/** Encode a string as ABI bytes for MetadataEntry */
function encodeStringMetadata(value: string): `0x${string}` {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(value)
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`
}

const REGISTERED_EVENT_ABI = [
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

function resolveServiceType(a2aEndpoint: string, requested?: string): string {
  if (requested && requested.length > 0) return requested
  return a2aEndpoint ? 'agent' : 'app'
}

function resolveCategory(
  tags: string[] | undefined,
  requested?: string,
): string {
  if (requested && requested.length > 0) return requested
  return tags?.[0] ?? ''
}

export function useRegistry() {
  const [lastTx, setLastTx] = useState<`0x${string}` | undefined>()
  const { data: txReceipt } = useWaitForTransactionReceipt({ hash: lastTx })
  const publicClient = usePublicClient()
  const { writeAsync } = useTypedWriteContract()
  const gasless = useGaslessSmartAccount()

  function getRegisteredAgentIdFromReceipt(
    receipt: TransactionReceipt,
  ): bigint | undefined {
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: REGISTERED_EVENT_ABI,
          data: log.data,
          topics: log.topics,
        })
        if (decoded.eventName === 'Registered') {
          return decoded.args.agentId
        }
      } catch {
        // ignore unrelated logs
      }
    }
    return undefined
  }

  async function persistAgentPresentation(
    agentId: bigint,
    params: {
      tags?: string[]
      category?: string
      serviceType?: string
      a2aEndpoint: string
    },
    options: RegisterAppOptions,
  ) {
    const tags = params.tags?.filter(Boolean) ?? []
    const category = resolveCategory(tags, params.category)
    const serviceType = resolveServiceType(
      params.a2aEndpoint,
      params.serviceType,
    )

    if (options.gasless) {
      const calls: GaslessCall[] = []

      if (tags.length > 0) {
        calls.push({
          to: REGISTRY_ADDRESS,
          data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'updateTags',
            args: [agentId, tags],
          }),
        })
      }

      if (category) {
        calls.push({
          to: REGISTRY_ADDRESS,
          data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'setCategory',
            args: [agentId, category],
          }),
        })
      }

      if (serviceType) {
        calls.push({
          to: REGISTRY_ADDRESS,
          data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'setServiceType',
            args: [agentId, serviceType],
          }),
        })
      }

      if (calls.length > 0) {
        const hash = await gasless.executeGaslessCalls({
          serviceName: JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
          calls,
        })
        setLastTx(hash)
        await waitForSuccessfulReceipt(hash)
      }
      return
    }

    if (tags.length > 0) {
      const hash = await writeAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'updateTags',
        args: [agentId, tags],
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
    }

    if (category) {
      const hash = await writeAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'setCategory',
        args: [agentId, category],
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
    }

    if (serviceType) {
      const hash = await writeAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'setServiceType',
        args: [agentId, serviceType],
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
    }
  }

  async function waitForSuccessfulReceipt(hash: `0x${string}`) {
    if (!publicClient) {
      throw new Error('Public client is not available')
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      throw new Error('Transaction reverted on-chain')
    }

    return receipt
  }

  async function registerApp(
    params: RegisterAppParams,
    options: RegisterAppOptions = {},
  ): Promise<{ success: boolean; error?: string; agentId?: bigint }> {
    const {
      tokenURI,
      a2aEndpoint,
      tier,
      stakeToken,
      stakeAmount,
      tags,
      category,
      serviceType,
    } = params

    // Build metadata entries for the a2a endpoint
    const metadata: { key: string; value: `0x${string}` }[] = []
    if (a2aEndpoint) {
      metadata.push({
        key: 'a2aEndpoint',
        value: encodeStringMetadata(a2aEndpoint),
      })
    }

    if (options.gasless) {
      if (tier !== StakeTier.NONE && stakeToken !== CONTRACTS.jeju) {
        return {
          success: false,
          error:
            'Gasless registry registration currently supports JEJU staking only.',
        }
      }

      const calls: GaslessCall[] = []

      if (tier !== StakeTier.NONE) {
        calls.push({
          to: stakeToken,
          data: encodeFunctionData({
            abi: IERC20_ABI,
            functionName: 'approve',
            args: [REGISTRY_ADDRESS, stakeAmount],
          }),
        })
      }

      calls.push({
        to: REGISTRY_ADDRESS,
        data:
          tier === StakeTier.NONE
            ? encodeFunctionData({
                abi: IDENTITY_REGISTRY_ABI,
                functionName: 'register',
                args: [tokenURI, metadata],
              })
            : encodeFunctionData({
                abi: IDENTITY_REGISTRY_ABI,
                functionName: 'registerWithStake',
                args: [tokenURI, metadata, tier, stakeToken],
              }),
      })

      const hash = await gasless.executeGaslessCalls({
        serviceName: JEJU_AGENT_REGISTRATION_SERVICE,
        calls,
        requiredJejuBalance: tier === StakeTier.NONE ? 0n : stakeAmount,
      })
      setLastTx(hash)
      const receipt = await waitForSuccessfulReceipt(hash)
      const agentId = getRegisteredAgentIdFromReceipt(receipt)
      if (agentId !== undefined) {
        await persistAgentPresentation(
          agentId,
          { tags, category, serviceType, a2aEndpoint },
          options,
        )
      }
      return { success: true, agentId }
    }

    if (tier === StakeTier.NONE) {
      // Free registration (no staking)
      const hash = await writeAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'register',
        args: [tokenURI, metadata],
      })
      setLastTx(hash)
      const receipt = await waitForSuccessfulReceipt(hash)
      const agentId = getRegisteredAgentIdFromReceipt(receipt)
      if (agentId !== undefined) {
        await persistAgentPresentation(
          agentId,
          { tags, category, serviceType, a2aEndpoint },
          options,
        )
      }
      return { success: true, agentId }
    } else {
      // Registration with staking
      if (stakeToken !== ZERO_ADDRESS) {
        await writeAsync({
          address: stakeToken,
          abi: IERC20_ABI,
          functionName: 'approve',
          args: [REGISTRY_ADDRESS, stakeAmount],
        })
      }

      const hash = await writeAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'registerWithStake',
        args: [tokenURI, metadata, tier, stakeToken],
        value: stakeToken === ZERO_ADDRESS ? stakeAmount : 0n,
      })
      setLastTx(hash)
      const receipt = await waitForSuccessfulReceipt(hash)
      const agentId = getRegisteredAgentIdFromReceipt(receipt)
      if (agentId !== undefined) {
        await persistAgentPresentation(
          agentId,
          { tags, category, serviceType, a2aEndpoint },
          options,
        )
      }
      return { success: true, agentId }
    }
  }

  async function withdrawStake(
    agentId: bigint,
    options?: { gasless?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    if (options?.gasless) {
      const hash = await gasless.executeGaslessCalls({
        serviceName: JEJU_AGENT_REGISTRATION_SERVICE,
        calls: [
          {
            to: REGISTRY_ADDRESS,
            data: encodeFunctionData({
              abi: IDENTITY_REGISTRY_ABI,
              functionName: 'withdrawStake',
              args: [agentId],
            }),
          },
        ],
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
      return { success: true }
    }

    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'withdrawStake',
      args: [agentId],
    })
    setLastTx(hash)
    await waitForSuccessfulReceipt(hash)
    return { success: true }
  }

  async function setAgentWallet(
    agentId: bigint,
    wallet: Address,
    options?: { gasless?: boolean },
  ): Promise<{ success: boolean; error?: string; txHash?: `0x${string}` }> {
    if (options?.gasless) {
      const hash = await gasless.executeGaslessCalls({
        serviceName: JEJU_AGENT_REGISTRATION_SERVICE,
        calls: [
          {
            to: REGISTRY_ADDRESS,
            data: encodeFunctionData({
              abi: IDENTITY_REGISTRY_ABI,
              functionName: 'setAgentWallet',
              args: [agentId, wallet],
            }),
          },
        ],
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
      return { success: true, txHash: hash }
    }

    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setAgentWallet',
      args: [agentId, wallet],
    })
    setLastTx(hash)
    await waitForSuccessfulReceipt(hash)
    return { success: true, txHash: hash }
  }

  async function updateAgentTags(
    agentId: bigint,
    tags: string[],
    options?: { gasless?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    const normalized = tags
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)

    if (options?.gasless) {
      const hash = await gasless.executeGaslessCalls({
        serviceName: JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
        calls: [
          {
            to: REGISTRY_ADDRESS,
            data: encodeFunctionData({
              abi: IDENTITY_REGISTRY_ABI,
              functionName: 'updateTags',
              args: [agentId, normalized],
            }),
          },
        ],
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
      return { success: true }
    }

    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'updateTags',
      args: [agentId, normalized],
    })
    setLastTx(hash)
    await waitForSuccessfulReceipt(hash)
    return { success: true }
  }

  async function updateAgentCategory(
    agentId: bigint,
    category: string,
    options?: { gasless?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    if (options?.gasless) {
      const hash = await gasless.executeGaslessCalls({
        serviceName: JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
        calls: [
          {
            to: REGISTRY_ADDRESS,
            data: encodeFunctionData({
              abi: IDENTITY_REGISTRY_ABI,
              functionName: 'setCategory',
              args: [agentId, category.trim()],
            }),
          },
        ],
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
      return { success: true }
    }

    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setCategory',
      args: [agentId, category.trim()],
    })
    setLastTx(hash)
    await waitForSuccessfulReceipt(hash)
    return { success: true }
  }

  async function updateAgentUri(
    agentId: bigint,
    tokenURI: string,
    options?: { gasless?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    if (options?.gasless) {
      const hash = await gasless.executeGaslessCalls({
        serviceName: JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
        calls: [
          {
            to: REGISTRY_ADDRESS,
            data: encodeFunctionData({
              abi: IDENTITY_REGISTRY_ABI,
              functionName: 'setAgentUri',
              args: [agentId, tokenURI],
            }),
          },
        ],
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
      return { success: true }
    }

    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setAgentUri',
      args: [agentId, tokenURI],
    })
    setLastTx(hash)
    await waitForSuccessfulReceipt(hash)
    return { success: true }
  }

  async function increaseAgentStake(params: {
    agentId: bigint
    newTier: StakeTierValue
    stakeToken: Address
    additionalStake: bigint
    gasless?: boolean
  }): Promise<{ success: boolean; error?: string }> {
    const { agentId, newTier, stakeToken, additionalStake, gasless: useGasless } =
      params
    if (additionalStake <= 0n) {
      return { success: false, error: 'Selected tier is not above current tier.' }
    }

    if (useGasless) {
      const calls: GaslessCall[] = []
      if (stakeToken !== ZERO_ADDRESS) {
        calls.push({
          to: stakeToken,
          data: encodeFunctionData({
            abi: IERC20_ABI,
            functionName: 'approve',
            args: [REGISTRY_ADDRESS, additionalStake],
          }),
        })
      }
      calls.push({
        to: REGISTRY_ADDRESS,
        data: encodeFunctionData({
          abi: IDENTITY_REGISTRY_ABI,
          functionName: 'increaseStake',
          args: [agentId, newTier],
        }),
        value: stakeToken === ZERO_ADDRESS ? additionalStake : 0n,
      })

      const hash = await gasless.executeGaslessCalls({
        serviceName: JEJU_AGENT_REGISTRATION_SERVICE,
        calls,
        requiredJejuBalance: stakeToken === CONTRACTS.jeju ? additionalStake : 0n,
      })
      setLastTx(hash)
      await waitForSuccessfulReceipt(hash)
      return { success: true }
    }

    if (stakeToken !== ZERO_ADDRESS) {
      const approvalHash = await writeAsync({
        address: stakeToken,
        abi: IERC20_ABI,
        functionName: 'approve',
        args: [REGISTRY_ADDRESS, additionalStake],
      })
      setLastTx(approvalHash)
      await waitForSuccessfulReceipt(approvalHash)
    }

    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'increaseStake',
      args: [agentId, newTier],
      value: stakeToken === ZERO_ADDRESS ? additionalStake : 0n,
    })
    setLastTx(hash)
    await waitForSuccessfulReceipt(hash)
    return { success: true }
  }

  return {
    registerApp,
    withdrawStake,
    increaseAgentStake,
    setAgentWallet,
    updateAgentTags,
    updateAgentCategory,
    updateAgentUri,
    lastTransaction: txReceipt ?? gasless.lastTransactionReceipt,
    gasless,
  }
}

export function useStakeAmount(tier: StakeTierValue) {
  const { data } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'getStakeAmount',
    args: [tier],
  })
  return data as bigint | undefined
}

export function useIsSupportedStakeToken(token: Address | undefined) {
  const { data } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'isSupportedStakeToken',
    args: token ? [token] : undefined,
  })
  return data as boolean | undefined
}

interface MarketplaceInfo {
  a2aEndpoint: string
  mcpEndpoint: string
  serviceType: string
  category: string
  x402Supported: boolean
  tier: number
  banned: boolean
}

export function useActiveAgents(offset = 0n, limit = 100n) {
  const { data, refetch, isLoading, error } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'getActiveAgents',
    args: [offset, limit],
  })

  return { agentIds: data as bigint[] | undefined, isLoading, error, refetch }
}

export function useMarketplaceInfo(agentId: bigint | undefined) {
  const { data, isLoading, error } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'getMarketplaceInfo',
    args: agentId !== undefined ? [agentId] : undefined,
  })

  const info: MarketplaceInfo | undefined = data
    ? {
        a2aEndpoint: (
          data as [string, string, string, string, boolean, number, boolean]
        )[0],
        mcpEndpoint: (
          data as [string, string, string, string, boolean, number, boolean]
        )[1],
        serviceType: (
          data as [string, string, string, string, boolean, number, boolean]
        )[2],
        category: (
          data as [string, string, string, string, boolean, number, boolean]
        )[3],
        x402Supported: (
          data as [string, string, string, string, boolean, number, boolean]
        )[4],
        tier: (
          data as [string, string, string, string, boolean, number, boolean]
        )[5],
        banned: (
          data as [string, string, string, string, boolean, number, boolean]
        )[6],
      }
    : undefined

  return { info, isLoading, error }
}

interface RegisteredApp {
  agentId: bigint
  name: string
  description?: string
  tokenURI: string
  owner: string
  tags: string[]
  a2aEndpoint?: string
  category?: string
  agentWallet?: Address | null
  mcpEndpoint?: string
  serviceType?: string
  x402Support?: boolean
  stakeToken: string
  stakeTokenAddress: Address
  stakeAmount: string
  stakeAmountRaw: bigint
  stakeTier?: number
  depositedAt: bigint
}

// JEJU token address - used to display "JEJU" instead of raw address
// Use centralized config - not hardcoded
const JEJU_TOKEN = CONTRACTS.jeju

function resolveTokenName(tokenAddr: string): string {
  if (!tokenAddr || tokenAddr === ZERO_ADDRESS) return 'None'
  if (tokenAddr.toLowerCase() === JEJU_TOKEN.toLowerCase()) return 'JEJU'
  return `${tokenAddr.slice(0, 6)}...${tokenAddr.slice(-4)}`
}

export function useRegistryAppDetails(agentId: bigint) {
  const { data: owner, refetch: refetchOwner } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'ownerOf',
    args: [agentId],
  })

  const { data: tokenURI, refetch: refetchTokenURI } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'tokenURI',
    args: [agentId],
  })

  const { data: agentData, refetch: refetchAgent } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'agents',
    args: [agentId],
  })

  const { data: tags, refetch: refetchTags } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'getAgentTags',
    args: [agentId],
  })

  const { data: category, refetch: refetchCategory } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'getCategory',
    args: [agentId],
  })

  const { data: a2aEndpoint, refetch: refetchEndpoint } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'getA2AEndpoint',
    args: [agentId],
  })

  const { data: agentWallet, refetch: refetchWallet } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'getAgentWallet',
    args: [agentId],
  })

  const isLoading = !owner

  // Parse tokenURI for name/description
  let parsedName = `Agent #${agentId}`
  let parsedDescription: string | undefined
  if (tokenURI) {
    try {
      const parsed = JSON.parse(tokenURI)
      if (parsed.name) parsedName = parsed.name
      if (parsed.description) parsedDescription = parsed.description
    } catch {
      /* not JSON */
    }
  }

  // Extract stake info from agents mapping result
  // agentData is a tuple: [agentId, owner, tier, stakedToken, stakedAmount, registeredAt, lastActivityAt, isBanned, isSlashed]
  const tier = agentData ? Number((agentData as readonly unknown[])[2]) : 0
  const stakedToken = agentData
    ? String((agentData as readonly unknown[])[3])
    : ZERO_ADDRESS
  const stakedAmount = agentData
    ? BigInt(String((agentData as readonly unknown[])[4]))
    : 0n
  const registeredAt = agentData
    ? BigInt(String((agentData as readonly unknown[])[5]))
    : 0n
  const stakeAmountFormatted =
    stakedAmount > 0n ? (Number(stakedAmount) / 1e18).toString() : '0'

  const app: RegisteredApp | null = owner
    ? {
        agentId,
        name: parsedName,
        description: parsedDescription,
        tokenURI: tokenURI ?? '',
        owner,
        tags: tags ? [...tags] : [],
        category: category || undefined,
        agentWallet:
          agentWallet && agentWallet !== ZERO_ADDRESS ? agentWallet : null,
        a2aEndpoint,
        stakeToken: resolveTokenName(stakedToken),
        stakeTokenAddress: stakedToken as Address,
        stakeAmount: stakeAmountFormatted,
        stakeAmountRaw: stakedAmount,
        stakeTier: tier,
        depositedAt: registeredAt,
      }
    : null

  const refetch = async () => {
    await Promise.all([
      refetchOwner(),
      refetchTokenURI(),
      refetchAgent(),
      refetchTags(),
      refetchCategory(),
      refetchEndpoint(),
      refetchWallet(),
    ])
  }

  return {
    app,
    isLoading,
    refetch,
  }
}

export function useRegistryMarketplaceActions() {
  const [lastTx, setLastTx] = useState<`0x${string}` | undefined>()
  const { data: txReceipt } = useWaitForTransactionReceipt({ hash: lastTx })
  const { writeAsync } = useTypedWriteContract()

  async function setEndpoints(
    agentId: bigint,
    a2aEndpoint: string,
    mcpEndpoint: string,
  ): Promise<{ success: boolean; error?: string }> {
    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setEndpoints',
      args: [agentId, a2aEndpoint, mcpEndpoint],
    })
    setLastTx(hash)
    return { success: true }
  }

  async function setCategory(
    agentId: bigint,
    category: string,
  ): Promise<{ success: boolean; error?: string }> {
    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setCategory',
      args: [agentId, category],
    })
    setLastTx(hash)
    return { success: true }
  }

  async function setX402Support(
    agentId: bigint,
    supported: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    const hash = await writeAsync({
      address: REGISTRY_ADDRESS,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setX402Support',
      args: [agentId, supported],
    })
    setLastTx(hash)
    return { success: true }
  }

  return {
    setEndpoints,
    setCategory,
    setX402Support,
    lastTransaction: txReceipt,
  }
}
