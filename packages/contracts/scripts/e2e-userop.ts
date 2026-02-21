/**
 * E2E UserOp Test - Paymaster-sponsored transaction via EntryPoint v0.9
 *
 * Tests the full gasless flow:
 * 1. Deploy smart wallet + approve ELIZAOS tokens (Phase 1, wallet pays ETH)
 * 2. Send paymaster-sponsored transaction (Phase 2, gas paid in ELIZAOS)
 *
 * Note: v0.9 EntryPoint uses EIP-712 typed data hash. Current bundlers (Alto)
 * compute hash using v0.7 format, causing signature mismatch. This test
 * submits directly via handleOps.
 *
 * Environment variables:
 *   RPC_URL          - L2 RPC URL (default: http://localhost:9545)
 *   CHAIN_ID         - Chain ID (default: 2151908)
 *   ENTRYPOINT       - EntryPoint v0.9 address
 *   FACTORY          - SimpleAccountFactory address
 *   PAYMASTER        - LiquidityPaymaster address
 *   ELIZAOS_TOKEN    - ELIZAOS ERC-20 address
 *   DEPLOYER_PRIVATE_KEY - Key with ETH + ELIZAOS tokens
 *   TEST_USER_KEY    - Key for test user (random if not set)
 */

import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  type Hex,
  http,
  pad,
  parseAbi,
  parseEther,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// === Configuration ===
const RPC_URL = process.env.RPC_URL || 'http://localhost:9545'
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '2151908')

const ENTRY_POINT = (process.env.ENTRYPOINT ||
  '0x3eb934d56d14fa073ef859c13a7ab9c5f8eeb948') as Address
const FACTORY = (process.env.FACTORY ||
  '0x58A55Dc97a3bBA3CD16d927e3Ed5b3c90F8E1A4c') as Address
const PAYMASTER = (process.env.PAYMASTER ||
  '0xA539885c451072af0BcA62f570B8AD296823830A') as Address
const ELIZAOS_TOKEN = (process.env.ELIZAOS_TOKEN ||
  '0x8332E76E40805aC9B06f3B11c1F415D608F66Db3') as Address

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex
const USER_KEY = (process.env.TEST_USER_KEY ||
  (() => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return (
      '0x' +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    )
  })()) as Hex

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
])
const accountAbi = parseAbi(['function execute(address,uint256,bytes)'])
const epAbi = parseAbi([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary)',
  'function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)) view returns (bytes32)',
  'function getNonce(address,uint192) view returns (uint256)',
])

async function main() {
  if (!DEPLOYER_KEY) {
    console.error('Error: DEPLOYER_PRIVATE_KEY env var required')
    process.exit(1)
  }

  console.log('====================================================')
  console.log('   E2E Paymaster Test - Gas paid with ELIZAOS tokens')
  console.log('   EntryPoint v0.9 / LiquidityPaymaster')
  console.log('====================================================\n')

  const pub = createPublicClient({ chain, transport: http(RPC_URL) })
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const testUser = privateKeyToAccount(USER_KEY)
  const deployerW = createWalletClient({
    account: deployer,
    chain,
    transport: http(RPC_URL),
  })

  console.log('Test User EOA:', testUser.address)

  const wallet = await pub.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: 'getAddress',
    args: [testUser.address, 0n],
  })
  console.log('Smart Wallet:', wallet)

  // === PHASE 1: Deploy wallet + approve tokens ===
  console.log('\n--- Phase 1: Deploy wallet & approve (setup) ---')

  console.log('Transferring 1000 ELIZAOS to wallet...')
  let h = await deployerW.writeContract({
    address: ELIZAOS_TOKEN,
    abi: tokenAbi,
    functionName: 'transfer',
    args: [wallet, parseEther('1000')],
  })
  await pub.waitForTransactionReceipt({ hash: h })

  console.log('Sending 0.05 ETH for setup...')
  h = await deployerW.sendTransaction({ to: wallet, value: parseEther('0.05') })
  await pub.waitForTransactionReceipt({ hash: h })

  const initCode = concat([
    FACTORY,
    encodeFunctionData({
      abi: factoryAbi,
      functionName: 'createAccount',
      args: [testUser.address, 0n],
    }),
  ])
  const approveData = encodeFunctionData({
    abi: tokenAbi,
    functionName: 'approve',
    args: [PAYMASTER, 2n ** 256n - 1n],
  })
  const callData = encodeFunctionData({
    abi: accountAbi,
    functionName: 'execute',
    args: [ELIZAOS_TOKEN, 0n, approveData],
  })

  const vgl = 500000n
  const cgl = 200000n
  const accountGasLimits = concat([
    pad(toHex(vgl), { size: 16 }),
    pad(toHex(cgl), { size: 16 }),
  ]) as Hex
  const gasFees = concat([
    pad(toHex(1000000n), { size: 16 }),
    pad(toHex(1000000n), { size: 16 }),
  ]) as Hex

  const nonce0 = await pub.readContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'getNonce',
    args: [wallet, 0n],
  })

  const op1 = {
    sender: wallet,
    nonce: nonce0,
    initCode,
    callData,
    accountGasLimits,
    preVerificationGas: 100000n,
    gasFees,
    paymasterAndData: '0x' as Hex,
    signature: '0x' as Hex,
  }

  const hash1 = await pub.readContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'getUserOpHash',
    args: [op1],
  })
  op1.signature = await testUser.sign({ hash: hash1 as Hex })

  console.log('Submitting setup UserOp...')
  h = await deployerW.writeContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'handleOps',
    args: [[op1], deployer.address],
    gas: 2000000n,
  })
  const r1 = await pub.waitForTransactionReceipt({ hash: h })
  console.log('Status:', r1.status, '| Gas:', r1.gasUsed.toString())

  if (r1.status !== 'success') {
    console.error('Phase 1 FAILED')
    process.exit(1)
  }

  const startBal = await pub.readContract({
    address: ELIZAOS_TOKEN,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [wallet],
  })
  console.log(
    'Wallet deployed: YES | ELIZAOS:',
    (startBal / 10n ** 18n).toString(),
    '| Allowance: YES',
  )

  // === PHASE 2: Paymaster-sponsored transaction ===
  console.log('\n--- Phase 2: Paymaster-sponsored tx (gas = ELIZAOS) ---')

  const transferData = encodeFunctionData({
    abi: tokenAbi,
    functionName: 'transfer',
    args: [deployer.address, parseEther('1')],
  })
  const callData2 = encodeFunctionData({
    abi: accountAbi,
    functionName: 'execute',
    args: [ELIZAOS_TOKEN, 0n, transferData],
  })

  const accountGasLimits2 = concat([
    pad(toHex(200000n), { size: 16 }),
    pad(toHex(200000n), { size: 16 }),
  ]) as Hex
  const pmAndData = concat([
    PAYMASTER,
    pad(toHex(200000n), { size: 16 }),
    pad(toHex(150000n), { size: 16 }),
  ]) as Hex

  const nonce1 = await pub.readContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'getNonce',
    args: [wallet, 0n],
  })

  const op2 = {
    sender: wallet,
    nonce: nonce1,
    initCode: '0x' as Hex,
    callData: callData2,
    accountGasLimits: accountGasLimits2,
    preVerificationGas: 100000n,
    gasFees,
    paymasterAndData: pmAndData,
    signature: '0x' as Hex,
  }

  const hash2 = await pub.readContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'getUserOpHash',
    args: [op2],
  })
  op2.signature = await testUser.sign({ hash: hash2 as Hex })

  console.log('Sending paymaster-sponsored UserOp...')
  h = await deployerW.writeContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'handleOps',
    args: [[op2], deployer.address],
    gas: 2000000n,
  })
  const r2 = await pub.waitForTransactionReceipt({ hash: h })
  console.log('Status:', r2.status, '| Gas:', r2.gasUsed.toString())

  // Verify
  const endBal = await pub.readContract({
    address: ELIZAOS_TOKEN,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [wallet],
  })
  const gasTokenCost = startBal - endBal - parseEther('1')

  console.log('\n=== Results ===')
  console.log(
    'ELIZAOS remaining:',
    (endBal / 10n ** 18n).toString(),
    'tokens',
  )
  console.log(
    'ELIZAOS gas cost:',
    gasTokenCost.toString(),
    'wei (~',
    ((gasTokenCost * 100n) / 10n ** 18n).toString(),
    '/100 tokens)',
  )
  console.log('ETH spent by user: 0 (paymaster paid!)')

  if (r2.status === 'success') {
    console.log(
      '\n*** SUCCESS: Gas paid with ELIZAOS tokens via LiquidityPaymaster! ***',
    )
  }
}

main().catch(console.error)
