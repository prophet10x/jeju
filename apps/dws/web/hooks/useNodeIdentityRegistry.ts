import {
  buildNodeIdentityMetadataEntries,
  buildNodeIdentityPresentation,
  buildNodeIdentityTokenUri,
  getRegisteredAgentIdFromReceipt,
  IDENTITY_REGISTRY_ABI,
  type NodeIdentityMetadata,
} from '@jejunetwork/shared'
import { useCallback } from 'react'
import { encodeFunctionData, type Hex } from 'viem'
import { usePublicClient, useWriteContract } from 'wagmi'
import { CONTRACTS } from '../config'
import type { GaslessCall } from './useGaslessSmartAccount'
import { useGaslessSmartAccount } from './useGaslessSmartAccount'

interface RegisterNodeIdentityOptions {
  gasless?: boolean
}

interface RegisterNodeIdentityResult {
  success: boolean
  agentId?: bigint
  hash?: Hex
  error?: string
}

export function useNodeIdentityRegistry() {
  const publicClient = usePublicClient()
  const gasless = useGaslessSmartAccount()
  const { writeContractAsync } = useWriteContract()

  const waitForSuccessfulReceipt = useCallback(
    async (hash: Hex) => {
      if (!publicClient) {
        throw new Error('Public client is not available')
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        throw new Error('Transaction reverted on-chain')
      }

      return receipt
    },
    [publicClient],
  )

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
          serviceName: 'Jeju Node Identity Metadata',
          calls,
        })
        await waitForSuccessfulReceipt(hash)
        return
      }

      const categoryHash = await writeContractAsync({
        address: CONTRACTS.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'setCategory',
        args: [agentId, presentation.category],
      })
      await waitForSuccessfulReceipt(categoryHash)

      const serviceTypeHash = await writeContractAsync({
        address: CONTRACTS.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'setServiceType',
        args: [agentId, presentation.serviceType],
      })
      await waitForSuccessfulReceipt(serviceTypeHash)

      const tagsHash = await writeContractAsync({
        address: CONTRACTS.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'updateTags',
        args: [agentId, presentation.tags],
      })
      await waitForSuccessfulReceipt(tagsHash)
    },
    [gasless, waitForSuccessfulReceipt, writeContractAsync],
  )

  const registerNodeIdentity = useCallback(
    async (
      metadata: NodeIdentityMetadata,
      options: RegisterNodeIdentityOptions = {},
    ): Promise<RegisterNodeIdentityResult> => {
      try {
        const tokenURI = buildNodeIdentityTokenUri(metadata)
        const metadataEntries = buildNodeIdentityMetadataEntries(metadata)
        let hash: Hex

        if (options.gasless) {
          hash = await gasless.executeGaslessCalls({
            serviceName: 'Jeju Node Identity Registration',
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
          hash = await writeContractAsync({
            address: CONTRACTS.identityRegistry,
            abi: IDENTITY_REGISTRY_ABI,
            functionName: 'register',
            args: [tokenURI, metadataEntries],
          })
        }

        const receipt = await waitForSuccessfulReceipt(hash)
        const agentId = getRegisteredAgentIdFromReceipt(receipt)
        if (agentId === undefined) {
          throw new Error('Failed to decode node identity agent ID from receipt')
        }

        await persistNodePresentation(agentId, metadata, options)

        return { success: true, agentId, hash }
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Node identity registration failed',
        }
      }
    },
    [gasless, persistNodePresentation, waitForSuccessfulReceipt, writeContractAsync],
  )

  return {
    registerNodeIdentity,
  }
}
