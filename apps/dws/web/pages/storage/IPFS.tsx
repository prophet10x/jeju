import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  File,
  Globe,
  Lock,
  RefreshCw,
  Search,
  Shield,
  Upload,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { DWS_IPFS_API_URL, DWS_IPFS_GATEWAY_URL } from '../../config'
import { useRecentStorageUploads, useStorageHealth, useUploadFile } from '../../hooks'

type StorageClass = 'SYSTEM_PUBLIC' | 'PRIVATE_OWNER' | 'MANAGED_EXECUTION'

interface UploadFeedback {
  tone: 'success' | 'error'
  message: string
  cid?: string
  gatewayUrl?: string
  encryptionMode?: 'none' | 'kms'
}

const STORAGE_CLASS_OPTIONS: Array<{
  value: StorageClass
  label: string
  description: string
}> = [
  {
    value: 'SYSTEM_PUBLIC',
    label: 'System Public',
    description: 'Public Jeju content, unencrypted, suitable for metadata and artifacts.',
  },
  {
    value: 'PRIVATE_OWNER',
    label: 'Private Owner',
    description: 'Encrypted with KMS and intended for owner-controlled access.',
  },
  {
    value: 'MANAGED_EXECUTION',
    label: 'Managed Execution',
    description:
      'Encrypted-at-rest content for system-managed execution cohorts and standby recovery.',
  },
]

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function labelForStorageClass(storageClass?: string | null, tier?: string | null): string {
  if (storageClass === 'PRIVATE_OWNER') return 'Private Owner'
  if (storageClass === 'MANAGED_EXECUTION') return 'Managed Execution'
  if (storageClass === 'SYSTEM_PUBLIC') return 'System Public'
  if (tier === 'private') return 'Private Owner'
  if (tier === 'system') return 'System Public'
  return 'Public'
}

export default function IPFSPage() {
  const { isConnected, address } = useAccount()
  const {
    data: healthData,
    refetch: refetchHealth,
    isFetching: isRefreshingHealth,
  } = useStorageHealth()
  const {
    data: recentUploads,
    refetch: refetchUploads,
    isFetching: isRefreshingUploads,
  } = useRecentStorageUploads(address)
  const uploadFile = useUploadFile()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const publicGateway = DWS_IPFS_GATEWAY_URL
  const ipfsApiEndpoint = DWS_IPFS_API_URL

  const [searchQuery, setSearchQuery] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [storageClass, setStorageClass] =
    useState<StorageClass>('SYSTEM_PUBLIC')
  const [minReplicas, setMinReplicas] = useState(6)
  const [feedback, setFeedback] = useState<UploadFeedback | null>(null)

  const files = recentUploads?.items ?? []
  const totalSize = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const gatewayUrlForCid = (cid: string) => `${publicGateway}/${cid}`

  const filteredFiles = files.filter((file) => {
    const haystack = [
      file.cid,
      file.category ?? '',
      file.backend ?? '',
      file.owner ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(searchQuery.toLowerCase())
  })

  const handleRefresh = async () => {
    await Promise.all([refetchHealth(), refetchUploads()])
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const result = await uploadFile.mutateAsync({
        file,
        storageClass,
        minReplicas,
        tier: storageClass === 'SYSTEM_PUBLIC' ? 'system' : 'private',
        category: 'data',
      })

      const gatewayUrl = gatewayUrlForCid(result.cid)
      setFeedback({
        tone: 'success',
        message: `Upload stored successfully with ${result.encryptionMode === 'kms' ? 'KMS encryption' : 'public access'}.`,
        cid: result.cid,
        gatewayUrl,
        encryptionMode: result.encryptionMode,
      })
      await refetchUploads()
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Upload failed',
      })
    } finally {
      e.target.value = ''
    }
  }

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const activeClassOption =
    STORAGE_CLASS_OPTIONS.find((option) => option.value === storageClass) ??
    STORAGE_CLASS_OPTIONS[0]
  const encryptedClassesAvailable =
    healthData?.encryption.accessClasses.includes('PRIVATE_OWNER') &&
    healthData?.encryption.accessClasses.includes('MANAGED_EXECUTION')

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
          <h1 className="page-title">IPFS Storage</h1>
          <p className="page-description">
            Public gateway path stays at <code>/storage/ipfs/:cid</code>. This
            page now drives uploads with explicit storage classes and replica
            targets.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleRefresh()}
          >
            <RefreshCw
              size={16}
              className={
                isRefreshingHealth || isRefreshingUploads ? 'spin' : undefined
              }
            />{' '}
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConnected || uploadFile.isPending}
          >
            {uploadFile.isPending ? (
              <>
                <div className="spinner" style={{ width: 16, height: 16 }} />{' '}
                Uploading...
              </>
            ) : (
              <>
                <Upload size={16} /> Upload to IPFS
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={handleFileUpload}
          />
        </div>
      </div>

      <div className="stats-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="stat-card">
          <div className="stat-icon storage">
            <Globe size={24} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Uploads</div>
            <div className="stat-value">{files.length}</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon compute">
            <File size={24} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Tracked Size</div>
            <div className="stat-value">{formatBytes(totalSize)}</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon network">
            <Shield size={24} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Encrypted Classes</div>
            <div className="stat-value">
              <span
                className={`badge ${encryptedClassesAvailable ? 'badge-success' : 'badge-warning'}`}
              >
                {encryptedClassesAvailable ? 'Ready' : 'Unavailable'}
              </span>
            </div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon ai">
            <Globe size={24} />
          </div>
          <div className="stat-content">
            <div className="stat-label">Storage Health</div>
            <div className="stat-value">
              <span
                className={`badge ${healthData?.status === 'healthy' ? 'badge-success' : 'badge-warning'}`}
              >
                {healthData?.status ?? 'Unknown'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        className="card"
        style={{ marginBottom: '1.5rem', display: 'grid', gap: '1rem' }}
      >
        <div className="card-header">
          <h3 className="card-title">
            <Lock size={18} /> Upload Policy
          </h3>
        </div>
        <div
          style={{
            display: 'grid',
            gap: '1rem',
            gridTemplateColumns: 'minmax(220px, 1fr) minmax(180px, 220px)',
          }}
        >
          <label style={{ display: 'grid', gap: '0.5rem' }}>
            <span style={{ fontWeight: 600 }}>Storage Class</span>
            <select
              className="input"
              value={storageClass}
              onChange={(e) => setStorageClass(e.target.value as StorageClass)}
            >
              {STORAGE_CLASS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              {activeClassOption.description}
            </span>
          </label>

          <label style={{ display: 'grid', gap: '0.5rem' }}>
            <span style={{ fontWeight: 600 }}>Requested Min Replicas</span>
            <input
              className="input"
              type="number"
              min={4}
              max={10}
              value={minReplicas}
              onChange={(e) =>
                setMinReplicas(
                  Math.max(4, Math.min(10, Number.parseInt(e.target.value, 10) || 6)),
                )
              }
            />
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              Requested policy range is 4-10. Current live backend still reports
              actual backend placements separately from requested network
              replication.
            </span>
          </label>
        </div>

        <div
          style={{
            display: 'grid',
            gap: '0.4rem',
            color: 'var(--text-muted)',
            fontSize: '0.9rem',
          }}
        >
          <div>
            Public gateway: <code>{publicGateway}/:cid</code>
          </div>
          <div>
            API endpoint: <code>{ipfsApiEndpoint}</code>
          </div>
          <div>
            KMS mode:{' '}
            <code>
              {healthData?.encryption.mode ?? 'unknown'}
              {healthData?.encryption.configured ? '' : ' (not configured)'}
            </code>
          </div>
        </div>
      </div>

      {feedback ? (
        <div
          className="card"
          style={{
            marginBottom: '1.5rem',
            borderColor:
              feedback.tone === 'success'
                ? 'rgba(22, 163, 74, 0.35)'
                : 'rgba(220, 38, 38, 0.35)',
            background:
              feedback.tone === 'success'
                ? 'rgba(22, 163, 74, 0.08)'
                : 'rgba(220, 38, 38, 0.08)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gap: '0.5rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontWeight: 600,
              }}
            >
              {feedback.tone === 'success' ? (
                <Check size={18} />
              ) : (
                <AlertCircle size={18} />
              )}
              {feedback.tone === 'success' ? 'Upload complete' : 'Upload failed'}
            </div>
            <div>{feedback.message}</div>
            {feedback.cid ? (
              <div style={{ display: 'grid', gap: '0.35rem' }}>
                <div>
                  CID: <code>{feedback.cid}</code>
                </div>
                {feedback.encryptionMode ? (
                  <div>
                    Encryption mode: <code>{feedback.encryptionMode}</code>
                  </div>
                ) : null}
                {feedback.gatewayUrl ? (
                  <a
                    href={feedback.gatewayUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                  >
                    Open gateway URL <ExternalLink size={14} />
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Globe size={18} /> Recent Uploads
          </h3>
          <div style={{ flex: 1, maxWidth: '320px', marginLeft: '1rem' }}>
            <div style={{ position: 'relative' }}>
              <Search
                size={16}
                style={{
                  position: 'absolute',
                  left: '0.75rem',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-muted)',
                }}
              />
              <input
                className="input"
                placeholder="Search by CID, backend, category..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ paddingLeft: '2.25rem' }}
              />
            </div>
          </div>
        </div>

        {files.length === 0 ? (
          <div className="empty-state">
            <Globe size={48} />
            <h3>No tracked uploads yet</h3>
            <p>
              Upload a file to record an audit commitment and make it available
              under the public gateway path.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={!isConnected}
            >
              <Upload size={16} /> Upload File
            </button>
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>CID</th>
                  <th>Size</th>
                  <th>Class</th>
                  <th>Backend</th>
                  <th>Audit</th>
                  <th>Uploaded</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredFiles.map((file) => {
                  const gatewayUrl = gatewayUrlForCid(file.cid)
                  return (
                    <tr key={file.cid}>
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                          }}
                        >
                          <code
                            style={{
                              fontSize: '0.8rem',
                              maxWidth: '220px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                            title={file.cid}
                          >
                            {file.cid}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            style={{ padding: '0.25rem' }}
                            onClick={() => handleCopy(file.cid, file.cid)}
                            title="Copy CID"
                          >
                            {copied === file.cid ? (
                              <Check size={14} />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        </div>
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.85rem',
                        }}
                      >
                        {formatBytes(file.sizeBytes)}
                      </td>
                      <td>
                        <span className="badge badge-info">
                          {labelForStorageClass(undefined, file.tier)}
                        </span>
                      </td>
                      <td>{file.backend ?? 'unknown'}</td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.8rem',
                        }}
                      >
                        {formatBytes(file.audit.chunkSize)} x {file.audit.chunkCount}
                      </td>
                      <td>{formatTimestamp(file.createdAt)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <a
                            href={gatewayUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-ghost btn-icon"
                            title="Open in gateway"
                          >
                            <ExternalLink size={14} />
                          </a>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            onClick={() => handleCopy(gatewayUrl, `${file.cid}-url`)}
                            title="Copy gateway URL"
                          >
                            {copied === `${file.cid}-url` ? (
                              <Check size={14} />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
