# Gateway

Protocol infrastructure portal. Bridge tokens, deploy paymasters, provide liquidity, and run nodes.

## Setup

```bash
cd apps/gateway
bun install
```

## Environment Variables

Create `.env` for local development or configure for production:

### Required
```bash
VITE_RPC_URL=https://rpc.jejunetwork.org
VITE_CHAIN_ID=420691
VITE_WALLETCONNECT_PROJECT_ID=your_project_id
```

### Contract Addresses
```bash
VITE_IDENTITY_REGISTRY_ADDRESS=0x...
VITE_TOKEN_REGISTRY_ADDRESS=0x...
VITE_PAYMASTER_FACTORY_ADDRESS=0x...
VITE_BAN_MANAGER_ADDRESS=0x...
VITE_JEJU_TOKEN_ADDRESS=0x...
```

### Services
```bash
VITE_INDEXER_URL=https://indexer.jejunetwork.org/graphql
VITE_LEADERBOARD_API_URL=https://leaderboard.jejunetwork.org
VITE_OIF_AGGREGATOR_URL=https://intents.jejunetwork.org/api
VITE_JEJU_IPFS_GATEWAY=https://ipfs.jejunetwork.org
```

### JNS (Jeju Name Service)
```bash
VITE_JNS_REGISTRY=0x...
VITE_JNS_RESOLVER=0x...
VITE_JNS_REGISTRAR=0x...
VITE_JNS_REVERSE_REGISTRAR=0x...
```

### Network
```bash
VITE_NETWORK=mainnet  # localnet, testnet, or mainnet
```

Contract addresses are auto-loaded from localnet deployment when running locally.

## Run

```bash
# Development
bun run dev

# Production build
bun run build
bun run preview
```

Server runs on http://localhost:4001

## Test

```bash
# Unit tests
bun test:unit

# E2E tests
bun run test:e2e
```

## QoS Validator

```bash
# Short testnet command (auto-uses jeju-dws.fartbag.fun + first nodeId)
bun run run:qosv:testnet -- storage dryrun
bun run run:qosv:testnet -- compute dryrun
bun run run:qosv:testnet -- email dryrun

# Run a single module in one-shot mode (loads repo .env.testnet if present)
bun run run:qos-validator:once -- storage onchain
bun run run:qos-validator:once -- compute onchain
bun run run:qos-validator:once -- rpc onchain
bun run run:qos-validator:once -- cdn onchain

# Any other supported DWS module (baseline health/stats scoring)
bun run run:qos-validator:once -- da dryrun
bun run run:qos-validator:once -- vpn dryrun
```
