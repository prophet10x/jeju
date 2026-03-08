/**
 * Decentralized-first wagmi configuration
 *
 * This config uses ONLY injected wallets (MetaMask, etc.) without any
 * centralized dependencies like WalletConnect or external project IDs.
 *
 * For apps that need wallet connection without centralized dependencies,
 * use this instead of RainbowKit's getDefaultConfig.
 */

import { getL2RpcUrl } from '@jejunetwork/config'
import type { Chain, Hex } from 'viem'
import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { createTestWalletProvider } from './testWalletProvider'

export interface ChainConfig {
  id: number
  name: string
  rpcUrl: string
  nativeCurrency?: {
    name: string
    symbol: string
    decimals: number
  }
  blockExplorers?: {
    default: { name: string; url: string }
  }
  testnet?: boolean
}

export interface CreateWagmiConfigOptions {
  chains: ChainConfig[]
  appName?: string
  testWallet?: TestWalletConfig
}

export interface TestWalletConfig {
  enabled?: boolean
  privateKey?: string
  label?: string
  hostAllowlist?: string[]
}

const TEST_WALLET_DEFAULT_LABEL = 'Jeju Test Wallet'

function normalizePrivateKey(value?: string): Hex | null {
  if (!value) return null
  const normalized = value.startsWith('0x') ? value : `0x${value}`
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) return null
  return normalized as Hex
}

function normalizeHostAllowlist(hostAllowlist?: string[]): string[] {
  return (hostAllowlist ?? [])
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function isHostAllowlisted(currentHost: string, allowlist: string[]): boolean {
  const normalizedHost = currentHost.trim().toLowerCase()
  return allowlist.some((entry) => {
    if (entry === '*') return true
    if (normalizedHost === entry) return true
    return normalizedHost.endsWith(`.${entry}`)
  })
}

function createTestWalletConnector(
  testWallet: TestWalletConfig | undefined,
  chains: readonly Chain[],
) {
  if (!testWallet?.enabled) return null

  const privateKey = normalizePrivateKey(testWallet.privateKey)
  if (!privateKey) {
    throw new Error(
      'VITE_TEST_WALLET_PRIVATE_KEY must be a 32-byte hex private key when VITE_ENABLE_TEST_WALLET=true.',
    )
  }

  const hostAllowlist = normalizeHostAllowlist(testWallet.hostAllowlist)
  if (hostAllowlist.length === 0) {
    throw new Error(
      'VITE_ENABLE_TEST_WALLET=true requires an explicit host allowlist (for example VITE_TEST_WALLET_HOST_ALLOWLIST=localhost,127.0.0.1).',
    )
  }

  if (typeof window !== 'undefined') {
    const currentHost = window.location.hostname
    if (!isHostAllowlisted(currentHost, hostAllowlist)) {
      throw new Error(
        `Test wallet refused to boot on host "${currentHost}". Allowed hosts: ${hostAllowlist.join(', ')}`,
      )
    }
  }

  const provider = createTestWalletProvider({
    chains,
    privateKey,
  })

  return injected({
    shimDisconnect: true,
    target: {
      id: 'jeju-test-wallet',
      name: testWallet.label ?? TEST_WALLET_DEFAULT_LABEL,
      provider: () => provider,
    },
  })
}

/**
 * Creates a wagmi config with only injected wallet support
 * No WalletConnect, no centralized dependencies
 */
export function createDecentralizedWagmiConfig({
  chains,
  testWallet,
}: CreateWagmiConfigOptions) {
  if (chains.length === 0) {
    throw new Error('At least one chain config is required')
  }

  // Convert chain configs to wagmi chain format
  const wagmiChains = chains.map((chain) => ({
    id: chain.id,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency ?? {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: { http: [chain.rpcUrl] },
      public: { http: [chain.rpcUrl] },
    },
    blockExplorers: chain.blockExplorers,
    testnet: chain.testnet,
  }))

  // Build transports map
  const transports: Record<number, ReturnType<typeof http>> = {}
  for (const chain of chains) {
    transports[chain.id] = http(chain.rpcUrl)
  }

  const typedChains = wagmiChains as [Chain, ...Chain[]]
  const connectors = [
    injected({
      shimDisconnect: true,
    }),
  ]
  const testWalletConnector = createTestWalletConnector(testWallet, typedChains)
  if (testWalletConnector) {
    connectors.unshift(testWalletConnector)
  }

  return createConfig({
    chains: typedChains,
    connectors,
    transports,
    ssr: false,
  })
}

/**
 * Default Jeju chain configurations
 */
export const JEJU_CHAINS = {
  localnet: {
    id: 31337,
    name: 'Jeju Localnet',
    rpcUrl: getL2RpcUrl(),
    testnet: true,
  },
  testnet: {
    id: 8004,
    name: 'Jeju Testnet',
    rpcUrl: 'https://testnet-rpc.jejunetwork.io',
    blockExplorers: {
      default: {
        name: 'Explorer',
        url: 'https://testnet-explorer.jejunetwork.io',
      },
    },
    testnet: true,
  },
  mainnet: {
    id: 8004,
    name: 'Jeju Network',
    rpcUrl: 'https://rpc.jejunetwork.io',
    blockExplorers: {
      default: { name: 'Explorer', url: 'https://explorer.jejunetwork.io' },
    },
    testnet: false,
  },
} as const satisfies Record<string, ChainConfig>

/**
 * Ethereum mainnet for ENS resolution (optional, can be excluded for fully decentralized setup)
 */
export const ETHEREUM_MAINNET: ChainConfig = {
  id: 1,
  name: 'Ethereum',
  rpcUrl: 'https://eth.merkle.io',
  testnet: false,
}
