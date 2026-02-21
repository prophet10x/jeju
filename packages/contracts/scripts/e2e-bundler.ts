/**
 * E2E Test - UserOperation via EntryPoint v0.9 (handleOps)
 *
 * Tests the full ERC-4337 flow with v0.9 EntryPoint:
 * 1. Deploy smart wallet via EntryPoint's senderCreator
 * 2. Execute UserOperation (no-op call)
 * 3. Verify execution
 *
 * Note: v0.9 EntryPoint uses EIP-712 typed data hash which is incompatible with
 * current bundler implementations (Alto, etc.) that use v0.7 hash format.
 * This test submits directly via handleOps.
 *
 * Environment variables:
 *   RPC_URL          - L2 RPC URL (default: http://localhost:9545)
 *   CHAIN_ID         - Chain ID (default: 420690)
 *   ENTRYPOINT       - EntryPoint v0.9 address
 *   FACTORY          - SimpleAccountFactory address
 *   DEPLOYER_PRIVATE_KEY - Key with ETH for funding
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
const RPC_URL = process.env.RPC_URL || 'https://jeju-testnet.fartbag.fun/'
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '420690')

const ENTRY_POINT = (process.env.ENTRYPOINT ||
  '0x4826533b4897376654bb4d4ad88b7fafd0c98528') as Address
const FACTORY = (process.env.FACTORY ||
  '0x9d4454B023096f34B160D6B654540c56A1F81688') as Address

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
  console.log('   E2E UserOp Test - EntryPoint v0.9 (handleOps)')
  console.log('====================================================\n')

  const pub = createPublicClient({ chain, transport: http(RPC_URL) })
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const testUser = privateKeyToAccount(USER_KEY)
  const deployerW = createWalletClient({
    account: deployer,
    chain,
    transport: http(RPC_URL),
  })

  console.log('Deployer:', deployer.address)
  console.log('Test User:', testUser.address)

  // Step 1: Compute wallet address
  const wallet = await pub.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: 'getAddress',
    args: [testUser.address, 0n],
  })
  console.log('Smart Wallet:', wallet)

  // Step 2: Fund wallet
  console.log('\n--- Phase 1: Deploy wallet ---')
  let h = await deployerW.sendTransaction({
    to: wallet,
    value: parseEther('0.05'),
  })
  await pub.waitForTransactionReceipt({ hash: h })
  console.log('Funded wallet with 0.05 ETH')

  // Step 3: Build deploy UserOp
  const initCode = concat([
    FACTORY,
    encodeFunctionData({
      abi: factoryAbi,
      functionName: 'createAccount',
      args: [testUser.address, 0n],
    }),
  ])
  const callData = encodeFunctionData({
    abi: accountAbi,
    functionName: 'execute',
    args: [testUser.address, 0n, '0x'],
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

  // Sign using EntryPoint's getUserOpHash (EIP-712 format)
  const hash1 = await pub.readContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'getUserOpHash',
    args: [op1],
  })
  op1.signature = await testUser.sign({ hash: hash1 as Hex })

  console.log('Submitting deploy UserOp...')
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

  // Verify deployment
  const code = await pub.getCode({ address: wallet })
  console.log('Wallet deployed:', code !== undefined && code !== '0x')

  // Step 4: Execute a second UserOp (post-deploy)
  console.log('\n--- Phase 2: Execute UserOp ---')
  const nonce1 = await pub.readContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'getNonce',
    args: [wallet, 0n],
  })

  const callData2 = encodeFunctionData({
    abi: accountAbi,
    functionName: 'execute',
    args: [deployer.address, 0n, '0x'],
  })

  const op2 = {
    sender: wallet,
    nonce: nonce1,
    initCode: '0x' as Hex,
    callData: callData2,
    accountGasLimits,
    preVerificationGas: 100000n,
    gasFees,
    paymasterAndData: '0x' as Hex,
    signature: '0x' as Hex,
  }

  const hash2 = await pub.readContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'getUserOpHash',
    args: [op2],
  })
  op2.signature = await testUser.sign({ hash: hash2 as Hex })

  console.log('Submitting execute UserOp...')
  h = await deployerW.writeContract({
    address: ENTRY_POINT,
    abi: epAbi,
    functionName: 'handleOps',
    args: [[op2], deployer.address],
    gas: 2000000n,
  })
  const r2 = await pub.waitForTransactionReceipt({ hash: h })
  console.log('Status:', r2.status, '| Gas:', r2.gasUsed.toString())

  // Results
  console.log('\n====================================================')
  if (r1.status === 'success' && r2.status === 'success') {
    console.log('   SUCCESS - ERC-4337 flow via EntryPoint v0.9')
    console.log('   Phase 1: Wallet deploy via handleOps')
    console.log('   Phase 2: UserOp execution via handleOps')
  } else {
    console.log('   FAILED')
  }
  console.log('====================================================')
}

main().catch(console.error)
