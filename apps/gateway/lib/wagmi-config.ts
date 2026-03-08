/**
 * Decentralized wagmi configuration
 *
 * Uses only injected wallets (MetaMask, etc.) without WalletConnect
 * or other centralized dependencies.
 */

import { createDecentralizedWagmiConfig } from '@jejunetwork/ui'
import { CHAIN_ID, NETWORK, RPC_URL } from './config'

const jejuChain = {
  id: CHAIN_ID,
  name:
    NETWORK === 'mainnet'
      ? 'Jeju Network'
      : NETWORK === 'testnet'
        ? 'Jeju Testnet'
        : 'Jeju Localnet',
  rpcUrl: RPC_URL,
  testnet: NETWORK !== 'mainnet',
}

const testWalletAllowlist = (
  import.meta.env.VITE_TEST_WALLET_HOST_ALLOWLIST ?? ''
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

// Create decentralized config - no WalletConnect, no external dependencies
const config = createDecentralizedWagmiConfig({
  chains: [jejuChain],
  appName: 'Gateway',
  testWallet: {
    enabled: import.meta.env.VITE_ENABLE_TEST_WALLET === 'true',
    privateKey: import.meta.env.VITE_TEST_WALLET_PRIVATE_KEY,
    label: import.meta.env.VITE_TEST_WALLET_LABEL,
    hostAllowlist: testWalletAllowlist,
  },
})

export function getConfig() {
  return config
}

export { jejuChain, config }
