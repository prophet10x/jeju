import { fetchAgentWallet } from '@jejunetwork/shared'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type Address, getAddress, isAddress } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { CONTRACTS, EXPLORER_URL } from '../../lib/config'
import { useAgentId } from '../hooks/useAgentId'
import { useGaslessBootstrap } from '../hooks/useGaslessBootstrap'
import { useKMSKeys } from '../hooks/useKMSKeys'
import { useRegistry } from '../hooks/useRegistry'
import { useToast } from './Toast'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function toShortAddress(address: string | null | undefined): string {
  if (!address) return 'Not set'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export default function AgentWalletMigrationCard() {
  const { address, isConnected } = useAccount()
  const toast = useToast()
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
  const [isSavingWallet, setIsSavingWallet] = useState(false)
  const [isRefreshingWallets, setIsRefreshingWallets] = useState(false)
  const {
    data: kmsKeysData,
    isLoading: isLoadingKmsKeys,
    error: kmsKeysError,
  } = useKMSKeys()
  const { setAgentWallet, gasless, lastTransactionHash } = useRegistry()
  const gaslessBootstrap = useGaslessBootstrap({ gasless })

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

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId],
  )

  const currentWallet = selectedAgentId
    ? (currentWallets?.[selectedAgentId] ?? null)
    : null

  const isRegistryConfigured = CONTRACTS.identityRegistry !== ZERO_ADDRESS
  const connectedAddress = useMemo<Address | undefined>(() => {
    if (address && isAddress(address)) return getAddress(address)
    return undefined
  }, [address])
  const effectiveSmartAccountAddress = useMemo<Address | undefined>(() => {
    if (smartAccountAddress && isAddress(smartAccountAddress)) {
      return getAddress(smartAccountAddress)
    }
    return undefined
  }, [smartAccountAddress])
  const useGaslessOwnerPath = Boolean(
    selectedAgent &&
      effectiveSmartAccountAddress &&
      selectedAgent.owner.toLowerCase() ===
        effectiveSmartAccountAddress.toLowerCase() &&
      (!connectedAddress ||
        selectedAgent.owner.toLowerCase() !== connectedAddress.toLowerCase()),
  )
  const isBusy = isSavingWallet || gaslessBootstrap.isBootstrapping
  const kmsKeys = kmsKeysData?.keys ?? []
  const selectedKmsKeyAddress = useMemo(() => {
    const normalized = newWalletInput.trim().toLowerCase()
    const match = kmsKeys.find(
      (key) => key.address.toLowerCase() === normalized,
    )
    return match?.address ?? ''
  }, [kmsKeys, newWalletInput])

  const handleSetWallet = async () => {
    setFormError(null)
    setTxMessage(null)
    setTxHash(undefined)

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

    if (!selectedAgent) {
      setFormError('Selected agent could not be resolved.')
      return
    }

    const ownerLower = selectedAgent.owner.toLowerCase()
    const connectedLower = connectedAddress?.toLowerCase()
    const smartLower = effectiveSmartAccountAddress?.toLowerCase()

    if (ownerLower !== connectedLower && ownerLower !== smartLower) {
      setFormError(
        `Owner mismatch. Agent owner is ${selectedAgent.owner}, but connected owner context is ${connectedAddress ?? 'not connected'}${effectiveSmartAccountAddress ? ` / smart account ${effectiveSmartAccountAddress}` : ''}.`,
      )
      return
    }

    setIsSavingWallet(true)
    try {
      const wallet = getAddress(newWalletInput.trim())

      if (useGaslessOwnerPath) {
        if (!connectedAddress || !effectiveSmartAccountAddress) {
          throw new Error('Smart account owner mode is not ready yet.')
        }

        const readiness = gasless.getReadiness()
        if (!readiness.readyViaAllowance) {
          await gaslessBootstrap.bootstrap({
            purpose: 'registry',
            requiredStakeAmount: 0n,
            ownerAddress: connectedAddress,
            smartAccountAddress: effectiveSmartAccountAddress,
          })
        }
      }

      const result = await setAgentWallet(BigInt(selectedAgentId), wallet, {
        gasless: useGaslessOwnerPath,
      })
      setTxHash(result.txHash ?? lastTransactionHash)

      if (!result.success) {
        setFormError(
          result.error ??
            'Failed to update delegated wallet. Check explorer via the tx hash.',
        )
        return
      }

      const refreshed = await refetchWallets()
      const refreshedWallet = refreshed.data?.[selectedAgentId] ?? null
      if (
        !refreshedWallet ||
        refreshedWallet.toLowerCase() !== wallet.toLowerCase()
      ) {
        setFormError(
          'Transaction was submitted, but delegated wallet did not update on-chain. Check explorer via tx hash and retry.',
        )
        return
      }

      setTxMessage('Delegated wallet updated on-chain and verified.')
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'Failed to update delegated wallet.',
      )
    } finally {
      setIsSavingWallet(false)
    }
  }

  const handleRefreshWallets = async () => {
    setIsRefreshingWallets(true)
    try {
      const result = await refetchWallets()
      if (result.error) throw result.error
      toast.success('Delegated wallet state refreshed')
    } catch (error) {
      toast.error(
        'Failed to refresh delegated wallets',
        error instanceof Error ? error.message : 'Unknown refresh error',
      )
    } finally {
      setIsRefreshingWallets(false)
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

          <div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleRefreshWallets()}
              disabled={isRefreshingWallets || isBusy}
            >
              <RefreshCw size={16} /> Refresh Wallets
            </button>
          </div>

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
              {selectedAgent && useGaslessOwnerPath && (
                <div>
                  Write path: <code>gasless smart-account owner</code>
                </div>
              )}
              {selectedAgent &&
                !useGaslessOwnerPath &&
                connectedAddress &&
                selectedAgent.owner.toLowerCase() ===
                  connectedAddress.toLowerCase() && (
                  <div>
                    Write path: <code>direct owner EOA</code>
                  </div>
                )}
            </div>

            <label style={{ display: 'grid', gap: '0.35rem' }}>
              <span style={{ fontWeight: 600 }}>Saved KMS Key</span>
              <select
                className="input"
                value={selectedKmsKeyAddress}
                onChange={(event) => setNewWalletInput(event.target.value)}
                disabled={isBusy || !hasAgent || isLoadingKmsKeys}
              >
                <option value="">
                  {isLoadingKmsKeys
                    ? 'Loading your KMS keys...'
                    : kmsKeys.length > 0
                      ? 'Choose a saved KMS key'
                      : 'No saved KMS keys found'}
                </option>
                {kmsKeys.map((key) => (
                  <option key={key.keyId} value={key.address}>
                    {key.name || `Key ${key.keyId.slice(0, 8)}`} (
                    {toShortAddress(key.address)})
                  </option>
                ))}
              </select>
            </label>

            {kmsKeysError instanceof Error && (
              <div
                style={{
                  fontSize: '0.875rem',
                  color: 'var(--danger)',
                }}
              >
                Could not load KMS keys: <code>{kmsKeysError.message}</code>
              </div>
            )}

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
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Delegated wallet is the runtime signer. Owner wallet remains
                required for owner-only actions.
              </span>
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
                  {gaslessBootstrap.isBootstrapping
                    ? 'Preparing...'
                    : 'Saving...'}
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
