/**
 * DWS Web Frontend Configuration
 *
 * Uses @jejunetwork/config for all configuration.
 */

import {
  getChainId,
  getContractsConfig,
  getCurrentNetwork,
  getDWSUrl,
  getOAuth3Url,
  getRpcUrl,
  type NetworkType,
} from '@jejunetwork/config'
import { ZERO_ADDRESS } from '@jejunetwork/types'
import type { Address } from 'viem'

// Network from config
export const NETWORK: NetworkType = getCurrentNetwork()

// Chain configuration from config
export const CHAIN_ID = getChainId(NETWORK)
// Use DWS RPC proxy to avoid CORS issues with direct RPC calls
export const RPC_URL =
  typeof window !== 'undefined'
    ? `${window.location.origin}/rpc/proxy?chainId=${getChainId(NETWORK)}`
    : getRpcUrl(NETWORK)
// DWS frontend is always served from the DWS API server itself,
// so use relative paths instead of absolute URLs from services.json.
// This works regardless of domain/IP (e.g., 52.206.203.24, dws.testnet.jejunetwork.org, localhost).
export const DWS_API_URL = ''
// OAuth3 is served by DWS itself at /oauth3/*, so use relative path
export const OAUTH3_AGENT_URL = ''

// Contract addresses from config
const contracts = getContractsConfig(NETWORK)

export const CONTRACTS = {
  identityRegistry: (contracts.registry.identity as Address) || ZERO_ADDRESS,
  banManager: (contracts.moderation.banManager as Address) || ZERO_ADDRESS,
  moderationMarketplace:
    (contracts.moderation.moderationMarketplace as Address) || ZERO_ADDRESS,
  reportingSystem:
    (contracts.moderation.reportingSystem as Address) || ZERO_ADDRESS,
  computeRegistry: (contracts.compute.registry as Address) || ZERO_ADDRESS,
  jnsRegistry: (contracts.jns.registry as Address) || ZERO_ADDRESS,
  jnsResolver: (contracts.jns.resolver as Address) || ZERO_ADDRESS,
  x402Facilitator:
    (contracts.payments.x402Facilitator as Address) || ZERO_ADDRESS,
  // Use nodeStaking.manager to match contracts.json structure
  nodeStakingManager:
    (contracts.nodeStaking?.manager as Address) || ZERO_ADDRESS,
} as const

// Token addresses from config
export const TOKENS = {
  jeju: (contracts.tokens?.jeju as Address) || ZERO_ADDRESS,
  usdc: (contracts.tokens?.usdc as Address) || ZERO_ADDRESS,
  weth: (contracts.tokens?.weth as Address) || ZERO_ADDRESS,
} as const

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
