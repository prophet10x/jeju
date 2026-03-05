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
// OAuth3 is served by DWS itself at /oauth3/*, so use origin-relative URL
// (empty string is falsy and treated as "not configured" by the OAuth3 client)
export const OAUTH3_AGENT_URL =
  typeof window !== 'undefined' ? `${window.location.origin}/oauth3` : '/oauth3'

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
  // Use nodeStaking.manager to match contracts.json structure
  nodeStakingManager: optionalAddr(contracts.nodeStaking?.manager),
  nodeStakingManagerV2: optionalAddr(
    contracts.nodeStaking?.managerV2 ?? contracts.nodeStaking?.manager,
  ),
  nodeStakingLegacyManagerV1: optionalAddr(
    contracts.nodeStaking?.legacyManagerV1 ?? contracts.nodeStaking?.manager,
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

export const BUNDLER_URL =
  typeof window !== 'undefined'
    ? `${window.location.origin}/bundler`
    : '/bundler'

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
