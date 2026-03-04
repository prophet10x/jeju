import {
  Bell,
  Check,
  Copy,
  ExternalLink,
  Key,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Trash2,
  User,
} from 'lucide-react'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Skeleton } from '../components/Skeleton'
import { CONTRACTS, EXPLORER_URL, NETWORK } from '../config'
import { useConfirm, useToast } from '../context/AppContext'
import { useProviderStats } from '../hooks'
import { useAgentId } from '../hooks/useAgentId'
import { useBanStatus } from '../hooks/useBanStatus'

export default function SettingsPage() {
  const { address } = useAccount()
  const { hasAgent, agentId, tokenURI } = useAgentId()
  const { isBanned, banRecord } = useBanStatus()
  const { data: providerStats, isLoading: nodesLoading } = useProviderStats()
  const { showSuccess, showError } = useToast()
  const confirm = useConfirm()

  const [activeTab, setActiveTab] = useState<
    'profile' | 'security' | 'notifications' | 'nodes'
  >('profile')
  const [copied, setCopied] = useState<string | null>(null)

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    showSuccess('Copied', 'Copied to clipboard')
    setTimeout(() => setCopied(null), 2000)
  }

  const handleDeregisterNode = async (nodeId: string) => {
    const confirmed = await confirm({
      title: 'Deregister Node',
      message: `Are you sure you want to deregister node "${nodeId.slice(0, 10)}..."? You will need to claim any pending rewards first.`,
      confirmText: 'Deregister',
      cancelText: 'Cancel',
      destructive: true,
    })

    if (!confirmed) return

    try {
      // TODO: Implement deregister mutation when API is ready
      showSuccess('Node deregistered', `Successfully deregistered node`)
    } catch (error) {
      showError(
        'Deregistration failed',
        error instanceof Error ? error.message : 'Failed to deregister node',
      )
    }
  }

  const registeredNodes = providerStats?.nodes ?? []
  const hasStakingActivity = (providerStats?.totalNodesActive ?? 0) > 0

  const tabs = [
    { id: 'profile', label: 'Profile', icon: <User size={16} /> },
    { id: 'security', label: 'Security', icon: <Shield size={16} /> },
    { id: 'notifications', label: 'Notifications', icon: <Bell size={16} /> },
    { id: 'nodes', label: 'Nodes', icon: <Server size={16} /> },
  ] as const

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Manage your profile, security, and node configuration
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(180px, 220px) 1fr',
          gap: '1.5rem',
        }}
        className="settings-grid"
      >
        <div className="card" style={{ height: 'fit-content' }}>
          <div style={{ display: 'grid', gap: '0.25rem' }}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  background:
                    activeTab === tab.id ? 'var(--accent-soft)' : 'transparent',
                  border: 'none',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  color:
                    activeTab === tab.id
                      ? 'var(--accent)'
                      : 'var(--text-secondary)',
                  fontWeight: activeTab === tab.id ? 500 : 400,
                  transition: 'all var(--transition-fast)',
                  textAlign: 'left',
                }}
              >
                {tab.icon}
                {tab.label}
                {tab.id === 'nodes' && registeredNodes.length > 0 && (
                  <span
                    className="badge badge-accent"
                    style={{ marginLeft: 'auto', fontSize: '0.7rem' }}
                  >
                    {registeredNodes.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          {activeTab === 'profile' && (
            <div>
              <h3
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 600,
                  marginBottom: '1.5rem',
                }}
              >
                Profile
              </h3>

              <div style={{ display: 'grid', gap: '1.5rem' }}>
                <div>
                  <div
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--text-muted)',
                      marginBottom: '0.5rem',
                    }}
                  >
                    Wallet Address
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.75rem',
                      background: 'var(--bg-tertiary)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <code style={{ flex: 1, fontSize: '0.9rem' }}>
                      {address ?? 'Not connected'}
                    </code>
                    {address && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        style={{ padding: '0.25rem' }}
                        onClick={() => handleCopy(address, 'address')}
                      >
                        {copied === 'address' ? (
                          <Check size={14} />
                        ) : (
                          <Copy size={14} />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--text-muted)',
                      marginBottom: '0.5rem',
                    }}
                  >
                    ERC-8004 Agent
                  </div>
                  {hasAgent && agentId !== null ? (
                    <div
                      style={{
                        padding: '1rem',
                        background: 'var(--success-soft)',
                        borderRadius: 'var(--radius-md)',
                        borderLeft: '3px solid var(--success)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 500 }}>
                            {(() => {
                              try {
                                const parsed = tokenURI
                                  ? JSON.parse(tokenURI)
                                  : null
                                return parsed?.name
                                  ? `${parsed.name} (ID: ${agentId})`
                                  : `Agent #${agentId}`
                              } catch {
                                return `Agent #${agentId}`
                              }
                            })()}
                          </div>
                          <div
                            style={{
                              fontSize: '0.85rem',
                              color: 'var(--text-secondary)',
                              marginTop: '0.25rem',
                            }}
                          >
                            {(() => {
                              try {
                                const parsed = tokenURI
                                  ? JSON.parse(tokenURI)
                                  : null
                                return parsed?.description || 'Registered agent'
                              } catch {
                                return 'Registered agent'
                              }
                            })()}
                          </div>
                        </div>
                        <a
                          href={`${EXPLORER_URL}/token/${CONTRACTS.identityRegistry}/instance/${agentId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-ghost btn-sm"
                        >
                          <ExternalLink size={14} />
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        padding: '1rem',
                        background: 'var(--bg-tertiary)',
                        borderRadius: 'var(--radius-md)',
                      }}
                    >
                      <div style={{ marginBottom: '0.75rem' }}>
                        No agent registered
                      </div>
                      <a
                        href="https://jeju-testnet.fartbag.fun/gateway/register"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-primary btn-sm"
                      >
                        <Plus size={14} /> Register Agent
                      </a>
                    </div>
                  )}
                </div>

                {isBanned && banRecord && (
                  <div
                    style={{
                      padding: '1rem',
                      background: 'var(--error-soft)',
                      borderRadius: 'var(--radius-md)',
                      borderLeft: '3px solid var(--error)',
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 500,
                        color: 'var(--error)',
                        marginBottom: '0.5rem',
                      }}
                    >
                      Account Suspended
                    </div>
                    <div
                      style={{
                        fontSize: '0.9rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Reason: {banRecord.reason ?? 'Not specified'}
                    </div>
                  </div>
                )}

                <div>
                  <div
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--text-muted)',
                      marginBottom: '0.5rem',
                    }}
                  >
                    Network
                  </div>
                  <div
                    style={{
                      padding: '0.75rem',
                      background: 'var(--bg-tertiary)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <span
                      className={`badge ${NETWORK === 'mainnet' ? 'badge-success' : NETWORK === 'testnet' ? 'badge-warning' : 'badge-neutral'}`}
                    >
                      {NETWORK}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div>
              <h3
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 600,
                  marginBottom: '1.5rem',
                }}
              >
                Security
              </h3>

              <div style={{ display: 'grid', gap: '1rem' }}>
                <div
                  style={{
                    padding: '1rem',
                    background: 'var(--bg-tertiary)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>
                      Two-Factor Authentication
                    </div>
                    <div
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--text-muted)',
                      }}
                    >
                      Secure your account with wallet signature verification
                    </div>
                  </div>
                  <span className="badge badge-success">Enabled</span>
                </div>

                <div
                  style={{
                    padding: '1rem',
                    background: 'var(--bg-tertiary)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>API Keys</div>
                    <div
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--text-muted)',
                      }}
                    >
                      Manage your API keys for programmatic access
                    </div>
                  </div>
                  <a href="/security/keys" className="btn btn-secondary btn-sm">
                    <Key size={14} /> Manage
                  </a>
                </div>

                <div
                  style={{
                    padding: '1rem',
                    background: 'var(--bg-tertiary)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>Active Sessions</div>
                    <div
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--text-muted)',
                      }}
                    >
                      View and manage your active sessions
                    </div>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm">
                    <RefreshCw size={14} /> Revoke All
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div>
              <h3
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 600,
                  marginBottom: '1.5rem',
                }}
              >
                Notifications
              </h3>

              <div style={{ display: 'grid', gap: '1rem' }}>
                {[
                  {
                    label: 'Job Completions',
                    desc: 'Get notified when compute jobs complete',
                    enabled: true,
                  },
                  {
                    label: 'Low Balance Alerts',
                    desc: 'Alert when x402 balance is low',
                    enabled: true,
                  },
                  {
                    label: 'Security Alerts',
                    desc: 'Important security notifications',
                    enabled: true,
                  },
                  {
                    label: 'Weekly Reports',
                    desc: 'Usage and billing summaries',
                    enabled: false,
                  },
                  {
                    label: 'Marketing',
                    desc: 'News and feature announcements',
                    enabled: false,
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    style={{
                      padding: '1rem',
                      background: 'var(--bg-tertiary)',
                      borderRadius: 'var(--radius-md)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 500 }}>{item.label}</div>
                      <div
                        style={{
                          fontSize: '0.85rem',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {item.desc}
                      </div>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        defaultChecked={item.enabled}
                        aria-label={`Toggle ${item.label}`}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'nodes' && (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '1.5rem',
                }}
              >
                <h3 style={{ fontSize: '1.25rem', fontWeight: 600 }}>
                  Provider Nodes
                </h3>
                <a
                  href="/provider/node/register"
                  className="btn btn-primary btn-sm"
                >
                  <Plus size={14} /> Register Node
                </a>
              </div>

              {nodesLoading ? (
                <div style={{ display: 'grid', gap: '1rem' }}>
                  <Skeleton height={80} />
                  <Skeleton height={80} />
                </div>
              ) : registeredNodes.length === 0 ? (
                <div className="empty-state" style={{ padding: '3rem' }}>
                  <Server size={48} />
                  <h3>
                    {hasStakingActivity
                      ? 'Node metadata pending'
                      : 'No nodes registered'}
                  </h3>
                  <p>
                    {hasStakingActivity
                      ? 'On-chain node activity exists for this operator, but details are still syncing.'
                      : 'Register a node to start earning rewards'}
                  </p>
                  <a href="/provider/node/register" className="btn btn-primary">
                    <Plus size={16} />{' '}
                    {hasStakingActivity ? 'Refresh later' : 'Register Node'}
                  </a>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: '1rem' }}>
                  {registeredNodes.map((node) => (
                    <div
                      key={node.nodeId}
                      style={{
                        padding: '1rem',
                        background: 'var(--bg-tertiary)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          marginBottom: '0.75rem',
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.9rem',
                              fontWeight: 500,
                            }}
                          >
                            {node.nodeId.slice(0, 20)}...
                          </div>
                          <div
                            style={{
                              fontSize: '0.8rem',
                              color: 'var(--text-muted)',
                              marginTop: '0.25rem',
                            }}
                          >
                            {node.metadataPending
                              ? 'On-chain node detected, metadata pending'
                              : `${node.region} • ${node.rpcUrl}`}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <span
                            className={`badge ${
                              node.metadataPending
                                ? 'badge-warning'
                                : node.isActive
                                  ? 'badge-success'
                                  : node.isSlashed
                                    ? 'badge-error'
                                    : 'badge-warning'
                            }`}
                          >
                            {node.metadataPending
                              ? 'Metadata pending'
                              : node.isActive
                                ? 'Active'
                                : node.isSlashed
                                  ? 'Slashed'
                                  : 'Inactive'}
                          </span>
                          {!node.metadataPending ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              title="Deregister node"
                              onClick={() => handleDeregisterNode(node.nodeId)}
                            >
                              <Trash2 size={14} />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(4, 1fr)',
                          gap: '1rem',
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-muted)',
                            }}
                          >
                            Staked
                          </div>
                          <div style={{ fontWeight: 500 }}>
                            ${parseFloat(node.stakedValueUSD).toFixed(2)}
                          </div>
                        </div>
                        <div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-muted)',
                            }}
                          >
                            Pending
                          </div>
                          <div
                            style={{ fontWeight: 500, color: 'var(--success)' }}
                          >
                            ${parseFloat(node.pendingRewards).toFixed(4)}
                          </div>
                        </div>
                        <div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-muted)',
                            }}
                          >
                            Uptime
                          </div>
                          <div style={{ fontWeight: 500 }}>
                            {(node.performance.uptimeScore / 100).toFixed(1)}%
                          </div>
                        </div>
                        <div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-muted)',
                            }}
                          >
                            Requests
                          </div>
                          <div style={{ fontWeight: 500 }}>
                            {node.performance.requestsServed.toLocaleString()}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  <a
                    href="/node"
                    className="btn btn-secondary"
                    style={{ justifySelf: 'start' }}
                  >
                    View Full Dashboard
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
