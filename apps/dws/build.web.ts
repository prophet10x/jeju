import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { reportBundleSizes } from '@jejunetwork/shared'
import type { BunPlugin } from 'bun'

const outdir = './dist'
mkdirSync(outdir, { recursive: true })
const appVersion =
  (JSON.parse(readFileSync('./package.json', 'utf-8')) as { version?: string })
    .version ?? '0.0.0'
const envGitSha =
  process.env.VITE_GIT_SHA || process.env.GIT_SHA || process.env.COMMIT_SHA
const gitShaResult = envGitSha
  ? null
  : Bun.spawnSync({
      cmd: ['git', 'rev-parse', '--short', 'HEAD'],
      cwd: resolve('../../'),
    })
const gitSha = envGitSha
  ? envGitSha.trim() || 'unknown'
  : gitShaResult && gitShaResult.exitCode === 0
    ? gitShaResult.stdout.toString().trim() || 'unknown'
    : 'unknown'
const testWalletEnv = {
  VITE_ENABLE_TEST_WALLET:
    process.env.VITE_ENABLE_TEST_WALLET === 'true' ? 'true' : 'false',
  VITE_TEST_WALLET_PRIVATE_KEY: process.env.VITE_TEST_WALLET_PRIVATE_KEY ?? '',
  VITE_TEST_WALLET_LABEL: process.env.VITE_TEST_WALLET_LABEL ?? '',
  VITE_TEST_WALLET_HOST_ALLOWLIST:
    process.env.VITE_TEST_WALLET_HOST_ALLOWLIST ?? '',
}

// Plugin to replace server-only modules with browser shims and dedupe React
const browserShimPlugin: BunPlugin = {
  name: 'browser-shims',
  setup(build) {
    // Shim pino and pino-pretty
    build.onResolve({ filter: /^pino(-pretty)?$/ }, () => ({
      path: resolve('./web/shims/pino.ts'),
    }))

    // Resolve workspace packages to their source for proper bundling
    build.onResolve({ filter: /^@jejunetwork\/oauth3$/ }, () => ({
      path: resolve('../../packages/auth/src/index.ts'),
    }))
    build.onResolve({ filter: /^@jejunetwork\/auth$/ }, () => ({
      path: resolve('../../packages/auth/src/index.ts'),
    }))
    build.onResolve({ filter: /^@jejunetwork\/auth\/react$/ }, () => ({
      path: resolve('../../packages/auth/src/react/index.ts'),
    }))
    build.onResolve({ filter: /^@jejunetwork\/shared$/ }, () => ({
      path: resolve('../../packages/shared/src/index.ts'),
    }))
    build.onResolve({ filter: /^@jejunetwork\/types$/ }, () => ({
      path: resolve('../../packages/types/src/index.ts'),
    }))
    build.onResolve({ filter: /^@jejunetwork\/sdk$/ }, () => ({
      path: resolve('../../packages/sdk/src/index.ts'),
    }))
    build.onResolve({ filter: /^@jejunetwork\/ui$/ }, () => ({
      path: resolve('../../packages/ui/src/index.ts'),
    }))
    build.onResolve({ filter: /^@jejunetwork\/ui\/wallet$/ }, () => ({
      path: resolve('../../packages/ui/src/wallet/index.ts'),
    }))
    build.onResolve(
      { filter: /^@jejunetwork\/ui\/hooks\/useNodeStaking$/ },
      () => ({
        path: resolve('../../packages/ui/src/hooks/useNodeStaking.ts'),
      }),
    )
    build.onResolve({ filter: /^@jejunetwork\/config$/ }, () => ({
      path: resolve('../../packages/config/index.ts'),
    }))
    build.onResolve({ filter: /^@jejunetwork\/token$/ }, () => ({
      path: resolve('../../packages/token/src/index.ts'),
    }))

    // Dedupe React - ensure all React imports resolve to the same package
    const reactPath = require.resolve('react')
    const reactDomPath = require.resolve('react-dom')
    const wagmiPath = require.resolve('wagmi')
    const viemPath = require.resolve('viem')

    build.onResolve({ filter: /^react$/ }, () => ({
      path: reactPath,
    }))
    build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
      path: require.resolve('react/jsx-runtime'),
    }))
    build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({
      path: require.resolve('react/jsx-dev-runtime'),
    }))
    build.onResolve({ filter: /^react-dom$/ }, () => ({
      path: reactDomPath,
    }))
    build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
      path: require.resolve('react-dom/client'),
    }))

    // Dedupe wagmi and viem to prevent context issues
    build.onResolve({ filter: /^wagmi$/ }, () => ({
      path: wagmiPath,
    }))
    build.onResolve({ filter: /^wagmi\/connectors$/ }, () => ({
      path: require.resolve('wagmi/connectors'),
    }))
    build.onResolve({ filter: /^viem$/ }, () => ({
      path: viemPath,
    }))
  },
}

const result = await Bun.build({
  entrypoints: ['./web/main.tsx'],
  outdir: join(outdir, 'web'),
  target: 'browser',
  minify: true,
  sourcemap: 'external',
  splitting: false,
  packages: 'bundle',
  plugins: [browserShimPlugin],
  naming: '[name].[hash].[ext]',
  drop: ['debugger'],
  external: [
    // Node-only modules
    '@google-cloud/*',
    '@grpc/*',
    'google-gax',
    'google-auth-library',
    'native-dns',
    'native-dns-cache',
    '@farcaster/hub-nodejs',
    '@opentelemetry/*',
    'bun:sqlite',
    'node:*',
    'typeorm',
    // Server-only Jeju packages
    '@jejunetwork/db',
    '@jejunetwork/dws',
    '@jejunetwork/deployment',
    '@jejunetwork/training',
    // Server frameworks
    'elysia',
    '@elysiajs/*',
    // Server dependencies
    'ioredis',
    'croner',
    'cockatiel',
    'ws',
    'generic-pool',
    'c-kzg',
    'kzg-wasm',
    '@aws-sdk/*',
    '@huggingface/*',
    '@solana/*',
    'borsh',
    'tweetnacl',
    'p-retry',
    'yaml',
    'prom-client',
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'development',
    ),
    'process.env.JEJU_NETWORK': JSON.stringify(
      process.env.NETWORK || process.env.JEJU_NETWORK || 'testnet',
    ),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    'import.meta.env.VITE_GIT_SHA': JSON.stringify(gitSha),
    'import.meta.env.VITE_ENABLE_TEST_WALLET': JSON.stringify(
      testWalletEnv.VITE_ENABLE_TEST_WALLET,
    ),
    'import.meta.env.VITE_TEST_WALLET_PRIVATE_KEY': JSON.stringify(
      testWalletEnv.VITE_TEST_WALLET_PRIVATE_KEY,
    ),
    'import.meta.env.VITE_TEST_WALLET_LABEL': JSON.stringify(
      testWalletEnv.VITE_TEST_WALLET_LABEL,
    ),
    'import.meta.env.VITE_TEST_WALLET_HOST_ALLOWLIST': JSON.stringify(
      testWalletEnv.VITE_TEST_WALLET_HOST_ALLOWLIST,
    ),
    'process.browser': 'true',
    // Provide a minimal process shim for browser - process.env access defaults to undefined
    process: JSON.stringify({
      env: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        JEJU_NETWORK:
          process.env.NETWORK || process.env.JEJU_NETWORK || 'testnet',
        VITE_APP_VERSION: appVersion,
        VITE_GIT_SHA: gitSha,
        ...testWalletEnv,
      },
      browser: true,
    }),
    'import.meta.env': JSON.stringify({
      MODE: process.env.NODE_ENV || 'development',
      DEV: (process.env.NODE_ENV || 'development') !== 'production',
      PROD: (process.env.NODE_ENV || 'development') === 'production',
      VITE_APP_VERSION: appVersion,
      VITE_GIT_SHA: gitSha,
      VITE_NETWORK: process.env.NETWORK || process.env.JEJU_NETWORK || 'testnet',
      ...testWalletEnv,
    }),
  },
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

reportBundleSizes(result, 'DWS Frontend')

// Find the main entry file with hash
const mainEntry = result.outputs.find(
  (o) => o.kind === 'entry-point' && o.path.includes('main'),
)
const mainFileName = mainEntry ? mainEntry.path.split('/').pop() : 'main.js'

// Find the CSS file
const cssFile = result.outputs.find((o) => o.path.endsWith('.css'))
const cssFileName = cssFile ? cssFile.path.split('/').pop() : null

let indexHtml = readFileSync('./index.html', 'utf-8')
// Remove the development CSS reference
indexHtml = indexHtml.replace('<link rel="stylesheet" href="/index.css">', '')
indexHtml = indexHtml.replace('/web/main.tsx', `/web/${mainFileName}`)
// Add CSS link if CSS was generated
if (cssFileName) {
  indexHtml = indexHtml.replace(
    '</head>',
    `  <link rel="stylesheet" href="/web/${cssFileName}">\n</head>`,
  )
}
writeFileSync(join(outdir, 'index.html'), indexHtml)

console.log('Build succeeded.')
process.exit(0)
