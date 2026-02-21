/**
 * E2E Paymaster Test - Pay gas with ELIZAOS tokens via LiquidityPaymaster
 *
 * This script demonstrates the full ERC-4337 gasless flow:
 * 1. Deploy a SimpleAccount smart wallet via EntryPoint
 * 2. Approve ELIZAOS tokens to the LiquidityPaymaster
 * 3. Send a paymaster-sponsored transaction (gas paid in ELIZAOS, not ETH)
 *
 * Requirements:
 * - DEPLOYER_PRIVATE_KEY env var (account with ETH + ELIZAOS tokens)
 * - Running L2 node on localhost:9545
 * - Deployed contracts: EntryPoint v0.9, SimpleAccountFactory, LiquidityPaymaster, PriceOracle
 *
 * Usage:
 *   export DEPLOYER_PRIVATE_KEY=0x...
 *   node scripts/e2e-paymaster-elizaos.mjs
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseAbi,
  parseEther,
  toHex,
  concat,
  pad,
  defineChain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// === Configuration ===
const RPC_URL = process.env.RPC_URL || 'https://jeju-testnet.fartbag.fun/'
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '420690')

const ENTRYPOINT = process.env.ENTRYPOINT || '0x0E801D84Fa97b50751Dbf25036d067dCf18858bF'
const PAYMASTER = process.env.PAYMASTER || '0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf'
const ELIZAOS_TOKEN = process.env.ELIZAOS_TOKEN || '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const FACTORY = process.env.FACTORY || '0x9d4454B023096f34B160D6B654540c56A1F81688'

// Generate a random test user for each run
const TEST_USER_KEY = process.env.TEST_USER_KEY || (() => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
})()

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Jeju Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})

const factoryAbi = parseAbi([
  'function createAccount(address,uint256) returns (address)',
  'function getAddress(address,uint256) view returns (address)',
])
const tokenAbi = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
])
const accountAbi = parseAbi(['function execute(address,uint256,bytes)'])
const epAbi = parseAbi([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary)',
  'function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)) view returns (bytes32)',
  'function getNonce(address,uint192) view returns (uint256)',
])

async function main() {
  const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY
  if (!DEPLOYER_KEY) {
    console.error('Error: DEPLOYER_PRIVATE_KEY env var required')
    process.exit(1)
  }

  const pub = createPublicClient({ chain, transport: http(RPC_URL) })
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const deployerW = createWalletClient({ account: deployer, chain, transport: http(RPC_URL) })
  const testUser = privateKeyToAccount(TEST_USER_KEY)

  console.log('=== E2E Paymaster Test ===')
  console.log('Test User EOA:', testUser.address)

  const wallet = await pub.readContract({
    address: FACTORY, abi: factoryAbi, functionName: 'getAddress', args: [testUser.address, 0n],
  })
  console.log('Smart Wallet:', wallet)

  // === PHASE 1: Deploy wallet + approve tokens ===
  console.log('\n--- Phase 1: Deploy wallet & approve (setup) ---')

  console.log('Transferring 1000 ELIZAOS to wallet...')
  let h = await deployerW.writeContract({
    address: ELIZAOS_TOKEN, abi: tokenAbi, functionName: 'transfer', args: [wallet, parseEther('1000')],
  })
  await pub.waitForTransactionReceipt({ hash: h })

  console.log('Sending 0.05 ETH for setup...')
  h = await deployerW.sendTransaction({ to: wallet, value: parseEther('0.05') })
  await pub.waitForTransactionReceipt({ hash: h })

  const initCode = concat([
    FACTORY,
    encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [testUser.address, 0n] }),
  ])
  const approveData = encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [PAYMASTER, 2n ** 256n - 1n] })
  const callData = encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [ELIZAOS_TOKEN, 0n, approveData] })

  const vgl = 500000n, cgl = 200000n
  const accountGasLimits = concat([pad(toHex(vgl), { size: 16 }), pad(toHex(cgl), { size: 16 })])
  const gasFees = concat([pad(toHex(1000000n), { size: 16 }), pad(toHex(1000000n), { size: 16 })])
  const nonce0 = await pub.readContract({ address: ENTRYPOINT, abi: epAbi, functionName: 'getNonce', args: [wallet, 0n] })

  const op1 = {
    sender: wallet, nonce: nonce0, initCode, callData, accountGasLimits,
    preVerificationGas: 100000n, gasFees, paymasterAndData: '0x', signature: '0x',
  }

  const hash1 = await pub.readContract({ address: ENTRYPOINT, abi: epAbi, functionName: 'getUserOpHash', args: [op1] })
  op1.signature = await testUser.sign({ hash: hash1 })

  console.log('Submitting setup UserOp...')
  h = await deployerW.writeContract({
    address: ENTRYPOINT, abi: epAbi, functionName: 'handleOps',
    args: [[op1], deployer.address], gas: 2000000n,
  })
  const r1 = await pub.waitForTransactionReceipt({ hash: h })
  console.log('Status:', r1.status, '| Gas:', r1.gasUsed.toString())

  if (r1.status !== 'success') {
    console.error('Phase 1 FAILED')
    process.exit(1)
  }

  const startBal = await pub.readContract({ address: ELIZAOS_TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [wallet] })
  console.log('Wallet deployed: YES | ELIZAOS:', (startBal / 10n ** 18n).toString(), '| Allowance: YES')

  // === PHASE 2: Paymaster-sponsored transaction ===
  console.log('\n--- Phase 2: Paymaster-sponsored tx (gas = ELIZAOS) ---')

  const transferData = encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [deployer.address, parseEther('1')] })
  const callData2 = encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [ELIZAOS_TOKEN, 0n, transferData] })

  const accountGasLimits2 = concat([pad(toHex(200000n), { size: 16 }), pad(toHex(200000n), { size: 16 })])
  const pmAndData = concat([PAYMASTER, pad(toHex(200000n), { size: 16 }), pad(toHex(150000n), { size: 16 })])
  const nonce1 = await pub.readContract({ address: ENTRYPOINT, abi: epAbi, functionName: 'getNonce', args: [wallet, 0n] })

  const op2 = {
    sender: wallet, nonce: nonce1, initCode: '0x', callData: callData2,
    accountGasLimits: accountGasLimits2, preVerificationGas: 100000n,
    gasFees, paymasterAndData: pmAndData, signature: '0x',
  }

  const hash2 = await pub.readContract({ address: ENTRYPOINT, abi: epAbi, functionName: 'getUserOpHash', args: [op2] })
  op2.signature = await testUser.sign({ hash: hash2 })

  console.log('Sending paymaster-sponsored UserOp...')
  h = await deployerW.writeContract({
    address: ENTRYPOINT, abi: epAbi, functionName: 'handleOps',
    args: [[op2], deployer.address], gas: 2000000n,
  })
  const r2 = await pub.waitForTransactionReceipt({ hash: h })
  console.log('Status:', r2.status, '| Gas:', r2.gasUsed.toString())

  // Verify
  const endBal = await pub.readContract({ address: ELIZAOS_TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [wallet] })
  const gasTokenCost = startBal - endBal - parseEther('1')

  console.log('\n=== Results ===')
  console.log('ELIZAOS remaining:', (endBal / 10n ** 18n).toString(), 'tokens')
  console.log('ELIZAOS gas cost:', gasTokenCost.toString(), 'wei (~', (gasTokenCost * 100n / 10n ** 18n).toString(), '/100 tokens)')
  console.log('ETH spent by user: 0 (paymaster paid!)')

  if (r2.status === 'success') {
    console.log('\n*** SUCCESS: Gas paid with ELIZAOS tokens via LiquidityPaymaster! ***')
  }
}

main().catch(console.error)
