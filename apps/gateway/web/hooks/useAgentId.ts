import { useQuery } from '@tanstack/react-query'
import {
  fetchOwnedAgentIdentities,
  type OwnedAgentIdentity,
} from '@jejunetwork/shared'
import {
  getConfiguredAddress,
  predictSimpleAccountAddress,
} from '@jejunetwork/shared/gasless'
import { useMemo } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { CONTRACTS } from '../../lib/config'

export function useAgentId() {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()

  const { data, isLoading } = useQuery({
    queryKey: ['gateway-agents', address, CONTRACTS.simpleAccountFactory],
    queryFn: async () => {
      let smartAccountAddress: string | null = null

      if (publicClient && address) {
        const factoryAddress = getConfiguredAddress(CONTRACTS.simpleAccountFactory)
        if (factoryAddress) {
          try {
            smartAccountAddress = await predictSimpleAccountAddress({
              publicClient,
              factoryAddress,
              ownerAddress: address,
            })
          } catch {
            smartAccountAddress = null
          }
        }
      }

      const registryAddress = getConfiguredAddress(CONTRACTS.identityRegistry)
      if (!registryAddress) {
        return { agents: [], smartAccountAddress }
      }

      const agents = await fetchOwnedAgentIdentities({
        publicClient,
        registryAddress,
        ownerAddresses: [address, smartAccountAddress].filter(
          (candidate): candidate is string => Boolean(candidate),
        ),
      })

      return { agents, smartAccountAddress }
    },
    enabled: isConnected && !!address && !!publicClient,
  })

  const myAgents = useMemo<OwnedAgentIdentity[]>(() => data?.agents ?? [], [data?.agents])

  const firstAgent = myAgents[0]

  return {
    hasAgent: myAgents.length > 0,
    agentId: firstAgent ? Number(firstAgent.id) : null,
    tokenURI: firstAgent?.tokenURI ?? null,
    isLoading,
    agents: myAgents,
    smartAccountAddress: data?.smartAccountAddress ?? null,
  }
}
