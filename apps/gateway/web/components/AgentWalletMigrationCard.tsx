import { fetchAgentWallet } from '@jejunetwork/shared'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type Address, getAddress, isAddress } from 'viem'
import {
  useAccount,
  usePublicClient,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { CONTRACTS, EXPLORER_URL } from '../../lib/config'
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

function toShortAddress(address: string | null | undefined): string {
  if (!address) return 'Not set'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export default function AgentWalletMigrationCard() {
  const { isConnected } = useAccount()
  const publicClient = usePublicClient()
  const {
    agents,
    isLoading: isAgentLoading,
    hasAgent,
    smartAccountAddress,
  } = useAgentId()

  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [newWalletInput, setNewWalletInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}`>()
  const [txMessage, setTxMessage] = useState<string | null>(null)

  const { writeContractAsync, isPending: isSubmitting } = useWriteContract()
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0]?.id ?? '')
    }
  }, [agents, selectedAgentId])

  const {
    data: currentWallets,
    isLoading: walletsLoading,
    refetch: refetchWallets,
  } = useQuery({
    queryKey: [
      'gateway-agent-wallets',
      CONTRACTS.identityRegistry,
      agents.map((agent) => agent.id).join(','),
    ],
    enabled:
      isConnected &&
      Boolean(publicClient) &&
      agents.length > 0 &&
      CONTRACTS.identityRegistry !== ZERO_ADDRESS,
    queryFn: async () => {
      if (!publicClient) return {} as Record<string, Address | null>
      const pairs = await Promise.all(
        agents.map(async (agent) => {
          const wallet = await fetchAgentWallet({
            publicClient,
            registryAddress: CONTRACTS.identityRegistry,
            agentId: BigInt(agent.id),
          })
          return [agent.id, wallet] as const
        }),
      )
      return Object.fromEntries(pairs) as Record<string, Address | null>
    },
  })

  useEffect(() => {
    if (!isConfirmed) return
    setTxMessage(
      'Delegated wallet updated. getAgentWallet(agentId) has been refreshed from chain.',
    )
    void refetchWallets()
  }, [isConfirmed, refetchWallets])

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId],
  )

  const currentWallet = selectedAgentId
    ? (currentWallets?.[selectedAgentId] ?? null)
    : null

  const isRegistryConfigured = CONTRACTS.identityRegistry !== ZERO_ADDRESS
  const isBusy = isSubmitting || isConfirming

  const handleSetWallet = async () => {
    setFormError(null)
    setTxMessage(null)

    if (!selectedAgentId) {
      setFormError('Select an agent first.')
      return
    }

    if (!isAddress(newWalletInput)) {
      setFormError('Enter a valid EVM wallet address.')
      return
    }

    if (!isRegistryConfigured) {
      setFormError('IdentityRegistry is not configured on this network.')
      return
    }

    try {
      const wallet = getAddress(newWalletInput.trim())
      const hash = await writeContractAsync({
        address: CONTRACTS.identityRegistry,
        abi: AGENT_WALLET_ABI,
        functionName: 'setAgentWallet',
        args: [BigInt(selectedAgentId), wallet],
      })

      setTxHash(hash)
      setTxMessage(
        'Transaction submitted. Confirm in wallet and wait for receipt.',
      )
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'Failed to submit transaction.',
      )
    }
  }

  return (
    <div className="card" style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <h3 style={{ margin: 0 }}>Migrate Agent Delegated Wallet</h3>
        <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0 0' }}>
          Update agent signing wallet on-chain using{' '}
          <code>setAgentWallet(agentId, newKmsAddress)</code>.
        </p>
      </div>

      {!isConnected && (
        <div className="banner" style={{ background: 'var(--warning-soft)' }}>
          Connect a wallet to manage delegated agent wallets.
        </div>
      )}

      {isConnected && !isRegistryConfigured && (
        <div className="banner banner-error">
          IdentityRegistry is not configured for the current network.
        </div>
      )}

      {isConnected && isRegistryConfigured && (
        <>
          <ol
            style={{
              margin: 0,
              paddingLeft: '1.25rem',
              color: 'var(--text-secondary)',
            }}
          >
            <li>Pick your operator agent.</li>
            <li>Set the new KMS wallet address and confirm in Ledger.</li>
            <li>
              We auto-refresh `getAgentWallet(agentId)` after confirmation.
            </li>
          </ol>

          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <label style={{ display: 'grid', gap: '0.35rem' }}>
              <span style={{ fontWeight: 600 }}>Agent</span>
              <select
                className="input"
                disabled={isBusy || isAgentLoading || !hasAgent}
                value={selectedAgentId}
                onChange={(event) => setSelectedAgentId(event.target.value)}
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
                borderRadius: '0.75rem',
                border: '1px solid var(--border)',
                background: 'var(--surface-hover)',
                display: 'grid',
                gap: '0.35rem',
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
                <div>
                  Agent owner:{' '}
                  <code>{toShortAddress(selectedAgent.owner)}</code>
                </div>
              )}
              {smartAccountAddress && (
                <div>
                  Smart account:{' '}
                  <code>{toShortAddress(smartAccountAddress)}</code>
                </div>
              )}
            </div>

            <label style={{ display: 'grid', gap: '0.35rem' }}>
              <span style={{ fontWeight: 600 }}>New KMS Wallet</span>
              <input
                className="input"
                type="text"
                placeholder="0x..."
                value={newWalletInput}
                onChange={(event) => setNewWalletInput(event.target.value)}
                disabled={isBusy || !hasAgent}
              />
            </label>

            <button
              type="button"
              className="button"
              onClick={() => void handleSetWallet()}
              disabled={isBusy || !hasAgent || !selectedAgentId}
            >
              {isBusy ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {isSubmitting ? 'Submitting...' : 'Confirming...'}
                </>
              ) : (
                'Set Delegated Wallet'
              )}
            </button>
          </div>
        </>
      )}

      {formError && (
        <div
          className="banner banner-error"
          style={{ display: 'flex', gap: '0.5rem' }}
        >
          <AlertCircle size={16} />
          {formError}
        </div>
      )}

      {txMessage && (
        <div
          className="banner"
          style={{
            display: 'flex',
            gap: '0.5rem',
            background: isConfirmed
              ? 'var(--success-soft)'
              : 'var(--surface-hover)',
            color: isConfirmed ? 'var(--success)' : 'var(--text-secondary)',
          }}
        >
          <CheckCircle2 size={16} />
          <span>{txMessage}</span>
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
