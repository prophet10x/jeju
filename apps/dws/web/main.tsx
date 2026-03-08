/**
 * DWS Console - Decentralized Web Services
 *
 * Uses only injected wallets (MetaMask, etc.) without WalletConnect
 * or other centralized dependencies.
 */

import { OAuth3Provider } from '@jejunetwork/auth'
import type { OAuth3AppConfig } from '@jejunetwork/shared'
import { createDecentralizedWagmiConfig } from '@jejunetwork/ui/wallet'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import App from './App'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { OnboardingModal } from './components/OnboardingModal'
import { ToastContainer } from './components/ToastContainer'
import { CHAIN_ID, NETWORK, OAUTH3_AGENT_URL, RPC_URL } from './config'
import { AppProvider } from './context/AppContext'
import './styles/index.css'

function getDwsRouterBasename(): string {
  if (typeof window === 'undefined') return ''
  return window.location.pathname === '/dws' ||
    window.location.pathname.startsWith('/dws/')
    ? '/dws'
    : ''
}

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
  appName: 'DWS Console',
  testWallet: {
    enabled: import.meta.env.VITE_ENABLE_TEST_WALLET === 'true',
    privateKey: import.meta.env.VITE_TEST_WALLET_PRIVATE_KEY,
    label: import.meta.env.VITE_TEST_WALLET_LABEL,
    hostAllowlist: testWalletAllowlist,
  },
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
})

const routerBasename = getDwsRouterBasename()
const authCallbackPath = routerBasename
  ? `${routerBasename}/auth/callback`
  : '/auth/callback'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <WagmiProvider config={config}>
          <QueryClientProvider client={queryClient}>
            <OAuth3Provider
              config={
                {
                  appId: 'dws.apps.jeju',
                  redirectUri: `${typeof window !== 'undefined' ? window.location.origin : ''}${authCallbackPath}`,
                  chainId: CHAIN_ID,
                  rpcUrl: RPC_URL,
                  teeAgentUrl: OAUTH3_AGENT_URL,
                  network: NETWORK,
                  // Disable decentralized discovery until JNS app names are registered
                  decentralized: false,
                } satisfies OAuth3AppConfig
              }
              autoConnect={true}
            >
              <AppProvider>
                <BrowserRouter basename={routerBasename || undefined}>
                  <App />
                  <OnboardingModal />
                  <ToastContainer />
                  <ConfirmDialog />
                </BrowserRouter>
              </AppProvider>
            </OAuth3Provider>
          </QueryClientProvider>
        </WagmiProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}
