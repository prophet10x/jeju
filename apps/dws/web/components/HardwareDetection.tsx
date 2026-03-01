/**
 * Hardware Detection Component
 *
 * Displays server system information fetched from the DWS backend,
 * helping users understand the server's hardware capabilities for node operation.
 */

import {
  getArchLabel,
  getPlatformLabel,
  type ReleaseArch,
  type ReleasePlatform,
} from '@jejunetwork/types'
import {
  AlertCircle,
  Check,
  Cpu,
  Database,
  HardDrive,
  Monitor,
  Server,
  Shield,
  Wifi,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { DWS_API_URL } from '../config'

interface ServerSystemInfo {
  platform: string
  arch: string
  hostname: string
  cpuCores: number
  cpuModel: string
  totalMemoryGb: number
  freeMemoryGb: number
  diskTotalGb: number
  diskFreeGb: number
  uptime: number
  nodeVersion: string
  bunVersion?: string
}

interface HardwareInfo {
  os: string
  arch: string
  cpuCores: number
  cpuModel: string
  memoryGb: number
  freeMemoryGb: number
  diskTotalGb: number
  diskFreeGb: number
  hostname: string
  uptime: number
  runtime: string
}

interface HardwareRequirement {
  name: string
  minimum: string
  detected: string
  status: 'pass' | 'warning' | 'fail' | 'unknown'
  icon: React.ReactNode
}

function mapPlatform(platform: string): ReleasePlatform | 'unknown' {
  switch (platform) {
    case 'linux': return 'linux'
    case 'darwin': return 'macos'
    case 'win32': return 'windows'
    default: return 'unknown'
  }
}

function mapArch(arch: string): ReleaseArch | 'unknown' {
  switch (arch) {
    case 'arm64':
    case 'aarch64': return 'arm64'
    case 'x64':
    case 'x86_64': return 'x64'
    default: return 'unknown'
  }
}

type RequirementStatus = 'pass' | 'warning' | 'fail' | 'unknown'

const STATUS_COLORS: Record<RequirementStatus, string> = {
  pass: 'var(--success)',
  warning: 'var(--warning)',
  fail: 'var(--error)',
  unknown: 'var(--text-secondary)',
}

const STATUS_BORDERS: Record<RequirementStatus, string> = {
  pass: '3px solid var(--success)',
  warning: '3px solid var(--warning)',
  fail: '3px solid var(--error)',
  unknown: '3px solid var(--border)',
}

function evaluateRequirements(hardware: HardwareInfo): HardwareRequirement[] {
  const requirements: HardwareRequirement[] = []

  // CPU cores
  const cpuStatus =
    hardware.cpuCores >= 4
      ? 'pass'
      : hardware.cpuCores >= 2
        ? 'warning'
        : hardware.cpuCores > 0
          ? 'fail'
          : 'unknown'
  requirements.push({
    name: 'CPU Cores',
    minimum: '2 cores (4+ recommended)',
    detected: hardware.cpuCores > 0 ? `${hardware.cpuCores} cores` : 'Unknown',
    status: cpuStatus,
    icon: <Cpu size={18} />,
  })

  // Memory
  const memoryStatus =
    hardware.memoryGb >= 8
      ? 'pass'
      : hardware.memoryGb >= 4
        ? 'warning'
        : hardware.memoryGb > 0
          ? 'fail'
          : 'unknown'
  requirements.push({
    name: 'Memory',
    minimum: '4 GB (8+ GB recommended)',
    detected:
      hardware.memoryGb > 0 ? `${hardware.memoryGb} GB` : 'Not available',
    status: memoryStatus,
    icon: <Database size={18} />,
  })

  // CPU Model
  requirements.push({
    name: 'CPU Model',
    minimum: 'Modern x64 or ARM processor',
    detected: hardware.cpuModel,
    status: hardware.cpuModel !== 'Unknown' ? 'pass' : 'unknown',
    icon: <Monitor size={18} />,
  })

  // Disk space
  const diskStatus =
    hardware.diskFreeGb >= 50
      ? 'pass'
      : hardware.diskFreeGb >= 20
        ? 'warning'
        : hardware.diskFreeGb > 0
          ? 'fail'
          : 'unknown'
  requirements.push({
    name: 'Disk Space',
    minimum: '20 GB free (50+ GB recommended)',
    detected:
      hardware.diskTotalGb > 0
        ? `${hardware.diskFreeGb} GB free / ${hardware.diskTotalGb} GB`
        : 'Not available',
    status: diskStatus,
    icon: <HardDrive size={18} />,
  })

  // Network (server is always connected)
  requirements.push({
    name: 'Network',
    minimum: '100 Mbps (1 Gbps+ recommended)',
    detected: 'Connected',
    status: 'pass',
    icon: <Wifi size={18} />,
  })

  // Secure context — warning (not fail) when accessed via HTTP IP
  const isSecure = typeof window !== 'undefined' && window.isSecureContext
  requirements.push({
    name: 'Secure Context',
    minimum: 'HTTPS recommended',
    detected: isSecure ? 'HTTPS' : 'HTTP',
    status: isSecure ? 'pass' : 'warning',
    icon: <Shield size={18} />,
  })

  return requirements
}

export default function HardwareDetection() {
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [requirements, setRequirements] = useState<HardwareRequirement[]>([])
  const [isExpanded, setIsExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${DWS_API_URL}/health/system`)
      .then((res) => res.json())
      .then((data: ServerSystemInfo) => {
        const hw: HardwareInfo = {
          os: data.platform,
          arch: data.arch,
          cpuCores: data.cpuCores,
          cpuModel: data.cpuModel,
          memoryGb: data.totalMemoryGb,
          freeMemoryGb: data.freeMemoryGb,
          diskTotalGb: data.diskTotalGb ?? 0,
          diskFreeGb: data.diskFreeGb ?? 0,
          hostname: data.hostname,
          uptime: data.uptime,
          runtime: data.bunVersion ? `Bun ${data.bunVersion}` : `Node ${data.nodeVersion}`,
        }
        setHardware(hw)
        setRequirements(evaluateRequirements(hw))
      })
      .catch((err) => {
        setError(err.message)
      })
  }, [])

  if (error) {
    return (
      <div className="card" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)' }}>
          <AlertCircle size={18} />
          <span>Could not fetch server system info</span>
        </div>
      </div>
    )
  }

  if (!hardware) {
    return (
      <div className="card" style={{ padding: '1.5rem', textAlign: 'center' }}>
        <div className="spinner" />
        <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>
          Fetching server info...
        </p>
      </div>
    )
  }

  const passCount = requirements.filter((r) => r.status === 'pass').length
  const warningCount = requirements.filter((r) => r.status === 'warning').length
  const failCount = requirements.filter((r) => r.status === 'fail').length

  const overallStatus =
    failCount > 0 ? 'fail' : warningCount > 0 ? 'warning' : 'pass'

  const osPlatform = mapPlatform(hardware.os)
  const osArch = mapArch(hardware.arch)

  return (
    <div className="card" style={{ marginBottom: '2rem' }}>
      <div className="card-header">
        <h3 className="card-title">
          <Server size={18} /> Server System Check
        </h3>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? 'Hide Details' : 'Show Details'}
        </button>
      </div>

      {/* Summary */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1.5rem',
          padding: '1rem',
          background: 'var(--bg-tertiary)',
          borderRadius: 'var(--radius-md)',
          marginBottom: isExpanded ? '1.5rem' : 0,
        }}
      >
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: 'var(--radius-md)',
            background:
              overallStatus === 'pass'
                ? 'var(--success-soft)'
                : overallStatus === 'warning'
                  ? 'var(--warning-soft)'
                  : 'var(--error-soft)',
            color:
              overallStatus === 'pass'
                ? 'var(--success)'
                : overallStatus === 'warning'
                  ? 'var(--warning)'
                  : 'var(--error)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {overallStatus === 'pass' ? (
            <Check size={24} />
          ) : overallStatus === 'warning' ? (
            <AlertCircle size={24} />
          ) : (
            <X size={24} />
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
            {osPlatform !== 'unknown' &&
              getPlatformLabel(osPlatform)}{' '}
            {osArch !== 'unknown' &&
              `(${getArchLabel(osArch)})`}
          </div>
          <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {passCount} passed
            {warningCount > 0 && `, ${warningCount} warnings`}
            {failCount > 0 && `, ${failCount} issues`}
            {' · '}{hardware.hostname}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span className="badge badge-secondary">
            {hardware.cpuCores} cores
          </span>
          <span className="badge badge-secondary">
            {hardware.memoryGb} GB RAM
          </span>
          {hardware.diskTotalGb > 0 && (
            <span className="badge badge-secondary">
              {hardware.diskFreeGb} GB free
            </span>
          )}
          <span className="badge badge-info">
            {hardware.runtime}
          </span>
        </div>
      </div>

      {/* Detailed requirements */}
      {isExpanded && (
        <div>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {requirements.map((req) => (
              <div
                key={req.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  padding: '0.75rem 1rem',
                  background: 'var(--bg-tertiary)',
                  borderRadius: 'var(--radius-sm)',
                  borderLeft: STATUS_BORDERS[req.status],
                }}
              >
                <div style={{ color: STATUS_COLORS[req.status] }}>
                  {req.icon}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{req.name}</div>
                  <div
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {req.minimum}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      fontWeight: 500,
                      color: STATUS_COLORS[req.status],
                    }}
                  >
                    {req.detected}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Server details */}
          <div
            style={{
              marginTop: '1rem',
              padding: '1rem',
              background: 'var(--bg-tertiary)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              gap: '2rem',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}
              >
                Hostname
              </div>
              <div style={{ fontWeight: 500 }}>{hardware.hostname}</div>
            </div>
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}
              >
                Free Memory
              </div>
              <div style={{ fontWeight: 500 }}>
                {hardware.freeMemoryGb} GB / {hardware.memoryGb} GB
              </div>
            </div>
            {hardware.diskTotalGb > 0 && (
              <div>
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                  }}
                >
                  Disk Space
                </div>
                <div style={{ fontWeight: 500 }}>
                  {hardware.diskFreeGb} GB free / {hardware.diskTotalGb} GB
                </div>
              </div>
            )}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}
              >
                Server Uptime
              </div>
              <div style={{ fontWeight: 500 }}>
                {Math.floor(hardware.uptime / 86400)}d {Math.floor((hardware.uptime % 86400) / 3600)}h
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}
              >
                Runtime
              </div>
              <div style={{ fontWeight: 500 }}>{hardware.runtime}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
