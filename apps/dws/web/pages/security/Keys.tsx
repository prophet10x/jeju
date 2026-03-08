import {
  Check,
  Copy,
  Key,
  Lock,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react'
import { useJejuAuth } from '@jejunetwork/auth/react'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { useToast } from '../../context/AppContext'
import {
  useCreateKey,
  useDeleteKey,
  useKMSHealth,
  useKMSKeys,
} from '../../hooks'

function truncateMiddle(value: string, leading = 6, trailing = 4): string {
  if (value.length <= leading + trailing + 3) return value
  return `${value.slice(0, leading)}...${value.slice(-trailing)}`
}

export default function KeysPage() {
  const { address, isConnected } = useAccount()
  const { authenticated, walletAddress } = useJejuAuth()
  const { showError, showSuccess } = useToast()
  const { data: keysData, isLoading, refetch } = useKMSKeys()
  const { data: kmsHealth } = useKMSHealth()
  const createKey = useCreateKey()
  const deleteKey = useDeleteKey()

  const [showModal, setShowModal] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    threshold: '2',
    totalParties: '3',
  })

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    await createKey.mutateAsync({
      name: formData.name || 'threshold-key',
      threshold: parseInt(formData.threshold, 10),
      totalParties: parseInt(formData.totalParties, 10),
    })
    setShowModal(false)
    setFormData({ name: '', threshold: '2', totalParties: '3' })
  }

  const handleCopy = async (text: string, id: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }

      setCopied(id)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'absolute'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(id)
      setTimeout(() => setCopied(null), 2000)
    }
  }

  const handleDelete = async (keyId: string, keyName: string) => {
    if (!window.confirm(`Delete key "${keyName}"? This cannot be undone.`)) {
      return
    }
    await deleteKey
      .mutateAsync(keyId)
      .then(() => showSuccess('Key deleted', `Deleted key "${keyName}"`))
      .catch((error) =>
        showError(
          'Delete failed',
          error instanceof Error ? error.message : 'Failed to delete key',
        ),
      )
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      const result = await refetch()
      if (result.error) throw result.error
      showSuccess('KMS keys refreshed')
    } catch (error) {
      showError(
        'Refresh failed',
        error instanceof Error ? error.message : 'Failed to refresh keys',
      )
    } finally {
      setIsRefreshing(false)
    }
  }

  const requestAddress = walletAddress ?? address ?? undefined
  const canManageKeys = Boolean(requestAddress)
  const authSourceLabel =
    authenticated && walletAddress
      ? 'authenticated smart-account session'
      : isConnected
        ? 'connected wallet'
        : null
  const keys = keysData?.keys ?? []
  const securityMode = kmsHealth?.mode?.toUpperCase() ?? 'UNKNOWN'
  const securityDetail = kmsHealth
    ? kmsHealth.teeAttested
      ? kmsHealth.hsmConfigured
        ? 'TEE attested, HSM-backed'
        : kmsHealth.hsmAvailable
          ? 'TEE attested, HSM available (not configured)'
          : 'TEE attested'
      : kmsHealth.teeAvailable
        ? kmsHealth.hsmConfigured
          ? 'TEE available (attestation pending), HSM-backed'
          : kmsHealth.hsmAvailable
            ? 'TEE available (attestation pending), HSM available (not configured)'
            : 'TEE available (attestation pending)'
        : kmsHealth.hsmConfigured
          ? 'HSM-backed, no TEE attestation'
          : kmsHealth.hsmAvailable
            ? 'HSM available (not configured), no TEE attestation'
            : 'No TEE or HSM available'
    : null

  return (
    <div>
      <div
        className="page-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <h1 className="page-title">Key Management (KMS)</h1>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
          >
            <RefreshCw size={16} className={isRefreshing ? 'spin' : undefined} /> Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowModal(true)}
            disabled={!canManageKeys}
            title={
              canManageKeys
                ? 'Create a new threshold key'
                : 'Sign In with your owner wallet or passkey first'
            }
          >
            <Plus size={16} /> Create Key
          </button>
        </div>
      </div>

      <div
        className="card"
        style={{
          marginBottom: '1.5rem',
          borderColor: canManageKeys
            ? 'rgba(14, 165, 233, 0.2)'
            : 'rgba(245, 158, 11, 0.35)',
          background: canManageKeys
            ? 'rgba(14, 165, 233, 0.05)'
            : 'rgba(245, 158, 11, 0.06)',
        }}
      >
        <div
          style={{
            padding: '1rem 1.25rem',
            color: 'var(--text-secondary)',
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {canManageKeys ? (
            <>
              <span>Using {authSourceLabel} for KMS ownership:</span>
              <code style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>
                {requestAddress}
              </code>
            </>
          ) : (
            <span>
              Sign In in the top-right with your owner wallet or passkey before
              creating KMS keys.
            </span>
          )}
        </div>
      </div>

      <div className="stats-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="stat-card">
          <div className="stat-icon compute">
            <Key size={24} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Total Keys</div>
            <div className="stat-value">{keys.length}</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon storage">
            <Shield size={24} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Security Mode</div>
            <div className="stat-value">{securityMode}</div>
            {securityDetail ? (
              <div className="stat-subtitle">{securityDetail}</div>
            ) : null}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon network">
            <Lock size={24} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Threshold Parties</div>
            <div className="stat-value">
              {keys.reduce((sum, k) => sum + k.totalParties, 0)}
            </div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon auth">
            <Shield size={24} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Persistence</div>
            <div className="stat-value" style={{ fontSize: '1rem' }}>
              {kmsHealth?.persistenceEnabled ? 'Encrypted File' : 'Ephemeral'}
            </div>
            {kmsHealth?.keysRestoredAt ? (
              <div className="stat-subtitle">
                Restored {new Date(kmsHealth.keysRestoredAt).toLocaleTimeString()}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Key size={18} /> Keys
          </h3>
        </div>

        {kmsHealth ? (
          <div
            style={{
              margin: '0 1.5rem 1rem',
              padding: '0.875rem 1rem',
              borderRadius: '0.75rem',
              border: '1px solid var(--border-color)',
              background: kmsHealth.persistenceEnabled
                ? 'rgba(14, 165, 233, 0.08)'
                : 'rgba(245, 158, 11, 0.08)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>
                {kmsHealth.persistenceEnabled
                  ? 'Restart-safe KMS is enabled'
                  : 'KMS keys are still ephemeral'}
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                {kmsHealth.persistenceEnabled
                  ? `${kmsHealth.persistentKeys} persisted key${kmsHealth.persistentKeys === 1 ? '' : 's'} stored via ${kmsHealth.persistenceBackend}.`
                  : 'Configure KMS_STATE_KEY or DWS_VAULT_KEY to preserve keys across DWS restarts.'}
              </div>
            </div>
            {kmsHealth.persistenceFile ? (
              <code
                style={{
                  fontSize: '0.8rem',
                  wordBreak: 'break-all',
                  color: 'var(--text-secondary)',
                }}
              >
                {kmsHealth.persistenceFile}
              </code>
            ) : null}
          </div>
        ) : null}

        {deleteKey.isError ? (
          <div
            style={{
              margin: '0 1.5rem 1rem',
              padding: '0.875rem 1rem',
              borderRadius: '0.75rem',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              background: 'rgba(239, 68, 68, 0.08)',
              color: 'var(--text-primary)',
            }}
          >
            {deleteKey.error instanceof Error
              ? deleteKey.error.message
              : 'Failed to delete key'}
          </div>
        ) : null}

        {isLoading ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: '3rem',
            }}
          >
            <div className="spinner" />
          </div>
        ) : keys.length === 0 ? (
          <div className="empty-state">
            <Key size={48} />
            <h3>No keys yet</h3>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowModal(true)}
              disabled={!canManageKeys}
              title={
                canManageKeys
                  ? 'Create a new threshold key'
                  : 'Sign In with your owner wallet or passkey first'
              }
            >
              <Plus size={16} /> Create Key
            </button>
            {!canManageKeys ? (
              <p
                style={{
                  marginTop: '0.75rem',
                  color: 'var(--text-secondary)',
                  fontSize: '0.9rem',
                }}
              >
                Key creation requires a wallet-authenticated request.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="table-container">
            <table
              className="table"
              style={{ tableLayout: 'fixed', width: '100%' }}
            >
              <colgroup>
              <col style={{ width: '14%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '6%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '6%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Key ID</th>
                  <th>Name</th>
                  <th>Public Key</th>
                  <th>Address</th>
                  <th>Threshold</th>
                  <th>Version</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.keyId}>
                    <td
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.85rem',
                        maxWidth: '220px',
                        wordBreak: 'break-all',
                      }}
                      title={key.keyId}
                    >
                      {key.keyId}
                    </td>
                    <td
                      style={{
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={key.name}
                    >
                      {key.name}
                    </td>
                    <td>
                      {key.publicKey ? (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            width: '100%',
                          }}
                        >
                          <code
                            style={{
                              fontSize: '0.8rem',
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={key.publicKey}
                          >
                            {truncateMiddle(key.publicKey, 12, 10)}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            style={{ padding: '0.25rem' }}
                            onClick={() =>
                              handleCopy(key.publicKey, `pk-${key.keyId}`)
                            }
                          >
                            {copied === `pk-${key.keyId}` ? (
                              <Check size={14} />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>
                          Unavailable
                        </span>
                      )}
                    </td>
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          width: '100%',
                        }}
                      >
                        <code
                          style={{
                            fontSize: '0.8rem',
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={key.address}
                        >
                          {truncateMiddle(key.address, 6, 4)}
                        </code>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          style={{ padding: '0.25rem' }}
                          onClick={() =>
                            handleCopy(key.address, `addr-${key.keyId}`)
                          }
                        >
                          {copied === `addr-${key.keyId}` ? (
                            <Check size={14} />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                      </div>
                    </td>
                    <td>
                      <span className="badge badge-accent">
                        {key.threshold} of {key.totalParties}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>
                      v{key.version}
                    </td>
                    <td>{new Date(key.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        title="Delete"
                        onClick={() => handleDelete(key.keyId, key.name)}
                        disabled={deleteKey.isPending}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={() => setShowModal(false)}
            aria-label="Close modal"
          />
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                setShowModal(false)
              }
            }}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-header">
              <h3 className="modal-title">Create Threshold Key</h3>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setShowModal(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="form-group" style={{ marginBottom: '1rem' }}>
                  <label htmlFor="key-name" className="form-label">
                    Key Name
                  </label>
                  <input
                    id="key-name"
                    className="input"
                    type="text"
                    placeholder="e.g. storage-reporter"
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                  />
                  <div className="form-hint">A label to identify this key</div>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '1rem',
                  }}
                >
                  <div className="form-group">
                    <label htmlFor="key-threshold" className="form-label">
                      Threshold (M)
                    </label>
                    <select
                      id="key-threshold"
                      className="input"
                      value={formData.threshold}
                      onChange={(e) =>
                        setFormData({ ...formData, threshold: e.target.value })
                      }
                    >
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                      <option value="5">5</option>
                    </select>
                    <div className="form-hint">Signatures required</div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="key-total-parties" className="form-label">
                      Total Parties (N)
                    </label>
                    <select
                      id="key-total-parties"
                      className="input"
                      value={formData.totalParties}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          totalParties: e.target.value,
                        })
                      }
                    >
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="5">5</option>
                      <option value="7">7</option>
                    </select>
                    <div className="form-hint">Total key shares</div>
                  </div>
                </div>
                {createKey.isError ? (
                  <div
                    style={{
                      marginTop: '1rem',
                      padding: '0.875rem 1rem',
                      borderRadius: '0.75rem',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      background: 'rgba(239, 68, 68, 0.08)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {createKey.error instanceof Error
                      ? createKey.error.message
                      : 'Failed to create key'}
                  </div>
                ) : null}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={createKey.isPending}
                >
                  {createKey.isPending ? (
                    'Creating...'
                  ) : (
                    <>
                      <Key size={16} /> Create Key
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
