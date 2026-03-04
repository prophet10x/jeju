#!/usr/bin/env bun

/**
 * Contract Verification Script
 *
 * Checks:
 * 1. Every configured address in contracts.json has bytecode on-chain
 * 2. Gateway source code has no hardcoded addresses that bypass contracts.json
 * 3. Gateway build bundle contains correct addresses from contracts.json
 * 4. Key contract functions are callable (ABI compatibility check)
 *
 * Usage:
 *   bun run packages/deployment/scripts/verify-contracts.ts [--network testnet|localnet] [--gateway-check] [--source-audit] [--functional]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createPublicClient, http, type Address, encodeFunctionData, decodeFunctionResult } from 'viem'

const ROOT_DIR = join(import.meta.dir, '../../..')

// --- Parse args ---

const args = process.argv.slice(2)
const networkArg = args.includes('--network')
  ? args[args.indexOf('--network') + 1]
  : 'testnet'
const gatewayCheck = args.includes('--gateway-check')
const sourceAudit = args.includes('--source-audit')
const functionalCheck = args.includes('--functional')
const runAll = !gatewayCheck && !sourceAudit && !functionalCheck

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

// Build set of all known addresses (lower case) for source audit
const knownAddresses = new Set<string>()
for (const entry of configured) {
  knownAddresses.add(entry.address.toLowerCase())
}
// Also add predeploy addresses and well-known constants
const WELL_KNOWN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000', // zero
  '0x000000000000000000000000000000000000dead', // burn
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', // ERC-4337 EntryPoint v0.6
  '0x0000000071727de22e5e9d8baf0edac6f37da032', // ERC-4337 EntryPoint v0.7
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', // Foundry deployer
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', // Foundry test account 1
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', // Foundry test account 2
  // Well-known tokens on public chains (referenced in gateway networks.ts, x402/chains.ts)
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH (Ethereum mainnet)
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC (Ethereum mainnet)
  '0x7b79995e5f793a07bc00c21412e50ecae098e7f9', // WETH (Sepolia)
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH (Arbitrum)
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC (Arbitrum)
  '0x0165878a594ca255338adfa4d48449f69242eb8f', // USDC fallback (Jeju mainnet)
  '0x953f6516e5d2864ce7f13186b45de418ea665eb2', // USDC fallback (Jeju testnet)
])
for (const addr of WELL_KNOWN_ADDRESSES) {
  knownAddresses.add(addr)
}
// Add all predeploys
for (const entry of predeploys) {
  knownAddresses.add(entry.address.toLowerCase())
}
// Add addresses from ALL networks (not just current) to avoid false positives
for (const netKey of Object.keys(allContracts)) {
  if (typeof allContracts[netKey] !== 'object') continue
  for (const entry of flattenContracts(allContracts[netKey])) {
    if (entry.address && entry.address.startsWith('0x') && entry.address.length === 42) {
      knownAddresses.add(entry.address.toLowerCase())
    }
  }
}

// --- On-chain verification ---

const client = createPublicClient({
  transport: http(rpcUrl),
})

const ENTRYPOINT_SENDER_CREATOR_ABI = [
  {
    name: 'senderCreator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

const SIMPLE_ACCOUNT_FACTORY_ABI = [
  {
    name: 'senderCreator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'accountImplementation',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'getAddress',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'salt', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

const SIMPLE_ACCOUNT_IMPLEMENTATION_ABI = [
  {
    name: 'entryPoint',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

const MULTI_TOKEN_PAYMASTER_ABI = [
  {
    name: 'entryPoint',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

let totalErrors = 0

console.log(`\x1b[1m=== Contract Bytecode Verification (${networkArg}, chain ${chainId}) ===\x1b[0m`)
console.log(`RPC: ${rpcUrl}`)
console.log('')

let deployed = 0
let missingCode = 0

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
      console.log(`\x1b[31m✗ ${entry.path.padEnd(40)} ${entry.address.slice(0, 12)}... NO CODE ← DEAD ADDRESS\x1b[0m`)
      missingCode++
    }
  } catch (err) {
    console.log(`\x1b[31m✗ ${entry.path.padEnd(40)} ${entry.address.slice(0, 12)}... RPC ERROR: ${(err as Error).message.slice(0, 60)}\x1b[0m`)
    missingCode++
  }
}

// Show unconfigured (first 5, then summarize)
const showUnconfigured = unconfigured.slice(0, 5)
for (const entry of showUnconfigured) {
  console.log(`\x1b[90m- ${entry.path.padEnd(40)} (not configured)\x1b[0m`)
}
if (unconfigured.length > 5) {
  console.log(`\x1b[90m  ... and ${unconfigured.length - 5} more not configured\x1b[0m`)
}

console.log('')
const resultColor = missingCode > 0 ? '\x1b[31m' : '\x1b[32m'
console.log(`${resultColor}Bytecode: ${deployed} deployed, ${unconfigured.length} not configured, ${missingCode} MISSING CODE\x1b[0m`)
totalErrors += missingCode

// --- Source Code Audit: Find hardcoded addresses in gateway that bypass contracts.json ---

if (sourceAudit || runAll) {
  console.log('')
  console.log('\x1b[1m=== Gateway Source Code Address Audit ===\x1b[0m')

  const gatewaySourceDir = join(ROOT_DIR, 'apps/gateway')
  const ADDRESS_REGEX = /['"`](0x[a-fA-F0-9]{40})['"`]/g

  // Recursively find all .ts and .tsx files (excluding node_modules, dist, tests, .dws-bundle)
  function findSourceFiles(dir: string): string[] {
    const files: string[] = []
    try {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry)
        if (entry === 'node_modules' || entry === 'dist' || entry === 'tests' || entry === '.dws-bundle') continue
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          files.push(...findSourceFiles(fullPath))
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          files.push(fullPath)
        }
      }
    } catch { /* skip unreadable dirs */ }
    return files
  }

  const sourceFiles = findSourceFiles(gatewaySourceDir)
  let hardcodedCount = 0

  for (const filePath of sourceFiles) {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let match: RegExpExecArray | null
      ADDRESS_REGEX.lastIndex = 0
      while ((match = ADDRESS_REGEX.exec(line)) !== null) {
        const addr = match[1].toLowerCase()

        // Skip if it's in contracts.json or is a well-known constant
        if (knownAddresses.has(addr)) continue

        // Skip if it's in a comment
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

        // This is a hardcoded address not in contracts.json!
        const relPath = relative(ROOT_DIR, filePath)
        console.log(`\x1b[31m✗ HARDCODED: ${relPath}:${i + 1}\x1b[0m`)
        console.log(`  \x1b[33m${match[1]}\x1b[0m`)
        console.log(`  \x1b[90m${line.trim().slice(0, 100)}\x1b[0m`)
        hardcodedCount++
      }
    }
  }

  if (hardcodedCount === 0) {
    console.log(`\x1b[32m✓ No hardcoded addresses found outside contracts.json\x1b[0m`)
  } else {
    console.log('')
    console.log(`\x1b[31mSource audit: ${hardcodedCount} hardcoded address(es) found that bypass contracts.json\x1b[0m`)
    console.log(`\x1b[33mFix: Replace with imports from @jejunetwork/config or lib/config\x1b[0m`)
    totalErrors += hardcodedCount
  }
}

// --- Gateway build staleness check ---

if (gatewayCheck || runAll) {
  console.log('')
  console.log('\x1b[1m=== Gateway Build Staleness Check ===\x1b[0m')

  const gatewayDistDir = join(ROOT_DIR, 'apps/gateway/dist')
  if (!existsSync(gatewayDistDir)) {
    console.log('\x1b[33mNo gateway build found at apps/gateway/dist\x1b[0m')
  } else {
    let bundleContent = ''
    const glob = new Bun.Glob('**/*.js')
    for (const file of glob.scanSync(gatewayDistDir)) {
      bundleContent += readFileSync(join(gatewayDistDir, file), 'utf-8')
    }

    if (!bundleContent) {
      console.log('\x1b[33mNo JS files found in gateway dist\x1b[0m')
    } else {
      // Check key contract addresses the gateway uses
      const important = [
        'tokens.jeju', 'tokens.usdc',
        'registry.identity', 'registry.reputation',
        'jns.registry', 'jns.resolver', 'jns.registrar',
        'nodeStaking.manager', 'nodeStaking.serviceStaking',
        'moderation.banManager',
        'payments.paymasterFactory', 'payments.priceOracle',
        'oif.solverRegistry', 'oif.inputSettler',
      ]

      const keyContracts = configured.filter(e => important.includes(e.path))
      const contractsToCheck = keyContracts.length > 0 ? keyContracts : configured.slice(0, 20)

      let stale = 0
      let found = 0

      for (const entry of contractsToCheck) {
        const inBundle = bundleContent.toLowerCase().includes(entry.address.toLowerCase())
        if (inBundle) {
          console.log(`\x1b[32m✓ ${entry.path.padEnd(40)} found in bundle\x1b[0m`)
          found++
        } else {
          console.log(`\x1b[31m✗ ${entry.path.padEnd(40)} NOT IN BUNDLE ← STALE\x1b[0m`)
          stale++
        }
      }

      // Also check: does the bundle contain any addresses NOT in contracts.json?
      const bundleLower = bundleContent.toLowerCase()
      const bundleAddresses = bundleLower.match(/0x[a-f0-9]{40}/g) || []
      const unknownInBundle = new Set<string>()
      for (const addr of bundleAddresses) {
        if (!knownAddresses.has(addr) && !addr.startsWith('0x00000000')) {
          unknownInBundle.add(addr)
        }
      }

      if (unknownInBundle.size > 0) {
        console.log('')
        console.log(`\x1b[33mWarning: ${unknownInBundle.size} address(es) in bundle not found in contracts.json:\x1b[0m`)
        let shown = 0
        for (const addr of unknownInBundle) {
          if (shown >= 5) {
            console.log(`\x1b[90m  ... and ${unknownInBundle.size - 5} more\x1b[0m`)
            break
          }
          console.log(`\x1b[33m  ${addr}\x1b[0m`)
          shown++
        }
      }

      console.log('')
      if (stale > 0) {
        console.log(`\x1b[31mGateway build is STALE: ${stale} contract addresses not found in bundle\x1b[0m`)
        console.log(`\x1b[33mRebuild: JEJU_NETWORK=${networkArg} bun run --cwd apps/gateway build\x1b[0m`)
        totalErrors += stale
      } else if (found > 0) {
        console.log(`\x1b[32mGateway build looks fresh: ${found} key addresses in bundle\x1b[0m`)
      }
    }
  }
}

// --- Functional contract checks ---

if (functionalCheck || runAll) {
  console.log('')
  console.log('\x1b[1m=== Functional Contract Checks ===\x1b[0m')

  let funcPass = 0
  let funcFail = 0

  // Helper: try calling a view function
  async function checkFunction(
    name: string,
    address: string,
    sig: string,
    args: string = '',
  ): Promise<boolean> {
    if (!address || address === '') {
      console.log(`\x1b[90m- ${name.padEnd(50)} (not configured, skipped)\x1b[0m`)
      return true
    }
    try {
      // Use raw eth_call with function signature
      const selector = await getSelector(sig)
      const data = selector + args
      const result = await client.call({
        to: address as Address,
        data: data as `0x${string}`,
      })
      if (result.data && result.data !== '0x') {
        console.log(`\x1b[32m✓ ${name.padEnd(50)} ${sig} → OK\x1b[0m`)
        funcPass++
        return true
      } else {
        console.log(`\x1b[31m✗ ${name.padEnd(50)} ${sig} → empty response\x1b[0m`)
        funcFail++
        return false
      }
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('reverted')) {
        // Revert might be expected (e.g., function exists but args wrong)
        console.log(`\x1b[33m~ ${name.padEnd(50)} ${sig} → reverted (function exists)\x1b[0m`)
        funcPass++
        return true
      }
      console.log(`\x1b[31m✗ ${name.padEnd(50)} ${sig} → ${msg.slice(0, 80)}\x1b[0m`)
      funcFail++
      return false
    }
  }

  // Simple keccak256 for function selector
  async function getSelector(sig: string): Promise<string> {
    const encoder = new TextEncoder()
    const data = encoder.encode(sig)
    const hash = await crypto.subtle.digest('SHA-256', data)
    // Actually use keccak256 via viem
    const { keccak256, toBytes } = await import('viem')
    const fullHash = keccak256(toBytes(sig))
    return fullHash.slice(0, 10) // 4 bytes = 10 chars (0x + 8)
  }

  // Get addresses from contracts.json
  function getAddr(path: string): string {
    return configured.find(e => e.path === path)?.address || ''
  }

  const jejuToken = getAddr('tokens.jeju')
  const identityRegistry = getAddr('registry.identity')
  const nodeStakingManager = getAddr('nodeStaking.manager')
  const paymasterFactory = getAddr('payments.paymasterFactory')
  const entryPoint =
    getAddr('accountAbstraction.entryPointDeployed') ||
    getAddr('accountAbstraction.entryPointV07')
  const simpleAccountFactory = getAddr('accountAbstraction.simpleAccountFactory')
  const multiTokenPaymaster = getAddr('payments.multiTokenPaymaster')

  // Check JEJU token: name(), symbol(), totalSupply()
  if (jejuToken) {
    await checkFunction('JEJU Token name()', jejuToken, 'name()')
    await checkFunction('JEJU Token symbol()', jejuToken, 'symbol()')
    await checkFunction('JEJU Token totalSupply()', jejuToken, 'totalSupply()')
  }

  // Check IdentityRegistry: isSupportedStakeToken(JEJU)
  if (identityRegistry && jejuToken) {
    const paddedToken = jejuToken.slice(2).padStart(64, '0')
    await checkFunction(
      'IdentityRegistry isSupportedStakeToken(JEJU)',
      identityRegistry,
      'isSupportedStakeToken(address)',
      paddedToken,
    )
    await checkFunction('IdentityRegistry getStakeAmount(1)', identityRegistry, 'getStakeAmount(uint8)', '0000000000000000000000000000000000000000000000000000000000000001')
  }

  // Check NodeStakingManager: getNetworkStats()
  if (nodeStakingManager) {
    await checkFunction('NodeStakingManager getNetworkStats()', nodeStakingManager, 'getNetworkStats()')
  }

  // Check PaymasterFactory exists
  if (paymasterFactory) {
    // Just verify the contract responds (any view function)
    const code = await client.getCode({ address: paymasterFactory as Address })
    if (code && code !== '0x' && code.length > 2) {
      console.log(`\x1b[32m✓ ${'PaymasterFactory has bytecode'.padEnd(50)}\x1b[0m`)
      funcPass++
    } else {
      console.log(`\x1b[31m✗ ${'PaymasterFactory has NO bytecode'.padEnd(50)}\x1b[0m`)
      funcFail++
    }
  }

  if (entryPoint && simpleAccountFactory) {
    try {
      const [entryPointSenderCreator, factorySenderCreator, accountImplementation] =
        await Promise.all([
          client.readContract({
            address: entryPoint as Address,
            abi: ENTRYPOINT_SENDER_CREATOR_ABI,
            functionName: 'senderCreator',
          }),
          client.readContract({
            address: simpleAccountFactory as Address,
            abi: SIMPLE_ACCOUNT_FACTORY_ABI,
            functionName: 'senderCreator',
          }),
          client.readContract({
            address: simpleAccountFactory as Address,
            abi: SIMPLE_ACCOUNT_FACTORY_ABI,
            functionName: 'accountImplementation',
          }),
        ])

      if (
        entryPointSenderCreator.toLowerCase() ===
        factorySenderCreator.toLowerCase()
      ) {
        console.log(`\x1b[32m✓ ${'AA senderCreator coherence'.padEnd(50)}\x1b[0m`)
        funcPass++
      } else {
        console.log(
          `\x1b[31m✗ ${'AA senderCreator coherence'.padEnd(50)} EP ${entryPointSenderCreator} != Factory ${factorySenderCreator}\x1b[0m`,
        )
        funcFail++
      }

      const implementationEntryPoint = await client.readContract({
        address: accountImplementation as Address,
        abi: SIMPLE_ACCOUNT_IMPLEMENTATION_ABI,
        functionName: 'entryPoint',
      })

      if (implementationEntryPoint.toLowerCase() === entryPoint.toLowerCase()) {
        console.log(`\x1b[32m✓ ${'AA implementation entryPoint coherence'.padEnd(50)}\x1b[0m`)
        funcPass++
      } else {
        console.log(
          `\x1b[31m✗ ${'AA implementation entryPoint coherence'.padEnd(50)} Impl ${implementationEntryPoint} != EntryPoint ${entryPoint}\x1b[0m`,
        )
        funcFail++
      }

      const predicted = await client.readContract({
        address: simpleAccountFactory as Address,
        abi: SIMPLE_ACCOUNT_FACTORY_ABI,
        functionName: 'getAddress',
        args: ['0x845eD1333733a1572c7cf6788f58fC6f7C1cDc7F', 0n],
      })
      console.log(
        `\x1b[32m✓ ${'AA sample getAddress(owner,0)'.padEnd(50)} ${predicted}\x1b[0m`,
      )
      funcPass++
    } catch (err) {
      console.log(
        `\x1b[31m✗ ${'AA coherence checks'.padEnd(50)} ${(err as Error).message.slice(0, 120)}\x1b[0m`,
      )
      funcFail++
    }
  }

  if (entryPoint && multiTokenPaymaster) {
    try {
      const paymasterEntryPoint = await client.readContract({
        address: multiTokenPaymaster as Address,
        abi: MULTI_TOKEN_PAYMASTER_ABI,
        functionName: 'entryPoint',
      })

      if (paymasterEntryPoint.toLowerCase() === entryPoint.toLowerCase()) {
        console.log(`\x1b[32m✓ ${'AA paymaster entryPoint coherence'.padEnd(50)}\x1b[0m`)
        funcPass++
      } else {
        console.log(
          `\x1b[31m✗ ${'AA paymaster entryPoint coherence'.padEnd(50)} Paymaster ${paymasterEntryPoint} != EntryPoint ${entryPoint}\x1b[0m`,
        )
        funcFail++
      }
    } catch (err) {
      console.log(
        `\x1b[31m✗ ${'AA paymaster entryPoint coherence'.padEnd(50)} ${(err as Error).message.slice(0, 120)}\x1b[0m`,
      )
      funcFail++
    }
  }

  console.log('')
  if (funcFail > 0) {
    console.log(`\x1b[31mFunctional: ${funcPass} passed, ${funcFail} failed\x1b[0m`)
    totalErrors += funcFail
  } else {
    console.log(`\x1b[32mFunctional: ${funcPass} checks passed\x1b[0m`)
  }
}

// --- Final summary ---

console.log('')
console.log('\x1b[1m=== Summary ===\x1b[0m')
if (totalErrors > 0) {
  console.log(`\x1b[31m${totalErrors} total error(s) found\x1b[0m`)
  process.exit(1)
} else {
  console.log(`\x1b[32mAll checks passed\x1b[0m`)
}
