import { type Address, getAddress, zeroAddress } from 'viem'
import { getContractsConfig, getCurrentNetwork } from '@jejunetwork/config'

const ZERO_ADDRESS: Address = zeroAddress

/** Helper to safely get address from config, returns ZERO_ADDRESS if not set */
function configAddr(value: string | undefined): Address {
  if (!value) return ZERO_ADDRESS
  return getAddress(value)
}

// Load contract addresses from centralized config (contracts.json)
const contracts = getContractsConfig(getCurrentNetwork())

// Export individual addresses sourced from centralized config
export const JEJU_TOKEN_ADDRESS = configAddr(contracts.tokens?.jeju)
export const IDENTITY_REGISTRY_ADDRESS = configAddr(contracts.registry?.identity)
export const BAN_MANAGER_ADDRESS = configAddr(contracts.moderation?.banManager)
export const MODERATION_MARKETPLACE_ADDRESS = configAddr(contracts.moderation?.moderationMarketplace)
export const REPORTING_SYSTEM_ADDRESS = configAddr(contracts.moderation?.reportingSystem)
export const REPUTATION_LABEL_MANAGER_ADDRESS = configAddr(contracts.moderation?.reputationLabelManager)
export const INPUT_SETTLER_ADDRESS = configAddr(contracts.oif?.inputSettler)
export const OUTPUT_SETTLER_ADDRESS = configAddr(contracts.oif?.outputSettler)
export const SOLVER_REGISTRY_ADDRESS = configAddr(contracts.oif?.solverRegistry)
export const OIF_ORACLE_ADDRESS = configAddr(contracts.oif?.oifOracle)
export const XLP_ROUTER_ADDRESS = configAddr(contracts.defi?.swapRouter)
export const LIQUIDITY_AGGREGATOR_ADDRESS = configAddr(contracts.liquidity?.liquidityRouter)

export interface TokenConfig {
  symbol: string
  name: string
  address: Address
  decimals: number
  priceUSD: number
  logoUrl: string
  hasPaymaster: boolean
  bridged: boolean
  originChain: 'jeju' | 'ethereum' | 'base'
  l1Address?: Address
  hasBanEnforcement?: boolean
  isPreferred?: boolean
}

const TOKENS: TokenConfig[] = [
  {
    symbol: 'JEJU',
    name: 'Network',
    address: JEJU_TOKEN_ADDRESS,
    decimals: 18,
    priceUSD: 1.0,
    logoUrl: 'https://assets.jejunetwork.org/jeju-logo.png',
    hasPaymaster: true,
    bridged: false,
    originChain: 'jeju',
    isPreferred: true,
    hasBanEnforcement: true,
  },
]

export function getTokenConfigs(): TokenConfig[] {
  return TOKENS
}

export function getTokenBySymbol(symbol: string): TokenConfig | undefined {
  return getTokenConfigs().find(
    (t) => t.symbol.toLowerCase() === symbol.toLowerCase(),
  )
}

export function getTokenByAddress(address: string): TokenConfig | undefined {
  return getTokenConfigs().find(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  )
}
