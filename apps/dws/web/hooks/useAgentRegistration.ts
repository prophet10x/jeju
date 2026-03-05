import {
  JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
  JEJU_AGENT_REGISTRATION_SERVICE,
} from '@jejunetwork/shared'
import { ZERO_ADDRESS } from '@jejunetwork/types'
import { useState } from 'react'
import { decodeEventLog, encodeFunctionData, erc20Abi, type Hex } from 'viem'
import {
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { CONTRACTS, TOKENS } from '../config'
import type { GaslessCall } from './useGaslessSmartAccount'
import { useGaslessSmartAccount } from './useGaslessSmartAccount'

const REGISTRY_ADDRESS = CONTRACTS.identityRegistry

export const StakeTier = {
  NONE: 0,
  SMALL: 1,
  MEDIUM: 2,
  HIGH: 3,
} as const

export type StakeTierValue = (typeof StakeTier)[keyof typeof StakeTier]

const IDENTITY_REGISTRY_REGISTRATION_ABI = [
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
    inputs: [{ internalType: 'uint8', name: 'tier', type: 'uint8' }],
    name: 'getStakeAmount',
    outputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
    stateMutability: 'pure',
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
      { internalType: 'string', name: 'serviceType', type: 'string' },
    ],
    name: 'setServiceType',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

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

function encodeMetadataString(value: string): `0x${string}` {
  const bytes = new TextEncoder().encode(value)
  return `0x${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`
}

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

export interface RegisterAgentParams {
  tokenURI: string
  a2aEndpoint: string
  tier: StakeTierValue
  stakeToken: `0x${string}`
  stakeAmount: bigint
  tags?: string[]
  category?: string
  serviceType?: string
}

interface RegisterAgentOptions {
  gasless?: boolean
}

export function useAgentRegistration() {
  const [lastTxHash, setLastTxHash] = useState<`0x${string}`>()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()
  const gasless = useGaslessSmartAccount()
  const { data: lastTransaction } = useWaitForTransactionReceipt({
    hash: lastTxHash,
  })

  const waitForSuccessfulReceipt = async (hash: `0x${string}`) => {
    if (!publicClient) throw new Error('Public client is not available')
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      throw new Error('Transaction reverted on-chain')
    }
    return receipt
  }

  const getRegisteredAgentIdFromReceipt = (
    receipt: Awaited<ReturnType<typeof waitForSuccessfulReceipt>>,
  ): bigint | undefined => {
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
        // Ignore unrelated logs
      }
    }
    return undefined
  }

  const persistPresentation = async (
    agentId: bigint,
    params: {
      tags?: string[]
      category?: string
      serviceType?: string
      a2aEndpoint: string
    },
    options: RegisterAgentOptions,
  ) => {
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
            abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
            functionName: 'updateTags',
            args: [agentId, tags],
          }),
        })
      }

      if (category) {
        calls.push({
          to: REGISTRY_ADDRESS,
          data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
            functionName: 'setCategory',
            args: [agentId, category],
          }),
        })
      }

      if (serviceType) {
        calls.push({
          to: REGISTRY_ADDRESS,
          data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
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
        setLastTxHash(hash)
        await waitForSuccessfulReceipt(hash)
      }
      return
    }

    if (tags.length > 0) {
      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
        functionName: 'updateTags',
        args: [agentId, tags],
      })
      setLastTxHash(hash)
      await waitForSuccessfulReceipt(hash)
    }

    if (category) {
      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
        functionName: 'setCategory',
        args: [agentId, category],
      })
      setLastTxHash(hash)
      await waitForSuccessfulReceipt(hash)
    }

    if (serviceType) {
      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
        functionName: 'setServiceType',
        args: [agentId, serviceType],
      })
      setLastTxHash(hash)
      await waitForSuccessfulReceipt(hash)
    }
  }

  const registerAgent = async (
    params: RegisterAgentParams,
    options: RegisterAgentOptions = {},
  ): Promise<{ success: boolean; error?: string; agentId?: bigint }> => {
    try {
      if (REGISTRY_ADDRESS === ZERO_ADDRESS) {
        throw new Error('IdentityRegistry is not configured on this network')
      }

      const metadata: { key: string; value: Hex }[] = []
      if (params.a2aEndpoint) {
        metadata.push({
          key: 'a2aEndpoint',
          value: encodeMetadataString(params.a2aEndpoint),
        })
      }

      if (options.gasless) {
        if (
          params.tier !== StakeTier.NONE &&
          params.stakeToken.toLowerCase() !== TOKENS.jeju.toLowerCase()
        ) {
          return {
            success: false,
            error: 'Gasless registration currently supports JEJU staking only.',
          }
        }

        const calls: GaslessCall[] = []
        if (params.tier !== StakeTier.NONE) {
          calls.push({
            to: params.stakeToken,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [REGISTRY_ADDRESS, params.stakeAmount],
            }),
          })
        }

        calls.push({
          to: REGISTRY_ADDRESS,
          data:
            params.tier === StakeTier.NONE
              ? encodeFunctionData({
                  abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
                  functionName: 'register',
                  args: [params.tokenURI, metadata],
                })
              : encodeFunctionData({
                  abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
                  functionName: 'registerWithStake',
                  args: [
                    params.tokenURI,
                    metadata,
                    params.tier,
                    params.stakeToken,
                  ],
                }),
        })

        const hash = await gasless.executeGaslessCalls({
          serviceName: JEJU_AGENT_REGISTRATION_SERVICE,
          calls,
          requiredJejuBalance:
            params.tier === StakeTier.NONE ? 0n : params.stakeAmount,
        })

        setLastTxHash(hash)
        const receipt = await waitForSuccessfulReceipt(hash)
        const agentId = getRegisteredAgentIdFromReceipt(receipt)
        if (agentId !== undefined) {
          await persistPresentation(
            agentId,
            {
              tags: params.tags,
              category: params.category,
              serviceType: params.serviceType,
              a2aEndpoint: params.a2aEndpoint,
            },
            options,
          )
        }

        return { success: true, agentId }
      }

      if (
        params.tier !== StakeTier.NONE &&
        params.stakeToken !== ZERO_ADDRESS
      ) {
        const approveHash = await writeContractAsync({
          address: params.stakeToken,
          abi: erc20Abi,
          functionName: 'approve',
          args: [REGISTRY_ADDRESS, params.stakeAmount],
        })
        setLastTxHash(approveHash)
        await waitForSuccessfulReceipt(approveHash)
      }

      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
        functionName:
          params.tier === StakeTier.NONE ? 'register' : 'registerWithStake',
        args:
          params.tier === StakeTier.NONE
            ? [params.tokenURI, metadata]
            : [params.tokenURI, metadata, params.tier, params.stakeToken],
        value:
          params.tier !== StakeTier.NONE && params.stakeToken === ZERO_ADDRESS
            ? params.stakeAmount
            : 0n,
      })

      setLastTxHash(hash)
      const receipt = await waitForSuccessfulReceipt(hash)
      const agentId = getRegisteredAgentIdFromReceipt(receipt)
      if (agentId !== undefined) {
        await persistPresentation(
          agentId,
          {
            tags: params.tags,
            category: params.category,
            serviceType: params.serviceType,
            a2aEndpoint: params.a2aEndpoint,
          },
          options,
        )
      }

      return { success: true, agentId }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Registration transaction failed',
      }
    }
  }

  return {
    registerAgent,
    lastTransaction,
    gasless,
  }
}

export function useStakeAmount(tier: StakeTierValue) {
  const { data } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: IDENTITY_REGISTRY_REGISTRATION_ABI,
    functionName: 'getStakeAmount',
    args: [tier],
    query: {
      enabled: REGISTRY_ADDRESS !== ZERO_ADDRESS,
    },
  })

  return data as bigint | undefined
}
