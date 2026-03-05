import { fetchAgentWallet } from '@jejunetwork/shared'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type Address, getAddress, isAddress } from 'viem'
import {
  useAccount,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { CONTRACTS, EXPLORER_URL } from '../config'
import { useAgentId } from '../hooks/useAgentId'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const AGENT_WALLET_ABI = [
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
] as const

export default function AgentWalletMigrationCard() {
  const { isConnected } = useAccount()
  const publicClient = usePublicClient()
  const {
    agents,
    hasAgent,
    isLoading: agentsLoading,
    smartAccountAddress,
  } = useAgentId()

  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [newWallet, setNewWallet] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}`>()

  const { writeContractAsync, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  useEffect(() => {
    if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0]?.id ?? '')
    }
  }, [agents, selectedAgentId])

  const {
    data: walletsByAgent,
    isLoading: walletsLoading,
    refetch: refetchWallets,
  } = useQuery({
    queryKey: [
      'dws-agent-wallets',
      CONTRACTS.identityRegistry,
      agents.map((agent) => agent.id).join(','),
    ],
    enabled:
      isConnected &&
      Boolean(publicClient) &&
      CONTRACTS.identityRegistry !== ZERO_ADDRESS &&
      agents.length > 0,
    queryFn: async () => {
      if (!publicClient) return {} as Record<string, Address | null>
      const entries = await Promise.all(
        agents.map(async (agent) => {
          const wallet = await fetchAgentWallet({
            publicClient,
            registryAddress: CONTRACTS.identityRegistry,
            agentId: BigInt(agent.id),
          })
          return [agent.id, wallet] as const
        }),
      )
      return Object.fromEntries(entries) as Record<string, Address | null>
    },
  })

  useEffect(() => {
    if (!isSuccess) return
    setStatusMessage(
      'Delegated wallet updated. Refreshed on-chain value from getAgentWallet(agentId).',
    )
    void refetchWallets()
  }, [isSuccess, refetchWallets])

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId],
  )

  const currentWallet = selectedAgentId
    ? (walletsByAgent?.[selectedAgentId] ?? null)
    : null

  const isBusy = isPending || isConfirming
  const registryConfigured = CONTRACTS.identityRegistry !== ZERO_ADDRESS

  const submit = async () => {
    setError(null)
    setStatusMessage(null)

    if (!selectedAgentId) {
      setError('Select an agent first.')
      return
    }

    if (!isAddress(newWallet)) {
      setError('Enter a valid EVM wallet address.')
      return
    }

    if (!registryConfigured) {
      setError('IdentityRegistry is not configured for this network.')
      return
    }

    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.identityRegistry,
        abi: AGENT_WALLET_ABI,
        functionName: 'setAgentWallet',
        args: [BigInt(selectedAgentId), getAddress(newWallet.trim())],
      })

      setTxHash(hash)
      setStatusMessage(
        'Transaction submitted. Confirm in wallet and wait for receipt.',
      )
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Failed to submit transaction.',
      )
    }
  }

  return (
    <div className="card" style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <h3 style={{ margin: 0 }}>Agent Wallet Migration</h3>
        <p style={{ margin: '0.5rem 0 0', color: 'var(--text-secondary)' }}>
          Use <code>setAgentWallet(agentId, newKmsAddress)</code> without
          leaving DWS.
        </p>
      </div>

      {!isConnected && (
        <div
          style={{
            padding: '0.75rem',
            borderRadius: 'var(--radius-md)',
            background: 'var(--warning-soft)',
          }}
        >
          Connect a wallet to migrate delegated agent wallets.
        </div>
      )}

      {isConnected && !registryConfigured && (
        <div
          style={{
            padding: '0.75rem',
            borderRadius: 'var(--radius-md)',
            background: 'var(--error-soft)',
            color: 'var(--error)',
          }}
        >
          IdentityRegistry is not configured on this network.
        </div>
      )}

      {isConnected && registryConfigured && (
        <>
          <ol
            style={{
              margin: 0,
              paddingLeft: '1.25rem',
              color: 'var(--text-secondary)',
            }}
          >
            <li>Pick an operator agent.</li>
            <li>Set the new KMS wallet and confirm in Ledger.</li>
            <li>DWS re-reads getAgentWallet(agentId) automatically.</li>
          </ol>

          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <label style={{ display: 'grid', gap: '0.35rem' }}>
              <span style={{ fontWeight: 600 }}>Operator Agent</span>
              <select
                className="form-select"
                value={selectedAgentId}
                onChange={(event) => setSelectedAgentId(event.target.value)}
                disabled={isBusy || agentsLoading || !hasAgent}
              >
                {agents.length === 0 && (
                  <option value="">No operator agents found</option>
                )}
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    Agent #{agent.id}
                    {agent.name ? ` - ${agent.name}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <div
              style={{
                padding: '0.75rem',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                background: 'var(--bg-secondary)',
                fontSize: '0.875rem',
              }}
            >
              <div>
                Current delegated wallet:{' '}
                <code>
                  {walletsLoading ? 'Loading...' : (currentWallet ?? 'Not set')}
                </code>
              </div>
              {selectedAgent && (
                <div style={{ marginTop: '0.35rem' }}>
                  Agent owner: <code>{selectedAgent.owner}</code>
                </div>
              )}
              {smartAccountAddress && (
                <div style={{ marginTop: '0.35rem' }}>
                  Smart account: <code>{smartAccountAddress}</code>
                </div>
              )}
            </div>

            <label style={{ display: 'grid', gap: '0.35rem' }}>
              <span style={{ fontWeight: 600 }}>New KMS Wallet</span>
              <input
                className="form-input"
                type="text"
                placeholder="0x..."
                value={newWallet}
                onChange={(event) => setNewWallet(event.target.value)}
                disabled={isBusy || !hasAgent}
              />
            </label>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={isBusy || !hasAgent || !selectedAgentId}
            >
              {isBusy ? (
                <>
                  <Loader2 size={16} className="animate-spin" />{' '}
                  {isPending ? 'Submitting...' : 'Confirming...'}
                </>
              ) : (
                'Set Delegated Wallet'
              )}
            </button>
          </div>
        </>
      )}

      {error && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            padding: '0.75rem',
            borderRadius: 'var(--radius-md)',
            background: 'var(--error-soft)',
            color: 'var(--error)',
          }}
        >
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {statusMessage && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            padding: '0.75rem',
            borderRadius: 'var(--radius-md)',
            background: isSuccess
              ? 'var(--success-soft)'
              : 'var(--bg-secondary)',
            color: isSuccess ? 'var(--success)' : 'var(--text-secondary)',
          }}
        >
          <CheckCircle2 size={16} />
          <span>{statusMessage}</span>
          {txHash && (
            <a
              href={`${EXPLORER_URL}/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              Explorer <ExternalLink size={14} />
            </a>
          )}
        </div>
      )}
    </div>
  )
}
