import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'

interface AgentInfo {
  id: string
  name: string
  owner: string
  tokenURI: string
  serviceType: string
  tier: string
}

export function useAgentId() {
  const { address, isConnected } = useAccount()

  const { data, isLoading } = useQuery({
    queryKey: ['agents', address],
    queryFn: async () => {
      const res = await fetch('/a2a/agents')
      if (!res.ok) return { agents: [] }
      return res.json() as Promise<{ agents: AgentInfo[] }>
    },
    enabled: isConnected && !!address,
  })

  const myAgents = data?.agents?.filter(
    (a) => a.owner.toLowerCase() === address?.toLowerCase(),
  ) ?? []

  const firstAgent = myAgents[0]

  return {
    hasAgent: myAgents.length > 0,
    agentId: firstAgent ? Number(firstAgent.id) : null,
    tokenURI: firstAgent?.tokenURI ?? null,
    isLoading,
    agents: myAgents,
  }
}
