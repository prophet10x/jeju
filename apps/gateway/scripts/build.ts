#!/usr/bin/env bun
/**
 * Gateway Production Build Script
 *
 * Builds frontend for production deployment with hashed filenames.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getCurrentNetwork } from '@jejunetwork/config'
import { reportBundleSizes } from '@jejunetwork/shared'
import type { BunPlugin } from 'bun'

const APP_DIR = resolve(import.meta.dir, '..')
const outdir = resolve(APP_DIR, 'dist')

async function build() {
  console.log('[Gateway] Building for production...')
  const startTime = Date.now()

  // Clean dist directory
  await rm(outdir, { recursive: true, force: true })
  mkdirSync(join(outdir, 'web'), { recursive: true })
  mkdirSync(join(outdir, 'api'), { recursive: true })

  const network = getCurrentNetwork()
  const appVersion =
    (
      JSON.parse(
        readFileSync(resolve(APP_DIR, 'package.json'), 'utf-8'),
      ) as { version?: string }
    ).version ?? '0.0.0'
  const envGitSha =
    process.env.VITE_GIT_SHA || process.env.GIT_SHA || process.env.COMMIT_SHA
  const gitShaResult = envGitSha
    ? null
    : Bun.spawnSync({
        cmd: ['git', 'rev-parse', '--short', 'HEAD'],
        cwd: resolve(APP_DIR, '../..'),
      })
  const gitSha = envGitSha
    ? envGitSha.trim() || 'unknown'
    : gitShaResult && gitShaResult.exitCode === 0
      ? gitShaResult.stdout.toString().trim() || 'unknown'
      : 'unknown'
  const testWalletEnv = {
    VITE_ENABLE_TEST_WALLET:
      process.env.VITE_ENABLE_TEST_WALLET === 'true' ? 'true' : 'false',
    VITE_TEST_WALLET_PRIVATE_KEY:
      process.env.VITE_TEST_WALLET_PRIVATE_KEY ?? '',
    VITE_TEST_WALLET_LABEL: process.env.VITE_TEST_WALLET_LABEL ?? '',
    VITE_TEST_WALLET_HOST_ALLOWLIST:
      process.env.VITE_TEST_WALLET_HOST_ALLOWLIST ?? '',
  }

  // Browser plugin for shimming and deduping
  const browserPlugin: BunPlugin = {
    name: 'browser-plugin',
    setup(build) {
      build.onResolve({ filter: /^node:crypto$/ }, () => ({
        path: resolve(APP_DIR, 'web/shims/node-crypto.ts'),
      }))
      build.onResolve({ filter: /^pino(-pretty)?$/ }, () => ({
        path: resolve(APP_DIR, 'web/shims/pino.ts'),
      }))
      // Shim server-only packages for browser
      build.onResolve({ filter: /^@jejunetwork\/cache$/ }, () => ({
        path: resolve(APP_DIR, 'web/shims/cache.ts'),
      }))
      const reactPath = require.resolve('react')
      const reactDomPath = require.resolve('react-dom')
      build.onResolve({ filter: /^react$/ }, () => ({ path: reactPath }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
        path: require.resolve('react/jsx-runtime'),
      }))
      build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({
        path: require.resolve('react/jsx-dev-runtime'),
      }))
      build.onResolve({ filter: /^react-dom$/ }, () => ({ path: reactDomPath }))
      build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
        path: require.resolve('react-dom/client'),
      }))
      build.onResolve({ filter: /^@noble\/curves\/secp256k1$/ }, () => ({
        path: require.resolve('@noble/curves/secp256k1'),
      }))
      build.onResolve({ filter: /^@noble\/curves\/p256$/ }, () => ({
        path: require.resolve('@noble/curves/p256'),
      }))
      build.onResolve({ filter: /^@noble\/curves$/ }, () => ({
        path: require.resolve('@noble/curves'),
      }))
      build.onResolve({ filter: /^@noble\/hashes/ }, (args) => {
        // Root has @noble/hashes v2 but most browser deps need v1
        // Always use v1 from ox's nested node_modules for compatibility
        const subpath = args.path.replace('@noble/hashes', '').replace(/^\//, '')
        const file = subpath ? (subpath.endsWith('.js') ? subpath : `${subpath}.js`) : 'index.js'
        return { path: resolve(APP_DIR, `../../node_modules/ox/node_modules/@noble/hashes/${file}`) }
      })
      build.onResolve({ filter: /^@jejunetwork\/shared$/ }, () => ({
        path: resolve(APP_DIR, '../../packages/shared/src/index.ts'),
      }))
      build.onResolve({ filter: /^@jejunetwork\/auth$/ }, () => ({
        path: resolve(APP_DIR, '../../packages/auth/src/index.ts'),
      }))
      build.onResolve({ filter: /^@jejunetwork\/auth\/react$/ }, () => ({
        path: resolve(APP_DIR, '../../packages/auth/src/react/index.ts'),
      }))
      build.onResolve({ filter: /^@jejunetwork\/types$/ }, () => ({
        path: resolve(APP_DIR, '../../packages/types/src/index.ts'),
      }))
      build.onResolve({ filter: /^@jejunetwork\/sdk$/ }, () => ({
        path: resolve(APP_DIR, '../../packages/sdk/src/index.ts'),
      }))
      build.onResolve({ filter: /^@jejunetwork\/ui$/ }, () => ({
        path: resolve(APP_DIR, '../../packages/ui/src/index.ts'),
      }))
      build.onResolve({ filter: /^@jejunetwork\/config$/ }, () => ({
        path: resolve(APP_DIR, '../../packages/config/index.ts'),
      }))
      build.onResolve({ filter: /^@jejunetwork\/token$/ }, () => ({
        path: resolve(APP_DIR, '../../packages/token/src/index.ts'),
      }))
    },
  }

  // Build frontend
  console.log('[Gateway] Building frontend...')
  const frontendResult = await Bun.build({
    entrypoints: [resolve(APP_DIR, 'web/main.tsx')],
    outdir: join(outdir, 'web'),
    target: 'browser',
    minify: true,
    sourcemap: 'external',
    splitting: false,
    packages: 'bundle',
    plugins: [browserPlugin],
    naming: '[name].[hash].[ext]',
    drop: ['debugger'],
    external: [
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
      '@jejunetwork/db',
      '@jejunetwork/dws',
      '@jejunetwork/kms',
      '@jejunetwork/deployment',
      '@jejunetwork/training',
      'elysia',
      '@elysiajs/*',
      'ioredis',
      'croner',
      'opossum',
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
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.browser': 'true',
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
      'globalThis.process': JSON.stringify({
        env: {
          NODE_ENV: 'production',
          JEJU_NETWORK: network,
          VITE_APP_VERSION: appVersion,
          VITE_GIT_SHA: gitSha,
          ...testWalletEnv,
        },
        browser: true,
      }),
      process: JSON.stringify({
        env: {
          NODE_ENV: 'production',
          JEJU_NETWORK: network,
          VITE_APP_VERSION: appVersion,
          VITE_GIT_SHA: gitSha,
          ...testWalletEnv,
        },
        browser: true,
      }),
      'import.meta.env.VITE_NETWORK': JSON.stringify(network),
      'import.meta.env': JSON.stringify({
        VITE_NETWORK: network,
        VITE_APP_VERSION: appVersion,
        VITE_GIT_SHA: gitSha,
        PUBLIC_NETWORK: network,
        ...testWalletEnv,
        MODE: 'production',
        DEV: false,
        PROD: true,
      }),
      'import.meta.env.PUBLIC_NETWORK': JSON.stringify(network),
    },
  })

  if (!frontendResult.success) {
    console.error('[Gateway] Frontend build failed:')
    for (const log of frontendResult.logs) {
      console.error(log)
    }
    process.exit(1)
  }
  reportBundleSizes(frontendResult, 'Gateway Frontend')
  console.log('[Gateway] Frontend built successfully')

  // Build standalone API servers (used in dev mode)
  console.log('[Gateway] Building API servers...')
  const apiFiles = ['rpc-server.ts', 'x402-server.ts']
  for (const apiFile of apiFiles) {
    const result = await Bun.build({
      entrypoints: [resolve(APP_DIR, `api/${apiFile}`)],
      outdir: join(outdir, 'api'),
      target: 'bun',
      minify: true,
      sourcemap: 'external',
      drop: ['debugger'],
    })
    if (!result.success) {
      console.warn(`[Gateway] Warning: ${apiFile} build failed`)
    }
  }
  console.log('[Gateway] API servers built')

  // Build worker for workerd deployment
  // Uses worker-entry.ts which exports the handler as default (required for workerd)
  console.log('[Gateway] Building worker for DWS deployment...')
  mkdirSync(join(outdir, 'worker'), { recursive: true })
  const workerResult = await Bun.build({
    entrypoints: [resolve(APP_DIR, 'api/worker-entry.ts')],
    outdir: join(outdir, 'worker'),
    target: 'bun',
    minify: true,
    sourcemap: 'external',
    drop: ['debugger'],
    external: [
      'bun:sqlite',
      'child_process',
      'node:child_process',
      'node:fs',
      'node:path',
      'node:crypto',
    ],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })

  if (!workerResult.success) {
    console.error('[Gateway] Worker build failed:')
    for (const log of workerResult.logs) console.error(log)
    throw new Error('Worker build failed')
  }

  reportBundleSizes(workerResult, 'Gateway Worker')

  // Write worker metadata
  const metadata = {
    name: 'gateway-api',
    version: '1.0.0',
    entrypoint: 'worker.js',
    compatibilityDate: '2024-01-01',
    buildTime: new Date().toISOString(),
    runtime: 'workerd',
  }
  writeFileSync(
    join(outdir, 'worker', 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  )
  console.log('[Gateway] Worker built successfully')

  // Find the main entry file with hash
  const mainEntry = frontendResult.outputs.find(
    (o) => o.kind === 'entry-point' && o.path.includes('main'),
  )
  const mainFileName = mainEntry ? mainEntry.path.split('/').pop() : 'main.js'

  const cssEntry = frontendResult.outputs.find((o) => o.path.endsWith('.css'))
  const cssFileName = cssEntry ? cssEntry.path.split('/').pop() : null

  const indexHtml = readFileSync(resolve(APP_DIR, 'index.html'), 'utf-8')
  const basePath = '/gateway'
  let updatedHtml = indexHtml.replace('/web/main.tsx', `${basePath}/web/${mainFileName}`)

  if (cssFileName) {
    updatedHtml = updatedHtml.replace(
      '</head>',
      `  <link rel="stylesheet" href="${basePath}/web/${cssFileName}">\n  </head>`,
    )
  }

  writeFileSync(join(outdir, 'index.html'), updatedHtml)

  cpSync(resolve(APP_DIR, 'public'), outdir, { recursive: true })

  const duration = Date.now() - startTime
  console.log('')
  console.log(`[Gateway] Build complete in ${duration}ms`)
  console.log('[Gateway] Output:')
  console.log(`  dist/web/${mainFileName} - Frontend bundle`)
  console.log('  dist/api/                - API servers')
  console.log('  dist/index.html          - Entry HTML')
  process.exit(0)
}

build().catch((err) => {
  console.error('[Gateway] Build error:', err)
  process.exit(1)
})
