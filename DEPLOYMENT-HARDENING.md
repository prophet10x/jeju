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

## 1.1) Base Install Requirement for Node Registration

Any endpoint intended for node registration proof must expose these routes at origin root:

- `POST /node-registration/challenge`
- `POST /node-registration/verify`
- `GET /.well-known/jeju-node-proof.json?challengeId=...`

This is a base runtime requirement for Jeju node onboarding. It must work even if a host is not running the full DWS dashboard UI.

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

## 2.1) Git Clone Hygiene (Critical)

Several outages came from server clones that only fetched one branch.

Run on each host:

```bash
git -C /home/ubuntu/jeju-monorepo config --get-all remote.origin.fetch
```

Expected:

```text
+refs/heads/*:refs/remotes/origin/*
```

If you see a single-branch refspec (for example only `codex/...`), reset it:

```bash
git -C /home/ubuntu/jeju-monorepo config --unset-all remote.origin.fetch
git -C /home/ubuntu/jeju-monorepo config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C /home/ubuntu/jeju-monorepo fetch origin
```

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

## 3.1) Runtime Path Checks (Before Restart)

Before restart, confirm service unit runtime path is what you expect:

```bash
# Oracle
systemctl show jeju-gateway-worker.service -p WorkingDirectory -p ExecStart

# AWS
systemctl show jeju-dws.service -p WorkingDirectory -p ExecStart
```

If the service points at legacy trees (`/home/ubuntu/jeju-repo` or `/home/ubuntu/jeju`), your monorepo pull will not be reflected live.

## 3.2) Frontend Artifact Checks (Before DWS Cutover)

When `jeju-dws` runs from monorepo source (`bun run api/server/index.ts`), the server still needs built frontend assets for `/provider` and SPA routes.

Run on AWS before restart:

```bash
cd /home/ubuntu/jeju-monorepo
/home/ubuntu/.bun/bin/bun install --ignore-scripts
cd /home/ubuntu/jeju-monorepo/apps/dws
/home/ubuntu/.bun/bin/bun run build.web.ts
test -f dist/index.html
test -d dist/web
```

Expected:
- `dist/index.html` exists
- `dist/web/*` bundle exists
- `https://jeju-dws.fartbag.fun/provider/` returns `200` after restart

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
  - for monorepo DWS runtime, always run `apps/dws build.web.ts` before restart
7. Re-run health + proof + node listing gates.
8. Open upstream PR only after both hosts pass smoke tests.

### Monorepo Runtime Prerequisite

If services run from monorepo source entrypoints (for example `bun run api/worker.ts` or `bun run api/server/index.ts`), workspace package resolution must be valid on host:

- `bun install` completed at monorepo root
- workspace packages required by runtime are resolvable
- if package exports require `dist/`, that `dist` exists (or package provides `"bun"` source export)

If this prerequisite fails, either:
- build the required workspace packages first, or
- temporarily rollback service to known-good legacy runtime and treat monorepo cutover as a separate tracked change.

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
