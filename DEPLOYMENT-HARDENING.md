# Deployment Hardening Guide (Gateway + DWS + Node Registration)

This runbook prevents the exact production issues we just hit: broken proof flow, wrong owner-path decisions, missing paymaster services, bundler/KMS routing drift, and empty node listings.

## 1) Canonical Host Roles

- Oracle host:
  - Public app: `https://jeju-testnet.fartbag.fun/gateway`
  - RPC origin: `https://jeju-testnet.fartbag.fun/`
  - Bundler authority (if centralized): Oracle EntryPoint/bundler target
- AWS host:
  - Public app: `https://jeju-dws.fartbag.fun/provider`
  - DWS API origin: `https://jeju-dws.fartbag.fun/`
  - DWS KMS endpoint: `https://jeju-dws.fartbag.fun/kms`

Important:
- Node RPC URL in registration must be the node endpoint origin (`https://.../`), not `/gateway` or `/provider` UI paths.

## 2) Required Config Consistency

All of these must match between Gateway and DWS builds:

- `identityRegistry`
- `nodeStakingManager`
- `multiTokenPaymaster`
- `entryPointV07` / `entryPoint`
- `simpleAccountFactory`
- `creditManager` (if used)
- `jeju` token address
- network id / chain id (`420690` for JEJU testnet)

Also verify:
- Gateway points KMS to DWS KMS (or whichever host is authoritative).
- DWS `/bundler` nginx proxy points to the intended bundler backend.
- both apps use the same service names from `packages/shared/src/paymaster-services.ts`.

## 3) Health Checks (Before Any Release)

Run from your workstation:

```bash
curl -sf https://jeju-testnet.fartbag.fun/health || exit 1
curl -sf https://jeju-dws.fartbag.fun/health || exit 1
curl -sf https://jeju-dws.fartbag.fun/kms/health || exit 1
curl -sf https://jeju-dws.fartbag.fun/bundler || true
curl -sf https://jeju-testnet.fartbag.fun/gateway/api/node-registration/challenge -X POST -H 'content-type: application/json' -d '{"endpoint":"https://jeju-dws.fartbag.fun/","operatorAddress":"0x0000000000000000000000000000000000000001","operatorAgentId":1}' || true
```

Expected:
- no `404` for node-registration routes
- no empty-body JSON responses
- no KMS `unavailable` for active environment

## 4) Paymaster Service Registry Gate

Required service entries:

- `Jeju Agent Registration`
- `Jeju Agent Registration Metadata`
- `Jeju Node Registration`
- `Jeju Node Identity Registration`
- `Jeju Node Identity Metadata`

Fail release if any are missing from the `ServiceRegistry` used by the active paymaster.

Verification command:

```bash
RPC_URL="https://jeju-testnet.fartbag.fun/" \
PAYMASTER_ADDRESS="0xYourPaymasterAddress" \
bun run scripts/check-paymaster-services.ts
```

## 5) Proof Flow Gate

For both Gateway and DWS:

1. `Prepare Proof` returns challenge JSON and proof URL.
2. `Authorize Node Wallet` submits tx and shows tx hash.
3. delegated wallet updates on-chain for selected operator identity.
4. `Verify Endpoint Ownership` succeeds (no silent no-op), then unlocks next step.

Fail release if any step is flaky or host-specific.

## 6) Node Listing Parity Gate

For same wallet/operator on both apps:

- `Network Overview` and user node pages must be coherent.
- `My Nodes` (Gateway), `/provider/nodes` (DWS), and `Settings > Nodes` (DWS) must show staking-linked nodes for:
  - EOA owner path
  - predicted/actual SimpleAccount owner path
- If metadata missing: still show node row as `Metadata pending`.

## 7) Rollout Procedure (Mac -> GitHub -> Oracle -> AWS)

1. Local Mac branch is source of truth (`codex/...`).
2. Run local checks and build.
3. Commit only intended files (no temp scripts/secrets).
4. Push branch to your fork.
5. On Oracle: pull same branch, install/build/restart affected services.
6. On AWS: pull same branch, install/build/restart affected services.
7. Re-run health + proof + node listing gates.
8. Open upstream PR only after both hosts pass smoke tests.

## 8) Mandatory Smoke Test Matrix

Run after each deploy:

1. Move JEJU `EOA -> SimpleAccount` (tx hash + confirmation visible).
2. Node proof flow (`Prepare` -> `Authorize` -> `Verify`) on Gateway.
3. Node proof flow (`Prepare` -> `Authorize` -> `Verify`) on DWS.
4. Register node end-to-end.
5. Confirm node appears in:
  - Gateway `My Nodes`
  - DWS `/provider/nodes`
  - DWS `Settings > Nodes`
6. Register app with category/tags; verify card primary badge + detail categories.

## 9) Common Failure Signatures and Fixes

- `KMS service unavailable ...`:
  - check KMS URL/env
  - verify DWS KMS service health and proxy
- `/bundler` 500/NOT_FOUND:
  - fix DWS nginx proxy target
  - verify bundler process and EntryPoint version
- `ServiceNotAvailable("Jeju Node Identity Registration")`:
  - missing paymaster service registration
- `Verify Endpoint Ownership` appears no-op:
  - verify response schema from `/node-registration/verify`
  - ensure UI updates verification state and surfaces success/error
- nodes in overview but not in my-nodes:
  - owner-path mismatch (EOA vs smart account)
  - query both and merge/dedupe

## 10) Production Readiness Rule

No production launch unless every gate in sections 3-8 passes on the exact production hostnames and chain config.
