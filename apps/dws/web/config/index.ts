/**
 * DWS Web Frontend Configuration
 *
 * Uses @jejunetwork/config for all configuration.
 */

import {
  getChainId,
  getContractsConfig,
  getCurrentNetwork,
  getExplorerUrl,
  getRpcUrl,
  type NetworkType,
} from '@jejunetwork/config'
import { ZERO_ADDRESS } from '@jejunetwork/types'
import { type Address, getAddress } from 'viem'

// Network from config
export const NETWORK: NetworkType = getCurrentNetwork()

function getDwsBasePath(): string {
  const runtimePathname =
    typeof (globalThis as { location?: { pathname?: unknown } }).location
      ?.pathname === 'string'
      ? ((globalThis as { location?: { pathname?: string } }).location
          ?.pathname ?? '')
      : ''
  return runtimePathname === '/dws' ||
    runtimePathname.startsWith('/dws/')
    ? '/dws'
    : ''
}

// Chain configuration from config
export const CHAIN_ID = getChainId(NETWORK)
// Use the configured RPC URL for the current network
export const RPC_URL = getRpcUrl(NETWORK)
export const DWS_BASE_PATH = getDwsBasePath()
export function withDwsBase(path: string): string {
  const basePath = getDwsBasePath()
  const normalizedPath =
    path.length === 0 ? '/' : path.startsWith('/') ? path : `/${path}`
  return `${basePath}${normalizedPath}`
}
// DWS frontend is always served from the DWS API server itself,
// so use relative paths instead of absolute URLs from services.json.
// This works regardless of domain/IP (e.g., 52.206.203.24, dws.testnet.jejunetwork.org, localhost).
export const DWS_API_URL = getDwsBasePath()
const APP_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''
// OAuth3 is served by DWS itself at /oauth3/*, so use origin-relative URL
// (empty string is falsy and treated as "not configured" by the OAuth3 client)
export const OAUTH3_AGENT_URL = APP_ORIGIN
  ? `${APP_ORIGIN}${withDwsBase('/oauth3')}`
  : withDwsBase('/oauth3')
export const DWS_IPFS_GATEWAY_URL = APP_ORIGIN
  ? `${APP_ORIGIN}${withDwsBase('/storage/ipfs')}`
  : withDwsBase('/storage/ipfs')
export const DWS_STORAGE_API_URL = APP_ORIGIN
  ? `${APP_ORIGIN}${withDwsBase('/storage')}`
  : withDwsBase('/storage')
export const DWS_IPFS_API_URL = APP_ORIGIN
  ? `${APP_ORIGIN}${withDwsBase('/storage/api/v0')}`
  : withDwsBase('/storage/api/v0')

// Contract addresses from config
const contracts = getContractsConfig(NETWORK)

function optionalAddr(value: string | undefined): Address {
  if (!value) return ZERO_ADDRESS
  return getAddress(value)
}

export const CONTRACTS = {
  identityRegistry: optionalAddr(contracts.registry.identity),
  banManager: optionalAddr(contracts.moderation.banManager),
  moderationMarketplace: optionalAddr(
    contracts.moderation.moderationMarketplace,
  ),
  reportingSystem: optionalAddr(contracts.moderation.reportingSystem),
  computeRegistry: optionalAddr(contracts.compute.registry),
  jnsRegistry: optionalAddr(contracts.jns.registry),
  jnsResolver: optionalAddr(contracts.jns.resolver),
  x402Facilitator: optionalAddr(contracts.payments.x402Facilitator),
  creditManager: optionalAddr(contracts.payments.creditManager),
  multiTokenPaymaster: optionalAddr(contracts.payments.multiTokenPaymaster),
  priceOracle: optionalAddr(contracts.payments?.priceOracle),
  // Use nodeStaking.manager to match contracts.json structure
  nodeStakingManager: optionalAddr(contracts.nodeStaking?.manager),
  nodeStakingManagerV2: optionalAddr(
    contracts.nodeStaking?.managerV2 ?? contracts.nodeStaking?.manager,
  ),
  nodeStakingLegacyManagerV1: optionalAddr(
    contracts.nodeStaking?.legacyManagerV1 ?? contracts.nodeStaking?.manager,
  ),
  nodeStakingRegistry: optionalAddr(contracts.nodeStaking?.registry),
  nodeStakingVault: optionalAddr(contracts.nodeStaking?.vault),
  nodeStakingRouter: optionalAddr(contracts.nodeStaking?.router),
  nodeStakingModuleV3: optionalAddr(contracts.nodeStaking?.moduleV3),
  nodeStakingMigrationHandlerV3: optionalAddr(
    contracts.nodeStaking?.migrationHandlerV3,
  ),
  storageProviderRegistryV2: optionalAddr(
    contracts.dws?.storageProviderRegistryV2,
  ),
  storageRegistryV2: optionalAddr(contracts.dws?.storageRegistryV2),
  storageEscrowV2: optionalAddr(contracts.dws?.storageEscrowV2),
  storageRecoveryManagerV2: optionalAddr(
    contracts.dws?.storageRecoveryManagerV2,
  ),
  entryPointDeployed: optionalAddr(
    contracts.accountAbstraction?.entryPointDeployed ||
      contracts.accountAbstraction?.entryPointV07,
  ),
  entryPoint: optionalAddr(
    contracts.accountAbstraction?.entryPointDeployed ||
      contracts.accountAbstraction?.entryPointV07,
  ),
  entryPointV07: optionalAddr(
    contracts.accountAbstraction?.entryPointDeployed ||
      contracts.accountAbstraction?.entryPointV07,
  ),
  simpleAccountFactory: optionalAddr(
    contracts.accountAbstraction?.simpleAccountFactory,
  ),
} as const

export type NodeStakingWritePath =
  | 'auto'
  | 'router'
  | 'v2'
  | 'v1'
  | 'router-canary'

function readEnvVar(key: string): string | undefined {
  try {
    const importMeta = import.meta as unknown as {
      env?: Record<string, string | undefined>
    }
    const fromImportMeta =
      importMeta?.env?.[key] ??
      importMeta?.env?.[`VITE_${key}`] ??
      importMeta?.env?.[`PUBLIC_${key}`]
    if (fromImportMeta) return fromImportMeta
  } catch {
    // Ignore import.meta access failures outside Vite contexts.
  }

  if (typeof process !== 'undefined' && process.env) {
    return (
      process.env[key] ??
      process.env[`VITE_${key}`] ??
      process.env[`PUBLIC_${key}`]
    )
  }

  return undefined
}

function parseNodeStakingWritePath(
  value: string | undefined,
): NodeStakingWritePath {
  const normalized = (value ?? '').trim().toLowerCase()
  switch (normalized) {
    case 'router':
    case 'v2':
    case 'v1':
    case 'router-canary':
      return normalized as NodeStakingWritePath
    default:
      return 'auto'
  }
}

function parseCanaryOperators(value: string | undefined): Set<string> {
  if (!value) return new Set()
  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
}

function parseBooleanFlag(
  value: string | undefined,
  defaultValue = false,
): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

export const NODE_STAKING_WRITE_PATH = parseNodeStakingWritePath(
  readEnvVar('NODE_STAKING_WRITE_PATH'),
)
export const NODE_STAKING_CANARY_OPERATORS = parseCanaryOperators(
  readEnvVar('NODE_STAKING_CANARY_OPERATORS'),
)
export const NODE_STAKING_INCLUDE_LEGACY_READS = parseBooleanFlag(
  readEnvVar('NODE_STAKING_INCLUDE_LEGACY_READS'),
)

export function getNodeStakingReadAddresses(
  includeLegacy = NODE_STAKING_INCLUDE_LEGACY_READS,
): Address[] {
  const primary =
    CONTRACTS.nodeStakingManagerV2 !== ZERO_ADDRESS
      ? CONTRACTS.nodeStakingManagerV2
      : CONTRACTS.nodeStakingManager

  const candidates = includeLegacy
    ? [
        primary,
        CONTRACTS.nodeStakingRouter,
        CONTRACTS.nodeStakingLegacyManagerV1,
        CONTRACTS.nodeStakingManager,
      ]
    : [primary]

  return Array.from(
    new Set(
      candidates.filter(
        (address): address is Address =>
          Boolean(address) && address !== ZERO_ADDRESS,
      ),
    ),
  )
}

export function resolveNodeStakingWriteAddress(
  operatorAddress?: Address | string | null,
): Address {
  const router = CONTRACTS.nodeStakingRouter
  const v2 = CONTRACTS.nodeStakingManagerV2
  const v1 = CONTRACTS.nodeStakingLegacyManagerV1
  const operator = operatorAddress?.toLowerCase() ?? null
  const hasRouter = router && router !== ZERO_ADDRESS
  const hasV2 = v2 && v2 !== ZERO_ADDRESS
  const hasV1 = v1 && v1 !== ZERO_ADDRESS

  if (NODE_STAKING_WRITE_PATH === 'router-canary') {
    const useRouterForOperator =
      hasRouter &&
      operator !== null &&
      NODE_STAKING_CANARY_OPERATORS.has(operator)
    if (useRouterForOperator) return router
    if (hasV2) return v2
    if (hasV1) return v1
    return router
  }

  if (NODE_STAKING_WRITE_PATH === 'router' && hasRouter) return router
  if (NODE_STAKING_WRITE_PATH === 'v2' && hasV2) return v2
  if (NODE_STAKING_WRITE_PATH === 'v1' && hasV1) return v1

  // Atomic-safe default: prefer V2 direct writes over router in auto mode.
  if (hasV2) return v2
  if (hasRouter) return router
  return v1
}

export const BUNDLER_URL = APP_ORIGIN ? `${APP_ORIGIN}/bundler` : '/bundler'

// Token addresses from config
export const TOKENS = {
  jeju: optionalAddr(contracts.tokens?.jeju),
  usdc: optionalAddr(contracts.tokens?.usdc),
  weth: optionalAddr(contracts.tokens?.weth),
} as const

// Explorer URL from config
export const EXPLORER_URL = getExplorerUrl(NETWORK)

export const API_ENDPOINTS = {
  health: '/health',
  storage: '/storage',
  compute: '/compute',
  containers: '/containers',
  workers: '/workers',
  cdn: '/cdn',
  git: '/git',
  pkg: '/pkg',
  ci: '/ci',
  kms: '/kms',
  vpn: '/vpn',
  rpc: '/rpc',
  api: '/api',
  oauth3: '/oauth3',
  rlaif: '/rlaif',
  scraping: '/scraping',
} as const
