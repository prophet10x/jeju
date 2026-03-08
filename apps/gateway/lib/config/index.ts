/**
 * Gateway Frontend Configuration
 *
 * Uses @jejunetwork/config for all configuration.
 */

import {
  getBundlerUrl,
  getChainId,
  getConstant,
  getContractsConfig,
  getCurrentNetwork,
  getRpcUrl,
  getServicesConfig,
  getWsUrl,
  type NetworkType,
} from '@jejunetwork/config'
import { ZERO_ADDRESS } from '@jejunetwork/types'
import { type Address, getAddress } from 'viem'

// Network from config
export const NETWORK: NetworkType = getCurrentNetwork()

/**
 * Get services config for current network.
 * Must be called at runtime for correct network detection.
 */
export function getServices() {
  return getServicesConfig(getCurrentNetwork())
}

// Chain configuration - these are safe as constants since chainId detection
// uses hostname which is available synchronously
export const CHAIN_ID = getChainId(NETWORK)
export const RPC_URL = getRpcUrl(NETWORK)
export const WS_URL = getWsUrl(NETWORK)
export const BUNDLER_URL =
  typeof window !== 'undefined'
    ? new URL('/bundler', window.location.origin).toString()
    : getBundlerUrl(NETWORK)

// Service URLs from config
const services = getServicesConfig(NETWORK)

function requireServiceUrl(url: string | undefined, name: string): string {
  if (!url) throw new Error(`${name} URL not configured for network ${NETWORK}`)
  return url
}

export const OAUTH3_AGENT_URL = requireServiceUrl(
  services.oauth3?.api,
  'OAuth3',
)
export const DWS_API_URL = requireServiceUrl(services.dws.api, 'DWS API')
export const INDEXER_URL = requireServiceUrl(
  services.indexer.graphql,
  'Indexer GraphQL',
)
export const INDEXER_REST_URL = requireServiceUrl(
  services.indexer.rest,
  'Indexer REST',
)
export const INDEXER_A2A_URL = requireServiceUrl(
  services.gateway.a2a,
  'Indexer A2A',
)
export const INDEXER_MCP_URL = requireServiceUrl(
  services.gateway.mcp,
  'Indexer MCP',
)
export const RPC_GATEWAY_URL = requireServiceUrl(
  services.rpcGateway,
  'RPC Gateway',
)
export const IPFS_API_URL = requireServiceUrl(services.storage.api, 'IPFS API')
export const IPFS_GATEWAY_URL = requireServiceUrl(
  services.storage.ipfsGateway,
  'IPFS Gateway',
)
export const OIF_AGGREGATOR_URL = requireServiceUrl(
  services.oif.aggregator,
  'OIF Aggregator',
)
export const LEADERBOARD_API_URL = requireServiceUrl(
  services.leaderboard.api,
  'Leaderboard',
)
export const EXPLORER_URL = requireServiceUrl(services.explorer, 'Explorer')

// Contract addresses from config
const contracts = getContractsConfig(NETWORK)

/** Helper to get address - throws if not configured */
function _requireAddr(value: string | undefined, name: string): Address {
  if (!value) throw new Error(`Contract address not configured: ${name}`)
  return getAddress(value)
}

// Suppress unused variable warning - kept for future use
void _requireAddr

/** Helper to get optional address - returns ZERO_ADDRESS if not configured */
function optionalAddr(value: string | undefined): Address {
  if (!value) return ZERO_ADDRESS
  return getAddress(value)
}

export const CONTRACTS = {
  // Tokens - some may not be deployed on all networks
  jeju: optionalAddr(contracts.tokens?.jeju),
  usdc: optionalAddr(contracts.tokens?.usdc),
  weth: optionalAddr(contracts.tokens?.weth || getConstant('weth')),

  // Registry - some may not be deployed on all networks
  identityRegistry: optionalAddr(contracts.registry?.identity),
  tokenRegistry: optionalAddr(
    contracts.payments?.tokenRegistry || contracts.registry?.token,
  ),
  reputationRegistry: optionalAddr(contracts.registry?.reputation),
  validationRegistry: optionalAddr(contracts.registry?.validation),

  // Moderation (optional - may not be deployed on all networks)
  banManager: optionalAddr(contracts.moderation?.banManager),
  reportingSystem: optionalAddr(contracts.moderation?.reportingSystem),
  reputationLabelManager: optionalAddr(
    contracts.moderation?.reputationLabelManager,
  ),
  registryGovernance: optionalAddr(contracts.governance?.registryGovernance),

  // Bazaar (Prediction Markets) - optional
  predictionMarket: optionalAddr(contracts.bazaar?.predictionMarket),

  // Node Staking - optional (may not be deployed on all networks)
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
  nodePerformanceOracle: optionalAddr(contracts.nodeStaking?.performanceOracle),
  rpcStaking: optionalAddr(contracts.rpc?.staking),

  // JNS - optional
  jnsRegistry: optionalAddr(contracts.jns?.registry),
  jnsResolver: optionalAddr(contracts.jns?.resolver),
  jnsRegistrar: optionalAddr(contracts.jns?.registrar),
  jnsReverseRegistrar: optionalAddr(contracts.jns?.reverseRegistrar),

  // Payments - optional
  paymasterFactory: optionalAddr(contracts.payments?.paymasterFactory),
  liquidityPaymaster: optionalAddr(contracts.payments?.liquidityPaymaster),
  multiTokenPaymaster: optionalAddr(contracts.payments?.multiTokenPaymaster),
  priceOracle: optionalAddr(contracts.payments?.priceOracle),
  serviceRegistry: optionalAddr(contracts.payments?.serviceRegistry),
  creditManager: optionalAddr(contracts.payments?.creditManager),
  feeConfig: optionalAddr(contracts.payments?.feeConfig),
  entryPointDeployed: optionalAddr(
    contracts.accountAbstraction?.entryPointDeployed ||
      contracts.accountAbstraction?.entryPointV07 ||
      getConstant('entryPointV07'),
  ),
  entryPoint: optionalAddr(
    contracts.accountAbstraction?.entryPointDeployed ||
      contracts.accountAbstraction?.entryPointV07 ||
      getConstant('entryPointV07'),
  ),
  entryPointV07: optionalAddr(
    contracts.accountAbstraction?.entryPointDeployed ||
      contracts.accountAbstraction?.entryPointV07 ||
      getConstant('entryPointV07'),
  ),
  simpleAccountFactory: optionalAddr(
    contracts.accountAbstraction?.simpleAccountFactory,
  ),
  x402Facilitator: optionalAddr(contracts.payments?.x402Facilitator),

  // Compute - optional
  computeRegistry: optionalAddr(contracts.compute?.registry),
  ledgerManager: optionalAddr(contracts.compute?.ledgerManager),
  inferenceServing: optionalAddr(contracts.compute?.inferenceServing),
  computeStaking: optionalAddr(contracts.compute?.staking),

  // OIF - optional
  solverRegistry: optionalAddr(contracts.oif?.solverRegistry),
  inputSettler: {
    jeju: optionalAddr(contracts.oif?.inputSettler),
    ethereum: ZERO_ADDRESS,
    sepolia: ZERO_ADDRESS,
    arbitrum: ZERO_ADDRESS,
    optimism: ZERO_ADDRESS,
  },

  // EIL - optional
  crossChainPaymaster: optionalAddr(contracts.eil?.crossChainPaymaster),

  // GitHub Reputation - optional
  githubReputationProvider: optionalAddr(
    contracts.registry?.githubReputationProvider,
  ),

  // Oracle Network - optional
  oracleNetworkConnector: optionalAddr(
    contracts.oracle?.oracleNetworkConnector,
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
    CONTRACTS.nodeStakingManagerV2 !== undefined &&
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
          Boolean(address) &&
          address !== ZERO_ADDRESS &&
          address !== '0x0000000000000000000000000000000000000000',
      ),
    ),
  )
}

export function resolveNodeStakingWriteAddress(
  operatorAddress?: Address | string | null,
): Address {
  const router = CONTRACTS.nodeStakingRouter
  const v2 =
    CONTRACTS.nodeStakingManagerV2 !== undefined
      ? CONTRACTS.nodeStakingManagerV2
      : CONTRACTS.nodeStakingManager
  const v1 = CONTRACTS.nodeStakingManager
  const operator = operatorAddress?.toLowerCase() ?? null
  const hasRouter =
    router &&
    router !== ZERO_ADDRESS &&
    router !== '0x0000000000000000000000000000000000000000'
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
