import {
  buildNodeIdentityMetadataEntries,
  buildNodeIdentityPresentation,
  buildNodeIdentityTokenUri,
  describeNodeRegistrationError,
  getRegisteredAgentIdFromReceipt,
  IDENTITY_REGISTRY_ABI,
  JEJU_NODE_IDENTITY_METADATA_SERVICE,
  JEJU_NODE_IDENTITY_REGISTRATION_SERVICE,
  type NodeIdentityMetadata,
} from '@jejunetwork/shared'
import { useCallback } from 'react'
import { encodeFunctionData, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { CONTRACTS } from '../../lib/config'
import type { GaslessCall } from './useGaslessSmartAccount'
import { useGaslessSmartAccount } from './useGaslessSmartAccount'
import { useTypedWriteContract } from './useTypedWriteContract'

interface RegisterNodeIdentityOptions {
  gasless?: boolean
}

interface RegisterNodeIdentityResult {
  success: boolean
  agentId?: bigint
  hash?: Hex
  error?: string
}

async function waitForSuccessfulReceipt(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  hash: Hex,
) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error('Transaction reverted on-chain')
  }
  return receipt
}

export function useNodeIdentityRegistry() {
  const publicClient = usePublicClient()
  const { writeAsync } = useTypedWriteContract()
  const gasless = useGaslessSmartAccount()

  const persistNodePresentation = useCallback(
    async (
      agentId: bigint,
      metadata: NodeIdentityMetadata,
      options: RegisterNodeIdentityOptions,
    ) => {
      const presentation = buildNodeIdentityPresentation(metadata.services)
      const calls: GaslessCall[] = [
        {
          to: CONTRACTS.identityRegistry,
          data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'setCategory',
            args: [agentId, presentation.category],
          }),
        },
        {
          to: CONTRACTS.identityRegistry,
          data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'setServiceType',
            args: [agentId, presentation.serviceType],
          }),
        },
        {
          to: CONTRACTS.identityRegistry,
          data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'updateTags',
            args: [agentId, presentation.tags],
          }),
        },
      ]

      if (options.gasless) {
        const hash = await gasless.executeGaslessCalls({
          serviceName: JEJU_NODE_IDENTITY_METADATA_SERVICE,
          calls,
        })
        if (!publicClient) throw new Error('Public client is not available')
        await waitForSuccessfulReceipt(publicClient, hash)
        return hash
      }

      if (!publicClient) throw new Error('Public client is not available')

      const categoryHash = await writeAsync({
        address: CONTRACTS.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'setCategory',
        args: [agentId, presentation.category],
      })
      await waitForSuccessfulReceipt(publicClient, categoryHash)

      const serviceTypeHash = await writeAsync({
        address: CONTRACTS.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'setServiceType',
        args: [agentId, presentation.serviceType],
      })
      await waitForSuccessfulReceipt(publicClient, serviceTypeHash)

      const tagsHash = await writeAsync({
        address: CONTRACTS.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'updateTags',
        args: [agentId, presentation.tags],
      })
      await waitForSuccessfulReceipt(publicClient, tagsHash)

      return undefined
    },
    [gasless, publicClient, writeAsync],
  )

  const registerNodeIdentity = useCallback(
    async (
      metadata: NodeIdentityMetadata,
      options: RegisterNodeIdentityOptions = {},
    ): Promise<RegisterNodeIdentityResult> => {
      if (!publicClient) {
        return { success: false, error: 'Public client is not available' }
      }

      try {
        const tokenURI = buildNodeIdentityTokenUri(metadata)
        const metadataEntries = buildNodeIdentityMetadataEntries(metadata)

        let hash: Hex

        if (options.gasless) {
          hash = await gasless.executeGaslessCalls({
            serviceName: JEJU_NODE_IDENTITY_REGISTRATION_SERVICE,
            calls: [
              {
                to: CONTRACTS.identityRegistry,
                data: encodeFunctionData({
                  abi: IDENTITY_REGISTRY_ABI,
                  functionName: 'register',
                  args: [tokenURI, metadataEntries],
                }),
              },
            ],
          })
        } else {
          hash = await writeAsync({
            address: CONTRACTS.identityRegistry,
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'register',
            args: [tokenURI, metadataEntries],
          })
        }

        const receipt = await waitForSuccessfulReceipt(publicClient, hash)
        const agentId = getRegisteredAgentIdFromReceipt(receipt)
        if (agentId === undefined) {
          throw new Error(
            'Failed to decode node identity agent ID from receipt',
          )
        }

        await persistNodePresentation(agentId, metadata, options)

        return { success: true, agentId, hash }
      } catch (error) {
        return {
          success: false,
          error: describeNodeRegistrationError(
            error,
            'Node identity registration failed',
          ),
        }
      }
    },
    [gasless, persistNodePresentation, publicClient, writeAsync],
  )

  return {
    registerNodeIdentity,
  }
}
