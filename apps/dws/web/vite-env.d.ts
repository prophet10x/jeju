/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_TEST_WALLET?: string
  readonly VITE_TEST_WALLET_PRIVATE_KEY?: string
  readonly VITE_TEST_WALLET_LABEL?: string
  readonly VITE_TEST_WALLET_HOST_ALLOWLIST?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
