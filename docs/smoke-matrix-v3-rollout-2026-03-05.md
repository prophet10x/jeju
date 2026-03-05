# V3 Rollout Smoke Matrix (2026-03-05)

## Environment

- Oracle host runtime: `jeju-gateway-worker` from `/home/ubuntu/jeju-monorepo/apps/gateway`
- AWS host runtime: `jeju-dws` from `/home/ubuntu/jeju-monorepo/apps/dws`
- Canary flags enabled on both hosts:
  - `NODE_STAKING_WRITE_PATH=router-canary`
  - `NODE_STAKING_CANARY_OPERATORS=0xf9159891afb242ec0f2570c29406403e48a68271`
- V3 contracts (testnet):
  - `registry`: `0xaC9fCBA56E42d5960f813B9D0387F3D3bC003338`
  - `vault`: `0xdFdE6B33f13de2CA1A75A6F7169f50541B14f75b`
  - `router`: `0x54B8d8E2455946f2A5B8982283f2359812e815ce`
  - `moduleV3`: `0xf090f16dEc8b6D24082Edd25B1C8D26f2bC86128`
  - `migrationHandlerV3`: `0x38A70c040CA5F5439ad52d0e821063b0EC0B52b6`

## API smoke checks

Automated command used for wallet-independent checks:

```bash
bun scripts/smoke-v3-rollout.ts
```

1. `POST https://jeju-testnet.fartbag.fun/gateway/api/node-registration/challenge` with `{}`:
- PASS (JSON validation error returned, no empty/no-op response)

2. `POST https://jeju-testnet.fartbag.fun/gateway/api/node-registration/verify` with `{}`:
- PASS (JSON validation error returned, no empty/no-op response)

3. `POST https://jeju-dws.fartbag.fun/node-registration/challenge` with `{}`:
- PASS (JSON validation error returned, no empty/no-op response)

4. `POST https://jeju-dws.fartbag.fun/node-registration/verify` with `{}`:
- PASS (JSON validation error returned, no empty/no-op response)

5. `GET https://jeju-dws.fartbag.fun/staking/health`:
- PASS
- Observed manager source: `router`
- Observed manager address: `0x54B8d8E2455946f2A5B8982283f2359812e815ce`

6. `GET https://jeju-dws.fartbag.fun/staking/nodes?limit=10&offset=0`:
- PASS
- Node rows returned (not empty)

7. `GET https://jeju-dws.fartbag.fun/staking/operator/0xf9159891afb242ec0f2570c29406403e48a68271`:
- PASS
- Operator rows returned (not empty)

## Paymaster service gate

Command:

```bash
RPC_URL="https://jeju-testnet.fartbag.fun/" \
PAYMASTER_ADDRESS="0x976A62558df02514090500e588Bb62E04eA85DC3" \
bun run scripts/check-paymaster-services.ts
```

Result: PASS  
Required services available:
- `Jeju Agent Registration`
- `Jeju Agent Registration Metadata`
- `Jeju Node Registration`
- `Jeju Node Identity Registration`
- `Jeju Node Identity Metadata`

## Manual wallet-dependent checks (pending operator execution)

1. Gateway flow:
- `Prepare Proof` -> `Authorize Node Wallet` -> `Verify Endpoint Ownership`

2. DWS flow:
- `Prepare Proof` -> `Authorize Node Wallet` -> `Verify Endpoint Ownership`

3. Staking flow:
- register node through canary operator path and confirm tx hash + explorer + confirmation UI

4. UI parity checks:
- Gateway `My Nodes`
- DWS `/provider/nodes`
- DWS `Settings > Nodes`
- verify metadata-missing fallback row (`Metadata pending`) where applicable
