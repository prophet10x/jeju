#!/usr/bin/env bun

/**
 * Contract Verification Script
 *
 * Reads contracts.json and verifies every configured address has bytecode on-chain.
 * Detects stale gateway builds by checking if contract addresses in the JS bundle
 * match the current contracts.json.
 *
 * Usage:
 *   bun run packages/deployment/scripts/verify-contracts.ts [--network testnet|localnet] [--gateway-check]
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http, type Address } from 'viem'

const ROOT_DIR = join(import.meta.dir, '../../..')

// --- Parse args ---

const args = process.argv.slice(2)
const networkArg = args.includes('--network')
  ? args[args.indexOf('--network') + 1]
  : 'testnet'
const gatewayCheck = args.includes('--gateway-check')

// --- Load contracts.json ---

const contractsPath = join(ROOT_DIR, 'packages/config/contracts.json')
if (!existsSync(contractsPath)) {
  console.error(`contracts.json not found at ${contractsPath}`)
  process.exit(1)
}

const allContracts = JSON.parse(readFileSync(contractsPath, 'utf-8'))
const networkConfig = allContracts[networkArg]

if (!networkConfig) {
  console.error(`Network "${networkArg}" not found in contracts.json`)
  console.error(`Available: ${Object.keys(allContracts).filter(k => k !== 'version' && k !== 'lastUpdated' && k !== 'description' && k !== 'constants').join(', ')}`)
  process.exit(1)
}

const chainId = networkConfig.chainId

// --- Determine RPC URL ---

const RPC_URLS: Record<string, string> = {
  testnet: 'https://jeju-testnet.fartbag.fun/',
  localnet: 'http://localhost:6546',
}

const rpcUrl = process.env.RPC_URL || RPC_URLS[networkArg]
if (!rpcUrl) {
  console.error(`No RPC URL for network "${networkArg}". Set RPC_URL env var.`)
  process.exit(1)
}

// --- Flatten contract addresses ---

interface ContractEntry {
  path: string  // e.g. "tokens.jeju"
  address: string
}

function flattenContracts(obj: Record<string, unknown>, prefix = ''): ContractEntry[] {
  const entries: ContractEntry[] = []
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'chainId') continue
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      entries.push({ path, address: value })
    } else if (typeof value === 'object' && value !== null) {
      entries.push(...flattenContracts(value as Record<string, unknown>, path))
    }
  }
  return entries
}

const allEntries = flattenContracts(networkConfig)

// Filter: configured = non-empty address that looks like 0x...
const configured = allEntries.filter(e => e.address && e.address.startsWith('0x') && e.address.length === 42)
const unconfigured = allEntries.filter(e => !e.address || e.address === '')
// Skip predeploys (0x4200...) — these always exist
const PREDEPLOY_PREFIX = '0x4200000000000000000000000000000000'
const toCheck = configured.filter(e => !e.address.startsWith(PREDEPLOY_PREFIX))
const predeploys = configured.filter(e => e.address.startsWith(PREDEPLOY_PREFIX))

// --- On-chain verification ---

console.log(`Verifying ${configured.length} contracts on ${networkArg} (chain ${chainId})...`)
console.log(`RPC: ${rpcUrl}`)
console.log('')

const client = createPublicClient({
  transport: http(rpcUrl),
})

let deployed = 0
let missing = 0
let skipped = unconfigured.length

// Check predeploys first (just mark them as deployed)
for (const entry of predeploys) {
  console.log(`\x1b[90m- ${entry.path.padEnd(40)} ${entry.address.slice(0, 12)}... predeploy (skipped)\x1b[0m`)
  deployed++
}

// Check each contract on-chain
for (const entry of toCheck) {
  try {
    const code = await client.getCode({ address: entry.address as Address })
    const hasCode = code && code !== '0x' && code.length > 2

    if (hasCode) {
      console.log(`\x1b[32m✓ ${entry.path.padEnd(40)} ${entry.address.slice(0, 12)}... has code\x1b[0m`)
      deployed++
    } else {
      console.log(`\x1b[31m✗ ${entry.path.padEnd(40)} ${entry.address.slice(0, 12)}... NO CODE ← ERROR\x1b[0m`)
      missing++
    }
  } catch (err) {
    console.log(`\x1b[31m✗ ${entry.path.padEnd(40)} ${entry.address.slice(0, 12)}... RPC ERROR: ${(err as Error).message.slice(0, 60)}\x1b[0m`)
    missing++
  }
}

// Show unconfigured (first 10, then summarize)
const showUnconfigured = unconfigured.slice(0, 5)
for (const entry of showUnconfigured) {
  console.log(`\x1b[90m- ${entry.path.padEnd(40)} (not configured)\x1b[0m`)
}
if (unconfigured.length > 5) {
  console.log(`\x1b[90m  ... and ${unconfigured.length - 5} more not configured\x1b[0m`)
}

console.log('')
const resultColor = missing > 0 ? '\x1b[31m' : '\x1b[32m'
console.log(`${resultColor}Result: ${deployed} deployed, ${skipped} not configured, ${missing} MISSING CODE\x1b[0m`)

// --- Gateway staleness check ---

if (gatewayCheck) {
  console.log('')
  console.log('Checking gateway build staleness...')

  const gatewayDistDir = join(ROOT_DIR, 'apps/gateway/dist')
  if (!existsSync(gatewayDistDir)) {
    console.log('\x1b[33mNo gateway build found at apps/gateway/dist\x1b[0m')
  } else {
    // Read all JS files in dist
    const { globSync } = await import('node:fs')
    let bundleContent = ''

    // Use Bun.Glob for finding JS files
    const glob = new Bun.Glob('**/*.js')
    for (const file of glob.scanSync(gatewayDistDir)) {
      bundleContent += readFileSync(join(gatewayDistDir, file), 'utf-8')
    }

    if (!bundleContent) {
      console.log('\x1b[33mNo JS files found in gateway dist\x1b[0m')
    } else {
      // Check key contract addresses (ones the gateway actually uses)
      // Focus on addresses that appear in the UI/SDK interactions
      const keyContracts = configured.filter(e => {
        // Check contracts the gateway is likely to reference
        const important = [
          'tokens.jeju', 'tokens.usdc',
          'registry.identity', 'registry.reputation',
          'jns.registry', 'jns.resolver', 'jns.registrar',
          'bazaar.marketplace',
          'dws.storageManager', 'dws.workerRegistry',
          'nodeStaking.manager', 'nodeStaking.serviceStaking',
          'moderation.banManager',
          'payments.feeConfig', 'payments.creditManager',
        ]
        return important.includes(e.path)
      })

      // If no key contracts matched, check all configured ones
      const contractsToCheck = keyContracts.length > 0 ? keyContracts : configured.slice(0, 20)

      let stale = 0
      let found = 0

      for (const entry of contractsToCheck) {
        // Case-insensitive search since addresses may be checksummed differently
        const inBundle = bundleContent.toLowerCase().includes(entry.address.toLowerCase())

        if (inBundle) {
          console.log(`\x1b[32m✓ ${entry.path.padEnd(40)} ${entry.address.slice(0, 12)}... found in bundle\x1b[0m`)
          found++
        } else {
          console.log(`\x1b[31m✗ ${entry.path.padEnd(40)} ${entry.address.slice(0, 12)}... NOT IN BUNDLE ← STALE BUILD\x1b[0m`)
          stale++
        }
      }

      console.log('')
      if (stale > 0) {
        console.log(`\x1b[31mGateway build is STALE: ${stale} contract addresses not found in bundle\x1b[0m`)
        console.log(`\x1b[33mRebuild: JEJU_NETWORK=${networkArg} bun run --cwd apps/gateway build\x1b[0m`)
      } else if (found > 0) {
        console.log(`\x1b[32mGateway build looks fresh: ${found} key contract addresses found in bundle\x1b[0m`)
      } else {
        console.log(`\x1b[33mCould not determine gateway staleness (no matching addresses found)\x1b[0m`)
      }
    }
  }
}

// --- Exit code ---

if (missing > 0) {
  process.exit(1)
}
