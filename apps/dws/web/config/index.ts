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

// Chain configuration from config
export const CHAIN_ID = getChainId(NETWORK)
// Use the configured RPC URL for the current network
export const RPC_URL = getRpcUrl(NETWORK)
// DWS frontend is always served from the DWS API server itself,
// so use relative paths instead of absolute URLs from services.json.
// This works regardless of domain/IP (e.g., 52.206.203.24, dws.testnet.jejunetwork.org, localhost).
export const DWS_API_URL = ''
const APP_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''
// OAuth3 is served by DWS itself at /oauth3/*, so use origin-relative URL
// (empty string is falsy and treated as "not configured" by the OAuth3 client)
export const OAUTH3_AGENT_URL = APP_ORIGIN ? `${APP_ORIGIN}/oauth3` : '/oauth3'
export const DWS_IPFS_GATEWAY_URL = APP_ORIGIN
  ? `${APP_ORIGIN}/storage/ipfs`
  : '/storage/ipfs'
export const DWS_IPFS_API_URL = APP_ORIGIN
  ? `${APP_ORIGIN}/storage/api/v0`
  : '/storage/api/v0'

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

export const NODE_STAKING_WRITE_PATH = parseNodeStakingWritePath(
  readEnvVar('NODE_STAKING_WRITE_PATH'),
)
export const NODE_STAKING_CANARY_OPERATORS = parseCanaryOperators(
  readEnvVar('NODE_STAKING_CANARY_OPERATORS'),
)

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

  if (hasRouter) return router
  if (hasV2) return v2
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
