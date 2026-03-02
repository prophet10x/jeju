# Codex -> Claude Notes

Last updated: 2026-03-01

## Update Log

### 2026-03-01 02:00 UTC

- This file is intended as a rolling handoff log.
- New findings should be appended as new timestamped entries instead of replacing older notes.
- Current DWS registration refactor status:
  - dedicated route added at `/provider/node/register`
  - registration CTAs in Settings, Earnings, and Node dashboard now point to the dedicated route
  - `RunNode` is being treated as the informational/setup page, not the transaction page
  - the wizard still exposes more fields than the contract hook persists
  - DWS-wide typecheck is still blocked by unrelated pre-existing errors outside the touched registration files

### 2026-03-01 03:00 UTC

- Route split status:
  - added `apps/dws/web/pages/provider/RegisterNode.tsx`
  - wired `/provider/node/register` in `apps/dws/web/App.tsx`
  - replaced the embedded wizard on `RunNode` with a CTA card linking to the dedicated route
  - updated registration CTAs in `Settings`, `Earnings`, and `NodeOperatorDashboard`
- Current local-only files touched by this work:
  - `apps/dws/web/App.tsx`
  - `apps/dws/web/components/NodeRegistrationWizard.tsx`
  - `apps/dws/web/pages/Settings.tsx`
  - `apps/dws/web/pages/node/NodeOperatorDashboard.tsx`
  - `apps/dws/web/pages/provider/Earnings.tsx`
  - `apps/dws/web/pages/provider/RunNode.tsx`
  - `apps/dws/web/pages/provider/RegisterNode.tsx`
- Important: this is not deployed anywhere yet.
- Important: the registration wizard UI now has extra fields, but the current hook + contract path still only persists:
  - `stakingToken`
  - `stakeAmount`
  - `rewardToken`
  - `rpcUrl`
  - `region`
- Ownership / verification finding:
  - `packages/contracts/src/staking/NodeStakingManager.sol` ties node ownership to `msg.sender`
  - node id is derived from `msg.sender`, `rpcUrl`, and timestamp
  - there is no proof in this contract that the registrant actually controls the machine behind the RPC URL
  - so today it proves wallet ownership of the stake, not operational ownership of the endpoint
- Verification status:
  - broad DWS typecheck still fails on unrelated pre-existing errors
  - targeted checks surfaced mostly formatter-only issues after the route split
- Remaining work if you want the full feature finished:
  1. decide whether the DWS wizard should be the single source of truth vs Gateway `/gateway/nodes`
  2. unify the metadata model so name / zone / hardware / service selection are actually persisted somewhere authoritative
  3. decide how endpoint ownership should be verified, if at all

## Local Repo

- Local checkout: `/Users/admin69/jeju/jeju`
- Remote: `origin=https://github.com/prophet10x/jeju`
- Upstream: `https://github.com/JejuNetwork/jeju.git`
- Local branch: `fresh-deploy`
- Local branch tracking was fixed to `origin/fresh-deploy`
- Local working tree has user edits in:
  - `apps/dws/web/App.tsx`
  - `apps/dws/web/components/NodeRegistrationWizard.tsx`
  - `apps/dws/web/pages/Settings.tsx`
  - `apps/dws/web/pages/node/NodeOperatorDashboard.tsx`
  - `apps/dws/web/pages/provider/RegisterNode.tsx`

## SSH / Hosts

- This Mac can authenticate to both servers.
- AWS DWS host:
  - Host: `52.206.203.24`
  - User: `ubuntu`
  - Role: dedicated DWS box
- Oracle public host:
  - Host: `192.9.153.231`
  - User: `ubuntu`
  - Role: public Jeju testnet services

## Live Infra Summary

### AWS (`52.206.203.24`)

- Hostname: `ip-172-31-43-248`
- Main live process:
  - `bun run api/server/index.ts`
  - cwd: `/home/ubuntu/jeju/apps/dws`
- Repo on box:
  - `/home/ubuntu/jeju`
  - branch: `fresh-deploy`
  - clean
  - HEAD matched local when checked: `ae2ad3dfb`
- Nginx routes:
  - default `80/443` -> `127.0.0.1:4030`
  - `jeju-dws.fartbag.fun` -> `127.0.0.1:4030`
  - `node1.fartbag.fun` -> `127.0.0.1:4030`
- Health:
  - `http://127.0.0.1:4030/health` returned healthy
- Important runtime issue:
  - `~/dws.log` showed failures hitting `https://jeju-testnet.fartbag.fun/indexer/api`
  - cache / SQLit related requests were returning `503`

### Oracle (`192.9.153.231`)

- Hostname: `jeju-node`
- Main repo on box:
  - `/home/ubuntu/jeju-repo`
  - branch: `fresh-deploy`
  - HEAD when checked: `6542317d6`
  - this does **not** match local/AWS head
- Additional dirs:
  - `/home/ubuntu/blockscout/docker-compose`
  - `/home/ubuntu/oracle-cloud`
  - `/home/ubuntu/PoWFaucet`
  - `/home/ubuntu/jeju-l2/alto`
- Docker services seen running:
  - `jeju-op-geth`
  - `jeju-op-node`
  - `jeju-op-batcher`
  - `blockscout` stack (`backend`, `frontend`, `blockscout-proxy`, db, redis)
- Non-docker app processes seen:
  - gateway worker from `/home/ubuntu/jeju-repo/apps/gateway`
  - faucet server from `/home/ubuntu/jeju-repo/apps/gateway`
  - indexer processes from `/home/ubuntu/jeju-repo/apps/indexer`
  - oauth3 from `/home/ubuntu/jeju-repo/apps/oauth3`
  - crucible from `/home/ubuntu/jeju-repo/apps/crucible`
  - PoW faucet app from `/home/ubuntu/PoWFaucet`
  - bundler from `/home/ubuntu/jeju-l2/alto`

## Oracle Nginx Routing Reality

- `jeju-testnet.fartbag.fun` is doing a lot of the public routing.
- Confirmed nginx routes:
  - `/explorer/` -> `127.0.0.1:5100`
  - `/faucet/` -> `127.0.0.1:8088`
  - `/gateway/api/faucet/` -> `127.0.0.1:4014/api/faucet/`
  - `/gateway/api/` -> `127.0.0.1:4013/api/`
  - `/gateway/health` -> `127.0.0.1:4013/health`
  - `/gateway/web/` -> static files in `/home/ubuntu/jeju-repo/apps/gateway/dist/web/`
  - `/gateway/` -> SPA in `/home/ubuntu/jeju-repo/apps/gateway/dist/`
  - `/oauth3/` -> `127.0.0.1:4200`
  - `/bundler` -> `127.0.0.1:4337`
- Important mismatch:
  - `/dws/` on Oracle nginx is a stub that returns `503 {"error":"service_unavailable"}`
  - `/indexer/graphql` on Oracle nginx is a stub that returns a canned empty GraphQL response

## Important Config Mismatch

- `packages/config/services.json` still points testnet DWS/indexer style traffic at:
  - `https://jeju-testnet.fartbag.fun/dws`
  - `https://jeju-testnet.fartbag.fun/indexer/...`
- But Oracle nginx currently stubs those endpoints instead of serving the real backends.
- This likely explains some of the AWS DWS runtime errors.

## Security Note

- Oracle bundler process was running with raw private keys on the process command line.
- This is visible via `ps`.
- That should be moved to env/file/secret handling.

## Oracle Untracked Files

These existed on Oracle in `~/jeju-repo` and were untracked:

- `packages/contracts/deployments/jeju-testnet-dws-infra.json`
  - empty, 0 bytes
- `packages/contracts/remappings.txt`
  - contains:
    - `account-abstraction/=lib/account-abstraction/contracts/`

## DWS Registration UX Work In Progress

Claude had started a route split for node registration. Current local state now reflects this:

- Added dedicated route:
  - `/provider/node/register`
- New page:
  - `apps/dws/web/pages/provider/RegisterNode.tsx`
- Route wired in:
  - `apps/dws/web/App.tsx`
- Settings node tab now links to dedicated registration page instead of opening the old modal:
  - `apps/dws/web/pages/Settings.tsx`
- Old Settings modal registration UI was removed
- `RunNode` page was changed so it stays a guide / marketing / setup page, with CTA to dedicated registration page:
  - `apps/dws/web/pages/provider/RunNode.tsx`
- Registration CTAs updated to point at `/provider/node/register` in:
  - `apps/dws/web/pages/provider/Earnings.tsx`
  - `apps/dws/web/pages/node/NodeOperatorDashboard.tsx`

## Important Limitation In Current Registration Flow

The new wizard UI now shows fields for:

- node name
- zone
- CPU cores
- memory
- disk
- custom stake amount above minimum

But the actual staking hook / contract write path only submits:

- `stakingToken`
- `stakeAmount`
- `rewardToken`
- `rpcUrl`
- `region`

Relevant file:

- `packages/ui/src/hooks/useNodeStaking.ts`

Specifically:

- `RegisterNodeParams` only has `rpcUrl` and `region` for metadata-like fields
- `registerNode(...)` only calls contract with:
  - `stakingToken`
  - `stakeAmount`
  - `rewardToken`
  - `rpcUrl`
  - `region`

So:

- name / zone / hardware are currently UI-only
- they are **not** persisted on-chain by the current hook
- if normalization with Gateway is required, this needs deeper design/backend/contract alignment, not just front-end work

## Verification Notes

- `bun run --cwd /Users/admin69/jeju/jeju/apps/dws typecheck` failed, but the failures were pre-existing DWS-wide issues outside this route split:
  - missing `env` properties in various deployment/app-router types
  - missing `@jejunetwork/durable-objects`
  - worker runtime type mismatches
  - other unrelated compile errors
- A targeted Biome check on the touched files showed:
  - the route split itself is in place
  - remaining complaints were mostly formatter style
  - one real a11y issue in the wizard label was fixed

## Likely Next Steps

1. Decide whether `/provider/node` should stay the informational page and `/provider/node/register` should be the only actual registration flow.
2. Decide how to unify DWS vs Gateway node registration:
   - purely UI/UX normalization
   - or real shared metadata / persistence semantics
3. Fix the service routing mismatch between AWS DWS and Oracle testnet endpoints.
4. Bring Oracle repo state in line with local/AWS if that divergence is accidental.

### 2026-03-01 04:05 UTC

- ERC-8004 research status:
  - official EIP found at `https://eips.ethereum.org/EIPS/eip-8004`
  - current status appears to be `Draft`
  - the current draft includes optional endpoint-domain verification and reserved wallet/verification metadata concepts
- Important repo alignment finding:
  - Jeju `IdentityRegistry` is ERC-721 + generic metadata and marketplace-style endpoint helpers
  - it supports `setMetadata`, `setAgentUri`, `setA2AEndpoint`, `setMCPEndpoint`, `setServiceType`, `setCategory`, `setX402Support`, and `heartbeat`
  - it does **not** currently expose the newer wallet-proof style methods from the draft EIP such as `setAgentWallet` / `getAgentWallet` / `unsetAgentWallet`
- Node staking + ERC-8004 finding:
  - `packages/contracts/src/staking/NodeStakingManager.sol` already has `registerNodeWithAgent(...)`

### 2026-03-01 05:05 UTC

- Important implementation note for Claude:
  - endpoint ownership proof is intentionally a hybrid model, not fully on-chain
  - on-chain pieces:
    - operator owns ERC-8004 identity NFT
    - operator sets delegated node wallet via `setAgentWallet(agentId, wallet)`
    - operator stakes/registers via `registerNodeWithAgent(...)`
  - off-chain piece:
    - claimed node endpoint must answer a fresh challenge and sign it with the delegated node wallet
  - reason this cannot be purely on-chain:
    - contracts cannot fetch arbitrary HTTP(S) endpoints or verify live server control directly
    - some off-chain verifier/oracle must observe the endpoint first
  - possible later hardening:
    - post verified challenge digests / uptime / slashing inputs on-chain through oracle flow
- Standalone `jeju-node start --all` status:
  - current DWS proof flow was originally DWS-host-first
  - now being extended so arbitrary standalone nodes can expose `/.well-known/jeju-node-proof.json`
  - first-pass approach is a tiny stateless proof server inside `apps/node/src/daemon`
  - node signs the challenge message it is handed using the existing secure signer / KMS-backed delegated wallet
  - DWS verifier should be updated to probe the node’s proof endpoint instead of assuming the DWS host owns the key
- Important deployment note:
  - current live testnet is not usable for the delegated-wallet proof flow until the upgraded `IdentityRegistry` with:
    - `setAgentWallet`
    - `getAgentWallet`
    - `unsetAgentWallet`
    is deployed on-chain
  - Claude should read this file before deploying any registration-flow changes

### 2026-03-01 05:30 UTC

- Heartbeat / slashing distinction in current Jeju codebase:
  - `IdentityRegistry.heartbeat(agentId)` is a lightweight liveness signal for discovery / `lastActivityAt`
  - it is not the same as staking performance updates
  - `NodeStakingManager.updatePerformance(...)` is the economic path that affects rewards
  - only authorized performance oracles can call `updatePerformance(...)`
- Current relevant contracts / code:
  - `packages/contracts/src/registry/IdentityRegistry.sol`
    - `heartbeat(agentId)` updates `lastActivityAt`
    - owner or delegated wallet may call it
  - `packages/contracts/src/staking/NodeStakingManager.sol`
    - `updatePerformance(...)` is oracle-only
    - rewards use `uptimeScore`, requests, response time
    - slashing is proposal/dispute/execute based, owner-controlled today
  - `packages/contracts/src/staking/MultiOracleConsensus.sol`
    - designed for 3+ authorized oracles to reach consensus before updating staking performance
  - `packages/contracts/src/staking/AutoSlasher.sol`
    - uses recorded performance history to propose slashes after sustained low uptime
    - off by default (`autoSlashingEnabled = false`)
  - `packages/monitoring/api/heartbeat.ts`
    - sends signed node heartbeat to explorer/gateway API
    - this is off-chain monitoring infrastructure, not direct on-chain staking update
- Design conclusion:
  - endpoint ownership proof during registration can be self-served by the node because the verifier is checking a fresh challenge against the live endpoint
  - uptime / reward / slashing should NOT rely on self-reported node data alone
  - for testnet, the right rollout is:
    1. delegated-wallet endpoint proof for registration
    2. delegated-wallet identity heartbeat for liveness/discovery
    3. initially a Jeju-run verifier/oracle updates node performance
    4. later move to `MultiOracleConsensus` with 3+ verifiers
    5. only then enable automated slashing
- Important practical note:
  - there is not yet a fully wired pipeline from storage-node registration -> monitoring -> `updatePerformance(...)` -> `AutoSlasher`
  - that should be treated as a separate phase after registration/ownership proof is working

### 2026-03-01 05:45 UTC

- Performance oracle authorization finding:
  - `NodeStakingManager` performance updates are admin-authorized today, not permissionless
  - constructor seeds one authorized performance oracle address
  - owner can later add/remove more via `addPerformanceOracle` / `removePerformanceOracle`
  - there is no stake-based qualification inside `NodeStakingManager` for becoming a performance oracle
- `MultiOracleConsensus` is also owner-managed:
  - constructor takes an initial oracle set
  - requires at least 3
  - owner can add more with `addOracle`
  - still no automatic stake/reputation path in this contract
- Separate trust domains in repo:
  - `apps/node/api/lib/services/oracle.ts` is for a separate oracle-provider service using `ORACLE_STAKING_MANAGER_ABI`
  - that appears to be a price/oracle service path (`registerOracle`, `submitPrice`, `getOracleInfo`)
  - this is NOT the same as being authorized to call `NodeStakingManager.updatePerformance(...)`
  - there is stake in that oracle-provider path, but it does not currently imply node-performance-oracle authority
- Training-specific oracle code:
  - `packages/contracts/src/training/NodePerformanceOracle.sol` has owner-managed `authorizedReporters`
  - nodes can self-register for tracking there if already in `ComputeRegistry`
  - but metric reporters are still explicitly set by owner via `setReporter`
  - this looks training/compute-specific, not the general storage-node performance path
- Runtime implementation gap:
  - I did not find a production runtime service in the repo that continuously measures generic storage/DWS nodes and then calls:
    - `NodeStakingManager.updatePerformance(...)`, or
    - `MultiOracleConsensus.submitPerformance(...)`
  - what exists today is:
    - monitoring heartbeat script
    - some oracle-attestation patterns for specific services (e.g. torrent/CDN style)
    - tests that call `updatePerformance(...)` directly
  - so the on-chain role exists, but the full runtime pipeline is still incomplete

### 2026-03-01 05:55 UTC

- How to turn the Oracle-cloud Jeju box into a node-performance oracle on testnet:
  - Important: you do not authorize the machine/IP itself; you authorize an EVM signer address that runs on that host
  - recommended model:
    - create/use a dedicated oracle signer on the Oracle host
    - do NOT reuse the operator’s main wallet
    - do NOT tie this to the storage node delegated wallet unless you intentionally want one key to have both roles
- Contract authorization options:
  - simplest trusted-oracle path:
    - owner of `NodeStakingManager` calls `addPerformanceOracle(oracleSigner)`
    - then software on Oracle host using that signer can call `updatePerformance(...)`
  - multi-oracle path:
    - deploy/use `MultiOracleConsensus`
    - owner adds Oracle-host signer with `addOracle(oracleSigner)`
    - `NodeStakingManager` must trust the `MultiOracleConsensus` contract address as a performance oracle
- Repo status:
  - the contract authorization half already exists
  - the generic runtime reporter for storage/DWS nodes does not look complete yet
  - so “make the Oracle host an oracle” currently means:
    1. choose signer
    2. authorize signer on-chain
    3. build/run reporter service that measures nodes and submits updates
- Suggested testnet-first approach:
  - use the Oracle host as a single trusted reporter first
  - keep it separate from user-run storage nodes
  - later add additional independent reporters and move to `MultiOracleConsensus`

### 2026-03-01 06:05 UTC

- Repo-wide reporting/daemon correction:
  - the repo DOES contain multiple reporting / heartbeat / attestation runtimes for specific services
  - the earlier “no reporting daemon” statement was too broad
  - the narrower claim that still appears true:
    - I have not found a generic production runtime for storage-node staking that measures nodes and submits to:
      - `NodeStakingManager.updatePerformance(...)`, or
      - `MultiOracleConsensus.submitPerformance(...)`
- Confirmed service-specific reporters / reporting loops:
  - `packages/monitoring/api/heartbeat.ts`
    - signed off-chain heartbeat to `/nodes/heartbeat`
  - `apps/dws/src/cdn/stats/node-reporter.ts`
    - `NodeStatsReporter`
    - gathers CDN/cache stats
    - gets oracle attestation
    - submits on-chain `reportStats(...)`
  - `apps/node/api/lib/services/hybrid-torrent.ts`
    - requests seeding oracle attestation
    - submits seeding report on-chain
  - `apps/node/api/lib/services/residential-proxy.ts`
    - periodic metrics reporting over websocket to coordinator
  - `apps/wallet/api/services/edge/index.ts`
    - periodic edge stats reporting to coordinator websocket
  - `apps/node/app/src-tauri/src/services/compute.rs`
    - sends heartbeat to DWS `/nodes/heartbeat`
  - `apps/gateway/api/oracle/node.ts`
    - runtime oracle node for price reports
    - signs and submits reports on-chain
- Contract-level service-specific performance paths also exist:
  - `packages/contracts/src/messaging/MessageNodeRegistry.sol`
  - `packages/contracts/src/rpc/MultiChainRPCRegistry.sol`
  - `packages/contracts/src/bandwidth/BandwidthRewards.sol`
  - `packages/contracts/src/rewards/UsageRewardDistributor.sol`
  - many of these have authorized reporter patterns, but I have not verified complete production daemons for each
- Practical takeaway:
  - Jeju has multiple reporting systems already
  - what is missing for THIS task is the storage-node / DWS registration -> staking-performance pipeline
  - it can link a staked node to an ERC-8004 agent id via `operatorAgentId`
  - the current DWS/UI staking hook does not expose or use that path yet
  - `setIdentityRegistry(...)` and `setRequireAgentRegistration(...)` already exist in the staking manager
- DWS architecture finding:
  - `apps/dws/api/decentralized/index.ts` already assumes DWS nodes are ERC-8004 identities
  - DWS discovery expects tags like `dws-storage` / `dws-compute`
  - DWS discovery expects metadata such as `dwsEndpoint`
  - `apps/dws/api/infrastructure/node-registry.ts` also reads richer metadata like specs / pricing / attestation / version from ERC-8004 entries
  - this is more expressive than the current staking flow, which only records rpcUrl + region on-chain
- Ownership-proof finding:
  - current node staking proves wallet ownership of the staked position, not ownership/control of the actual server endpoint
  - the cleanest existing primitive in-repo for stronger ownership is `packages/contracts/src/services/ProofOfCloudValidator.sol`
  - it lets an ERC-8004 agent request verification for a salted hardware id hash and store cloud/region verification after multisig signer approval
  - this is useful for proving “this wallet controls verified cloud hardware” but it still needs a bridge into the node-registration UX
- Uptime/reputation finding:
  - `packages/monitoring/api/heartbeat.ts` sends signed heartbeats to a node explorer API and gets back `uptime_score`
  - `NodeStakingManager.updatePerformance(...)` accepts uptime / requests / latency from authorized performance oracles
  - `packages/contracts/src/staking/MultiOracleConsensus.sol` can aggregate multiple oracle submissions before updating staking performance
  - `IdentityRegistry.heartbeat(...)` only updates `lastActivityAt`; it is not a full performance oracle system
- Recommended direction for node registration hardening:
  1. Require or strongly prefer ERC-8004 agent registration for node operators.
  2. Register the node stake through `registerNodeWithAgent(...)` instead of bare `registerNode(...)`.
  3. Store node capabilities and metadata on the linked ERC-8004 identity (services, specs, pricing, endpoint, zone/name), because DWS discovery already reads that model.
  4. Add endpoint-control proof in the registration handshake.
     - Minimum viable: signed challenge served from the claimed endpoint and verified against the staking/operator wallet.
     - Stronger for AWS/cloud nodes: use `ProofOfCloudValidator` to attest the linked agent/hardware.
  5. Feed uptime into staking rewards through the existing heartbeat -> explorer/oracle -> `updatePerformance(...)` path instead of trying to overload ERC-8004 metadata for live metrics.
- Practical implication for the AWS storage-node goal:
  - the AWS server can likely be registered as a storage node cleanly once the flow is changed to:
    - create/link ERC-8004 identity
    - publish `dws-storage` + endpoint/spec metadata
    - prove endpoint control
    - optionally prove cloud hardware via PoC validator
    - stake/register through `NodeStakingManager.registerNodeWithAgent(...)`

### 2026-03-01 04:40 UTC

- Added design doc:
  - `docs/NODE_REGISTRATION_HARDENING.md`
- This doc captures the current recommended direction for fixing node registration:
  - use ERC-8004 identity as the operator/node identity layer
  - use `NodeStakingManager` as the economic/staking layer
  - prefer `registerNodeWithAgent(...)` over bare `registerNode(...)`
  - keep live uptime/performance in the heartbeat -> oracle -> staking flow rather than in ERC-8004 metadata
  - add endpoint-control challenge verification during registration
  - optionally layer `ProofOfCloudValidator` on top for stronger cloud/hardware trust
- Draft ERC-8004 wallet-method recommendation:
  - if Jeju later adds `setAgentWallet` / `getAgentWallet` / `unsetAgentWallet`, use them to separate NFT ownership from the operational signer
  - that would let heartbeats and endpoint verification check an agent wallet instead of forcing `ownerOf(agentId)` to act as both asset owner and hot operator key
- Clarification on Proof-of-Cloud:
  - it is not the basic endpoint proof
  - it is the stronger trust layer for verified cloud / attested hardware backing
  - especially useful for brokered or managed-capacity flows, but also useful for direct AWS node operators who want stronger trust signaling
- Local code changes now in progress for the registration flow:
  - `packages/ui/src/hooks/useNodeStaking.ts` now supports `registerNodeWithAgent(...)` via optional `operatorAgentId`
  - `apps/dws/web/components/NodeRegistrationWizard.tsx` now checks for an ERC-8004 operator identity and uses the agent-linked staking path when registering
  - gateway-side registration path was also started toward optional agent-linked registration:
    - `apps/gateway/web/hooks/useNodeStaking.ts`
    - `apps/gateway/web/components/RegisterNodeForm.tsx`
- Validation note:
  - `bunx biome check ...` could not be run in this environment because Bun could not write to tempdir (`AccessDenied`)
- Repo docs inventory clarification:
  - the earlier huge markdown count was not a useful Jeju-core number
  - after excluding vendored / embedded / imported trees like `workerd`, `sqlit`, patches, and generated package docs, the Jeju-owned markdown set is much smaller
  - current filtered count: `116` markdown files
  - docs site pages under `apps/documentation/docs/pages`: `85`
- Solidity inventory clarification:
  - first-party source contracts in `packages/contracts/src`: `357`
  - first-party solidity tests in `packages/contracts/test`: `112`
  - the live Jeju testnet uses a much smaller deployed subset defined in `packages/config/contracts.json` and described in `packages/contracts/DEPLOYMENT.md`
- Important deployed testnet contract categories to prioritize when reasoning about live behavior:
  - `registry.identity`
  - `registry.reputation`
  - `registry.validation`
  - `nodeStaking.*`
  - `dws.*`
  - `payments.*`
  - `compute.*`
  - `moderation.*`
  - `liquidity.multiServiceStakeManager`
  - `cloud.proofOfCloudValidator`

## 2026-03-01 17:25 CVT - Secure Node Registration Architecture Pass

### What the codebase already has
- `IdentityRegistry.sol` is the ERC-721 / ERC-8004 identity layer. It already supports generic metadata, tags, A2A/MCP endpoints, service type, category, x402 support, and `heartbeat(agentId)`.
- `NodeStakingManager.sol` already supports `registerNodeWithAgent(...)`, `setIdentityRegistry(...)`, `setRequireAgentRegistration(...)`, `getNodesByAgent(...)`, and stores `operatorAgentId` on each node stake.
- `ERC8004ProviderMixin.sol` and `ProviderRegistryBase.sol` already give the storage/CDN/compute/provider registries a standard `registerWithAgent` / `requireAgentRegistration` pattern.
- `StorageProviderRegistry.sol` and `DWSProviderRegistry.sol` both already accept an ERC-8004 agent ID and store `attestationHash` plus endpoint data.
- `ProofOfCloudValidator.sol` already gives a higher-trust cloud/hardware verification path tied to an ERC-8004 agent, with multisig signers, verification levels, expiry, and revocation.
- `packages/monitoring/api/heartbeat.ts` already sends signed heartbeats off-chain using KMS in production and local signing only in development.
- `NodeStakingManager.updatePerformance(...)` plus `MultiOracleConsensus.sol` form the current performance/reward path.

### The real gap
- The DWS registration UX is still centered on `NodeStakingManager` alone.
- The richer identity/provider/validation model exists in parallel, but the current DWS node-registration flow does not yet stitch them together into one authoritative process.
- Current ownership proof is only wallet ownership of the staked position. It does not prove control of the claimed endpoint/machine.
- The DWS wizard currently collects richer fields such as services / node name / zone / CPU / memory / disk, but those fields are not being written to any authoritative on-chain or verified off-chain store yet.

### Important code facts
- `IdentityRegistry` does NOT currently implement draft-style wallet delegation methods like `setAgentWallet/getAgentWallet/unsetAgentWallet`.
- Because of that, all current agent checks still effectively reduce to `ownerOf(agentId) == msg.sender` or NFT approvals.
- `useAgentId()` in DWS currently fetches `/a2a/agents` and then picks the first agent owned by the wallet. That is weak for operators with multiple identities and should eventually become an explicit selector.
- DWS API staking routes already expose `operatorAgentId` from `NodeStakingManager`, so the dashboard/API side is aware of agent-linked node stakes.

### Recommended architecture
1. ERC-8004 agent identity is the operator identity and metadata anchor.
2. `NodeStakingManager` remains the economic staking / reward / slashing contract for the node stake.
3. Provider/service registries remain the capability-specific discovery registries where needed (`StorageProviderRegistry`, `DWSProviderRegistry`, etc.).
4. Add endpoint-control challenge verification to prove the registrant controls the advertised endpoint.
5. Optionally add `ProofOfCloudValidator` for stronger cloud-backed or brokered trust.
6. Feed liveness / uptime through signed heartbeat + oracle reporting instead of trying to make ERC-8004 itself the uptime system.

### What should happen for an AWS storage node
1. Create/select the operator ERC-8004 identity.
2. Register the node stake via `registerNodeWithAgent(...)`.
3. Publish node metadata on the ERC-8004 identity, at minimum endpoint + service tags + hardware/profile metadata.
4. Verify endpoint control using a signed challenge served by the AWS node.
5. Optionally request Proof-of-Cloud verification for stronger trust.
6. Run signed heartbeat / performance reporting for ongoing uptime and rewards.

### Wallet-method recommendation
If Jeju adds draft-style delegated wallet methods to `IdentityRegistry`, use them like this:
- NFT owner wallet = long-term identity owner / cold wallet.
- Agent wallet = operational signer for endpoint challenge, heartbeats, and day-to-day node operation.
- This is the right model for KMS-backed operation, hot-wallet rotation, and broker / managed infra use cases.

Without those methods, the current fallback is:
- require ERC-8004 identity,
- use `registerNodeWithAgent(...)`,
- verify endpoint control against the connected wallet / current NFT owner,
- later extend the registry with delegated operational wallet support.

### Docs drift found
- The docs under `apps/documentation` still describe some older direct registry flows (for example, storage guides focusing on `StorageProviderRegistry` and old staking amounts).
- The code now has agent-linked node staking and richer provider registries, but the docs are not consistently updated to reflect the newer integrated design.
- This docs drift is likely one reason the Gateway flow, DWS flow, and contract expectations feel inconsistent.

## 2026-03-01 Service Card Contract Coverage

The DWS  page advertises 20 provider/service cards, but the backing contract maturity is uneven.

Strong or mostly real on-chain provider systems found:
- VPN Node:  with register, heartbeat, session accounting, and slash.
- CDN Edge:  with provider/node registration and slash.
- Storage Node:  plus  and .
- RPC Provider: , , , .
- Compute Node / GPU Compute: , , , .
- Data Availability:  with heartbeat and slashing.
- Email Relay:  with metrics and slashing.
- Generic DWS provider fallback:  with service enums, heartbeat, and slashing.

More partial / generic / not obviously a full permissionless node market:
- Serverless Workers / V8 Isolates: worker contracts exist, but they are workload registries/billing infra more than unified operator node staking.
- Git Repository:  is repo ownership/metadata, not a node operator reward/slash system.
- Package Registry:  is package ownership/metadata, not a node operator reward/slash system.
- S3 Storage: mostly overlaps storage/DWS infra; no clearly separate dedicated S3 provider market surfaced.
- AI Agent Host: ERC-8004 identity exists, but no dedicated agent-host staking registry surfaced in the same style.

Mostly UI/off-chain/generic today from this pass:
- CI/CD Runner
- Load Balancer
- Indexer Node
- Web Scraper
- Security Node
- Observability

Important product implication:
- The card list on  currently overstates uniform readiness.
- The node registration wizard service selection is also not yet authoritatively persisted in the core node staking path.
- For near-term work, the most credible path is to focus on Storage/RPC/Compute/CDN/DA-style providers first, using ERC-8004 identity +  + endpoint challenge + heartbeat/oracle performance.

## 2026-03-01 Service Card Contract Coverage

The DWS `/provider/node` page advertises 20 provider/service cards, but the backing contract maturity is uneven.

Strong or mostly real on-chain provider systems found:
- VPN Node: `packages/contracts/src/vpn/VPNRegistry.sol` with register, heartbeat, session accounting, and slash.
- CDN Edge: `packages/contracts/src/cdn/CDNRegistry.sol` with provider/node registration and slash.
- Storage Node: `packages/contracts/src/storage/StorageProviderRegistry.sol` plus `StorageMarket.sol` and `StorageManager.sol`.
- RPC Provider: `packages/contracts/src/staking/NodeStakingManager.sol`, `AutoSlasher.sol`, `rpc/RPCProviderRegistry.sol`, `rpc/MultiChainRPCRegistry.sol`.
- Compute Node / GPU Compute: `packages/contracts/src/compute/ComputeRegistry.sol`, `ComputeRental.sol`, `WorkerRegistry.sol`, `CronTriggerRegistry.sol`.
- Data Availability: `packages/contracts/src/da/DAOperatorRegistry.sol` with heartbeat and slashing.
- Email Relay: `packages/contracts/src/email/EmailProviderStaking.sol` with metrics and slashing.
- Generic DWS provider fallback: `packages/contracts/src/dws/DWSProviderRegistry.sol` with service enums, heartbeat, and slashing.

More partial / generic / not obviously a full permissionless node market:
- Serverless Workers / V8 Isolates: worker contracts exist, but they are workload registries/billing infra more than unified operator node staking.
- Git Repository: `packages/contracts/src/git/RepoRegistry.sol` is repo ownership/metadata, not a node operator reward/slash system.
- Package Registry: `packages/contracts/src/pkg/PackageRegistry.sol` is package ownership/metadata, not a node operator reward/slash system.
- S3 Storage: mostly overlaps storage/DWS infra; no clearly separate dedicated S3 provider market surfaced.
- AI Agent Host: ERC-8004 identity exists, but no dedicated agent-host staking registry surfaced in the same style.

Mostly UI/off-chain/generic today from this pass:
- CI/CD Runner
- Load Balancer
- Indexer Node
- Web Scraper
- Security Node
- Observability

Important product implication:
- The card list on `apps/dws/web/pages/provider/RunNode.tsx` currently overstates uniform readiness.
- The node registration wizard service selection is also not yet authoritatively persisted in the core node staking path.
- For near-term work, the most credible path is to focus on Storage/RPC/Compute/CDN/DA-style providers first, using ERC-8004 identity + `registerNodeWithAgent(...)` + endpoint challenge + heartbeat/oracle performance.

## 2026-03-01 Targeted Solidity Sweep For Node Registration

Status:
- Did not read every Solidity contract in the repo end-to-end.
- Did complete a targeted sweep of the contracts that can materially overlap node registration, provider registration, staking, validation, and storage payments.

Read and relevant:
- `packages/contracts/src/staking/NodeStakingManager.sol`
- `packages/contracts/src/staking/AutoSlasher.sol`
- `packages/contracts/src/staking/MultiOracleConsensus.sol`
- `packages/contracts/src/staking/MultiServiceStakeManager.sol`
- `packages/contracts/src/staking/ServiceStaking.sol`
- `packages/contracts/src/registry/IdentityRegistry.sol`
- `packages/contracts/src/registry/interfaces/IIdentityRegistry.sol`
- `packages/contracts/src/registry/ERC8004ProviderMixin.sol`
- `packages/contracts/src/registry/ProviderRegistryBase.sol`
- `packages/contracts/src/registry/ValidationRegistry.sol`
- `packages/contracts/src/services/ProofOfCloudValidator.sol`
- `packages/contracts/src/dws/DWSProviderRegistry.sol`
- `packages/contracts/src/dws/DWSMarketplace.sol`
- `packages/contracts/src/dws/DWSBilling.sol`
- `packages/contracts/src/dws/DWSServiceProvisioning.sol`
- `packages/contracts/src/storage/StorageProviderRegistry.sol`
- `packages/contracts/src/storage/StorageMarket.sol`
- `packages/contracts/src/storage/StorageManager.sol`
- `packages/contracts/src/storage/StorageProofs.sol`

Key overlap findings:
- There is no existing first-class on-chain endpoint ownership proof for `rpcUrl` / provider endpoint control in the node registration path.
- ERC-8004 support is present and reusable for linking a wallet/operator identity to provider registries and node staking.
- `NodeStakingManager.registerNodeWithAgent(...)` is the clean staking entrypoint for operator-linked node registration.
- `IdentityRegistry` already supports endpoint fields, tags, metadata, serviceType/category, and heartbeat.
- `StorageProviderRegistry.registerWithAgent(...)` exists, but the current DWS/browser registration UX is not wired to it and testnet config use appears centered around `NodeStakingManager` + generic DWS pieces.
- `DWSProviderRegistry.registerProviderWithAgent(...)` also exists, with heartbeat and slashing, but the current DWS wizard is not using it authoritatively.
- `ValidationRegistry` and `ProofOfCloudValidator` support validator attestations / cloud verification, not endpoint ownership proof.
- `StorageProofs` is about post-registration storage challenge/proof behavior, not initial endpoint ownership.
- Draft-style ERC-8004 wallet methods such as `setAgentWallet/getAgentWallet/unsetAgentWallet` are not implemented in the current Jeju `IdentityRegistry`.

Conclusion for first shipped path:
- Avoid a first-pass Solidity migration if possible.
- Use existing contracts for:
  - operator identity: `IdentityRegistry`
  - stake/economics: `NodeStakingManager.registerNodeWithAgent(...)`
  - metadata/discovery: ERC-8004 tags + metadata + endpoints
  - monitoring: heartbeat/oracle path
  - optional stronger trust: `ProofOfCloudValidator`
- Add the missing endpoint-control handshake off-chain in app/server code.

## 2026-03-01 Minimal Storage Node Model (Frozen For First Pass)

Goal:
- Get one real AWS DWS node registered as a Jeju storage node on testnet with a defensible ownership check.

First-pass authoritative model:
1. Operator has an ERC-8004 identity NFT.
2. Registration flow requires selecting that operator identity.
3. User enters node endpoint URL for the AWS DWS instance.
4. Registration backend issues a challenge tied to:
   - wallet address
   - operator agent ID
   - endpoint URL
   - nonce + expiry
5. Wallet signs the challenge.
6. The AWS DWS node serves a proof document at a well-known path containing the challenge payload and wallet signature.
7. Registration backend fetches that proof back from the claimed endpoint and verifies:
   - challenge matches
   - signature recovers the registering wallet
   - wallet owns the selected agent ID
   - endpoint actually served the proof
8. After proof passes, UI allows on-chain staking via `registerNodeWithAgent(...)`.
9. UI then writes/storage-oriented metadata to ERC-8004 for discovery:
   - tags: at minimum `dws-node`, `dws-storage`
   - metadata: region, zone, cpu, memory, disk, version, optional pricing
   - endpoint via `setA2AEndpoint` or `setEndpoints`
10. Existing heartbeat/oracle paths handle liveness/performance after registration.

Implications:
- This first pass does NOT yet normalize every card/service on `/provider/node`.
- It should be narrowed to storage-node-first behavior until broader contract/monitoring alignment exists.
- It should not touch Oracle deployment yet.

## 2026-03-01 Operator Wallet vs Node Key / KMS Findings

Important architecture finding:
- The user is correct that the node should not need the operator's primary wallet private key.
- Jeju already points in the direction of dedicated node/service keys managed through KMS.

Evidence in code:
- `apps/node/src/daemon/index.ts` requires `KMS_KEY_ID` on testnet/mainnet for node daemon usage.
- `apps/dws/web/pages/security/Keys.tsx` exposes KMS key creation/listing in the DWS UI.
- `apps/dws/api/server/routes/kms.ts` implements key creation, listing, signing, and secret storage.
- `apps/dws/api/shared/kms-wallet.ts` provides a viem-compatible wallet client that signs via KMS.

Current limitation:
- There is not yet a clean secure delegation model in the registration path saying:
  - operator wallet owns the ERC-8004 identity and stake
  - node uses a separate KMS-backed signer for endpoint proof / heartbeats
  - operator explicitly authorizes that node signer
- Draft ERC-8004 methods like `setAgentWallet/getAgentWallet/unsetAgentWallet` are not implemented in Jeju.

Recommended first-pass design adjustment:
1. Operator wallet remains the on-chain owner of the ERC-8004 identity and performs staking/registration.
2. Node runs with its own KMS-backed signer or dedicated node wallet.
3. Registration proof binds the two together:
   - operator wallet signs an authorization linking endpoint + agentId + node signer address/key
   - node endpoint serves a proof signed by the node signer
   - verifier checks both signatures before allowing final registration
4. Subsequent heartbeats / service proofs should be allowed to come from the delegated node signer, not the primary operator wallet.

This is a better fit for multi-node operators and safer than requiring the primary wallet on every machine.

## 2026-03-01 IdentityRegistry Delegated Wallet Support Implemented

Status:
- `local only`
- Not deployed to AWS or Oracle yet.

What changed:
- Added draft-style delegated wallet methods to the ERC-8004 interface:
  - `setAgentWallet(uint256 agentId, address wallet)`
  - `getAgentWallet(uint256 agentId)`
  - `unsetAgentWallet(uint256 agentId)`
- Files changed:
  - `packages/contracts/src/registry/interfaces/IIdentityRegistry.sol`
  - `packages/contracts/src/registry/IdentityRegistry.sol`
  - `packages/contracts/test/compute/ComputeRegistryIntegration.t.sol`
  - `packages/contracts/test/RegistryIntegration.t.sol`
  - `packages/contracts/test/registry/IdentityRegistry.t.sol`

Behavior changes in `IdentityRegistry`:
- Added on-chain delegated operational wallet storage per agent.
- `setAgentWallet` / `unsetAgentWallet` are owner-or-approved only.
- `getAgentWallet` reverts if the agent does not exist.
- Delegated wallet is cleared automatically on NFT transfer.
- Delegated wallet is cleared automatically on burn.
- Cached `agents[agentId].owner` is now updated on transfer and cleared on burn.
- `heartbeat(agentId)` now accepts either:
  - the agent owner, or
  - the delegated wallet set via `setAgentWallet`
- Contract `version()` bumped from `2.1.0-marketplace` to `2.2.0-marketplace`.

Important reason for this pass:
- Before this change, `agents[agentId].owner` could become stale after ERC-721 transfer because `_update(...)` did not sync the cached owner field.
- That stale-owner issue would make delegated operational authority unsafe.

Targeted verification completed:
- Command run:
  - `forge test --match-path test/registry/IdentityRegistry.t.sol --match-test test -vv`
- Result:
  - 4 tests passed, 0 failed
- New tests cover:
  - set/get/unset delegated wallet
  - delegated wallet heartbeat
  - transfer clears delegated wallet and updates cached owner
  - only owner can set delegated wallet

Notes for next implementation step:
- `NodeStakingManager.registerNodeWithAgent(...)` still intentionally requires the operator wallet to perform the stake/register transaction.
- The delegated wallet is now available for node-side operational proof/liveness work.
- Next step is app/server wiring:
  - registration UI must prompt for or derive the node wallet
  - operator must call `setAgentWallet(...)` before proof/registration completes
  - DWS/node flow should use the delegated wallet for endpoint proof and heartbeat, not the primary wallet on the server

## 2026-03-01 Storage Node Ownership Proof Wiring In Progress

Status:
- `local only`
- Not deployed to AWS or Oracle
- Contract changes above are assumed locally; current testnet deployment still needs the IdentityRegistry upgrade before this flow can work end-to-end on AWS

What was added locally:

Backend:
- New DWS router: `apps/dws/api/server/routes/node-registration.ts`
- Mounted in `apps/dws/api/server/index.ts`
- Added reusable KMS service-key helpers in `apps/dws/api/server/routes/kms.ts`

New backend flow:
1. `POST /node-registration/challenge`
   - validates operator wallet owns the selected ERC-8004 identity
   - normalizes the claimed endpoint
   - derives/creates a dedicated DWS service key for node proof signing
   - returns:
     - challenge ID
     - operator authorization message
     - node proof message
     - delegated node wallet address
     - proof document URL
     - current on-chain delegated wallet (if contract supports it)
2. `GET /.well-known/jeju-node-proof.json?challengeId=...`
   - serves a signed proof document from the endpoint itself
   - uses the dedicated DWS service key, not the operator wallet
3. `POST /node-registration/verify`
   - verifies operator signature
   - verifies the delegated wallet is authorized on-chain via `getAgentWallet(...)`
   - fetches the proof document back from the claimed endpoint
   - verifies the endpoint proof signature from the delegated wallet

Frontend:
- Updated `apps/dws/web/components/NodeRegistrationWizard.tsx`
- New stake-step ownership subflow:
  1. prepare proof
  2. discover delegated node wallet
  3. call `setAgentWallet(...)` if the agent is not yet bound to that wallet
  4. verify endpoint ownership
  5. only then allow continue to approve/register
- Confirm step now also shows the delegated node wallet when proof verification succeeded

Important current limitation:
- This first pass is optimized for the AWS DWS-hosted node path because the proof document is being served by the DWS server itself.
- It is not yet a full standalone `jeju-node start --all` proof route for arbitrary third-party nodes.
- That standalone node-daemon integration is still a follow-up if needed.

Important deployment implication:
- The proof flow now depends on the new IdentityRegistry delegated wallet methods:
  - `setAgentWallet`
  - `getAgentWallet`
  - `unsetAgentWallet`
- Until the upgraded IdentityRegistry is deployed on the target network, the UI/backend will correctly report that delegated-wallet verification cannot complete on that deployment.

Verification notes:
- Repo-wide `bun x tsc --noEmit` in `apps/dws` is already failing on many unrelated baseline issues (missing durable-objects package, unrelated type mismatches, missing `env` fields, etc.)
- Grepping the compiler output for the touched files showed no TypeScript errors emitted for:
  - `apps/dws/web/components/NodeRegistrationWizard.tsx`
  - `apps/dws/api/server/routes/node-registration.ts`
  - `apps/dws/api/server/routes/kms.ts`
  - `apps/dws/api/server/index.ts`

Next step if continuing locally:
- either add the standalone node-daemon proof endpoint path
- or stop here and hand AWS deployment / contract rollout / live verification to Claude

Measurement / docs alignment notes:
- `NodeStakingManager` currently accepts only three raw performance inputs:
  - `uptimeScore`
  - `requestsServed`
  - `avgResponseTime`
- See:
  - `packages/contracts/src/staking/NodeStakingManager.sol`
  - `packages/contracts/src/staking/MultiOracleConsensus.sol`
  - `packages/contracts/src/staking/AutoSlasher.sol`
- Actual current reward logic in `NodeStakingManager`:
  - uses uptime multiplier
  - uses request-volume bonus
  - uses geographic bonus
  - optionally uses token-diversity bonus
  - stores `avgResponseTime` but does not currently use it in reward calculation
- Actual current generic slashing logic in `AutoSlasher`:
  - based only on monthly uptime history
  - 3 months below 95% -> 10%
  - 2 months below 90% -> 25%
  - 1 month below 80% -> 50%
  - disabled by default
- `MultiOracleConsensus` aggregates the same 3 fields with:
  - minimum 3 authorized oracles
  - 1 hour submission window
  - 5% tolerance
  - median aggregation
- Relevant Jeju docs do mention monitoring/rewards/slashing, but some are ahead of the code:
  - `apps/documentation/docs/pages/contracts/staking.mdx`
  - `apps/documentation/docs/pages/guides/run-rpc-node.mdx`
  - `apps/documentation/docs/pages/operate/rpc-node.mdx`
  - `apps/documentation/docs/pages/guides/run-storage-node.mdx`
  - `apps/documentation/docs/pages/operate/storage-node.mdx`
- Important docs mismatch:
  - docs describe a performance score weighted by uptime, latency, and request volume
  - docs describe specific RPC slashing thresholds like warning after 1 hour downtime / malicious responses slash 100%
  - current generic staking contracts do not implement that exact formula or those exact rules
  - current generic on-chain path is materially more uptime-centric than the docs imply

External storage network comparison:
- Filecoin:
  - proof/reporting is protocol-native, not just app-level stats
  - storage providers must submit WindowPoSt on-chain each proving period
  - missed proofs cause slashing / power reduction
  - payments are tied to storage deals and protocol incentives, not just HTTP request counters
  - reference docs:
    - `https://docs.filecoin.io/storage-providers/filecoin-economics/storage-proving`
    - `https://docs.filecoin.io/storage-providers/filecoin-deals/verified-deals`
    - `https://docs.filecoin.io/smart-contracts/programmatic-storage/ccdb`
- Storj:
  - payout is monthly and based on actual storage usage + egress + audit/repair bandwidth
  - node health is managed operationally through audits/suspension/disqualification rather than a generic staking contract
  - payout docs are explicit about paying for used storage, egress, audit, repair
  - reference docs:
    - `https://storj.dev/node/payouts`
- Sia:
  - economic core is storage contracts, collateral, and host/renter settlement
  - hosts are paid after proving successful storage for the contract period
  - payments include storage + bandwidth and are enforced through the storage-contract model
  - reference docs:
    - `https://docs.sia.tech/store-your-data/about-renting`
    - `https://docs.sia.tech/miscellaneous/learn-about-siafunds`
    - `https://docs.sia.tech/provide-storage/configuring-your-host`
- BTFS:
  - has an explicit node dashboard with cheques + online proof
  - newer online proof flow is off-chain collection + merkle root on-chain
  - storage host payouts use contract/cheque model rather than generic request counters
  - reference docs:
    - `https://docs.btfs.io/docs/online-proof`
    - `https://docs.btfs.io/docs/btfs-dashboard`
    - `https://docs.btfs.io/v3.0.0/docs/btfs-overview`
- Autonomi / MaidSafe:
  - docs emphasize rewards for storing/serving data reliably over time, paid to an EVM wallet
  - current public docs are higher level than Filecoin/Sia on exact reporting mechanics
  - reference docs:
    - `https://docs.autonomi.com/node`
    - `https://docs.autonomi.com/how-it-works/fully-autonomous-data-network/nodes`
    - `https://docs.autonomi.com/token`

Jeju storage/payment reality:
- Jeju has multiple parallel storage/payment models that are not normalized:
  - `packages/contracts/src/storage/StorageMarket.sol`
    - on-chain storage deals with provider confirmation/completion and settlement
  - `packages/contracts/src/storage/FileStorageManager.sol`
    - direct per-file pinning/payment and revenue split
  - `packages/contracts/src/storage/StorageManager.sol`
    - upload/quota/permanent-storage tracking
  - `apps/dws/api/server/routes/s3.ts` + `apps/dws/api/storage/s3-backend.ts`
    - S3-compatible DWS storage path
- Important gap:
  - DWS S3/IPFS routes do not appear to be wired to `StorageMarket.createDeal(...)` or `FileStorageManager.pinFile(...)`
  - current S3 backend is an in-process compatibility layer over backend upload/download, not a settlement path
- Jeju also has a real x402 stack, but DWS uses it inconsistently:
  - real facilitator/verifier/settler exists in `apps/gateway/api/x402/*` and `packages/contracts/src/x402/*`
  - DWS API marketplace has internal paid-request accounting in `apps/dws/api/api-marketplace/*`
  - `apps/dws/api/api-marketplace/payments.ts` still contains a note that on-chain verification would happen “in production”
  - so the DWS API marketplace is not the same thing as end-to-end real x402 settlement for storage
- Consequence:
  - using `requestsServed` from current DWS storage routes as a staking reward input would be weak / gameable
  - x402-verified paid volume is the right eventual source of economic demand
  - but Jeju storage must first be wired so storage reads/writes actually go through either:
    - real x402 settlement, or
    - the storage-market / storage-contract path

Implementation recommendation:
- do not make storage-node rewards depend on DWS S3/IPFS request counters yet
- first normalize storage payments:
  1. choose canonical paid-storage path (`StorageMarket` vs x402-gated storage API)
  2. emit durable accounting for paid bytes stored / retrieved
  3. feed that accounting into storage-provider performance/rewards
- only after that, decide whether `NodeStakingManager` should:
  - keep generic `requestsServed`, or
  - be extended for storage-specific metrics like `bytesStored`, `bytesRetrieved`, and/or verified paid volume
- if aligning generic node staking with docs, `avgResponseTime` can be added to reward calculation sooner than request-volume reform because the field already exists in `NodeStakingManager`

Bootstrap storage / CDN design direction:
- user wants initial storage-node audit/bootstrap corpus to include Jeju repo and public ElizaOS GitHub content so early storage nodes can also function like a public CDN
- recommended split:
  - `bootstrap corpus`
    - immutable public artifacts only
    - examples: tagged release tarballs, docs bundles, package archives, static site assets
    - avoid arbitrary moving branch heads as the canonical audit corpus
  - `paid storage corpus`
    - user uploads / pinned objects / paid retrievals
    - must go through real x402 settlement for reward accounting
- important rule:
  - bootstrap CDN traffic should not be treated the same as paid demand for rewards
  - otherwise operators can game rewards by hammering free public assets
- better bootstrap model:
  1. define a versioned public corpus manifest
  2. chunk files deterministically
  3. assign chunks/replicas to providers
  4. run random chunk audits against that corpus
  5. use this for liveness/integrity testing and maybe small protocol-funded bootstrap rewards
  6. keep real economic rewards tied to x402-settled storage/retrieval volume

Storage audit design:
- each stored object should have:
  - object id / CID
  - encrypted content hash
  - size
  - chunk size
  - Merkle root or equivalent chunk commitments
  - assigned provider set
- verifier/oracle flow:
  1. choose random object and random chunk indexes
  2. request those chunks from the provider
  3. verify returned bytes against the commitments
  4. measure latency / availability
  5. record pass-fail + latency in provider metrics
- do not request full files for routine audits; sample chunks instead
- use repeated failed audits + stale heartbeat + sustained poor latency as slashing inputs

Practical bootstrap recommendation:
- for the initial free/public corpus, prefer:
  - Jeju release artifacts
  - Jeju docs static build assets
  - selected public ElizaOS release artifacts
  - other explicitly licensed public assets
- avoid using arbitrary repository snapshots as the live reward corpus because:
  - branch heads move
  - reproducibility is worse
  - provenance is less clean than tagged artifacts

Current rollout gate:
- do NOT enable the trusted storage reporter / performance-oracle service yet
- gating items before enabling it:
  1. storage upload/download path must enforce x402 or credits on the intended paid routes
  2. storage activity must be durably recorded for paid operations
  3. storage audit inputs / object commitments must exist, otherwise the oracle has nothing trustworthy to verify beyond liveness
- once those are in place, the first reporter can run as a trusted Jeju-operated verifier on the Oracle host later
## 2026-03-02 16:01:42 -01 storage x402 + audit progress
- local only
- Finished the first-pass paid storage path on the real DWS storage/IPFS routes.
- Upload routes now enforce credits/x402 for non-system tiers and record durable storage activity in SQLit via `storage_activity`.
- Added durable audit commitment persistence in SQLit via `storage_commitments`.
- Stored-object metadata now includes an `audit` commitment generated from the actual stored bytes (encrypted bytes for private content).
- Added storage audit helpers in `apps/dws/api/storage/audit.ts` and audit endpoints in `apps/dws/api/server/routes/storage.ts`:
  - `GET /storage/audit/:cid`
  - `GET /storage/audit/:cid/challenge?count=N`
  - `GET /storage/audit/:cid/prove?indices=0,5,9`
- Reporter/verifier should verify returned chunks locally with the shared helper in `apps/dws/api/storage/audit.ts`; do not trust server-side self-verification for scoring.
- Touched files:
  - `apps/dws/api/storage/audit.ts` (new)
  - `apps/dws/api/storage/multi-backend.ts`
  - `apps/dws/api/storage/types.ts`
  - `apps/dws/api/state.ts`
  - `apps/dws/api/server/routes/storage.ts`
- Validation:
  - `./node_modules/.bin/tsc -p apps/dws/tsconfig.json --pretty false` still has many pre-existing DWS errors unrelated to storage (deploy, durable-objects, workers, etc.).
  - Filtered typecheck output shows no remaining errors in the touched storage files.
- Important caveat:
  - `GET /storage/arweave/:txId` is still not x402-gated because the txId-to-primary-CID/accounting path is not normalized yet. This does not block the initial IPFS-backed storage-node test path.
- Deployment status:
  - not deployed to AWS yet
  - no Oracle changes
- Claude handoff:
  1. inspect these local changes
  2. validate paid upload/download on AWS DWS for IPFS-backed paths
  3. confirm `storage_activity` and `storage_commitments` rows are being written
  4. do not enable the storage reporter/oracle for scoring until the audit consumer is wired to use these endpoints and helpers

## 2026-03-02 16:10:00 -01 scoring + slashing reality check

- local only
- Checked whether the scoring/slashing logic already exists for generic node staking.
- What already exists:
  - `packages/contracts/src/staking/NodeStakingManager.sol`
    - `updatePerformance(nodeId, uptimeScore, requestsServed, avgResponseTime)`
    - rewards currently use:
      - uptime multiplier
      - request-volume bonus
      - geographic bonus
      - optional token-diversity bonus
    - `avgResponseTime` is stored but is NOT used in the reward calculation today
  - `packages/contracts/src/staking/AutoSlasher.sol`
    - slashing exists for generic node staking
    - it is uptime-only and month-based:
      - 3 months below 95% -> 10%
      - 2 months below 90% -> 25%
      - 1 month below 80% -> 50%
    - requires explicit enablement
    - not wired to storage audits
  - `packages/contracts/src/staking/MultiOracleConsensus.sol`
    - aggregates the same 3 fields from multiple oracles, then calls `stakingManager.updatePerformance(...)`
  - `packages/contracts/src/registry/PerformanceMetrics.sol`
    - reusable scoring library exists
    - includes uptime, success rate, latency, throughput, requests served, bytes served
    - not used by `NodeStakingManager` reward math today
- Important mismatch:
  - docs in `apps/documentation/docs/pages/contracts/staking.mdx` and `apps/documentation/docs/pages/guides/run-rpc-node.mdx` describe a weighted uptime/latency/request model and warning-based slashing
  - the deployed generic staking contracts do NOT implement that exact doc formula/policy
- Bottom line:
  - slashing code already exists, but only for generic uptime history
  - score update path already exists, but there is no finished mapping from storage audit results -> `uptimeScore`, `requestsServed`, `avgResponseTime`
  - there is also no generic storage-audit reporter feeding `updatePerformance(...)` yet
- Recommended next implementation path:
  1. build storage reporter/verifier service
  2. map storage audits to the existing 3 generic fields in a first pass
  3. run in dry-run / observe-only mode first
  4. only then enable on-chain scoring submissions
  5. leave `AutoSlasher` disabled until the audit-based metrics are stable

## 2026-03-02 17:05:00 -01 storage reporter implemented locally

- local only
- Implemented the first-pass storage reporter/verifier in Gateway so Claude can deploy it later on Oracle without touching the DWS node code again.
- New reporter files:
  - `apps/gateway/api/oracle/storage-audit-verifier.ts`
  - `apps/gateway/api/oracle/storage-reporter.ts`
- Gateway exports/scripts updated:
  - `apps/gateway/api/oracle/index.ts`
  - `apps/gateway/package.json`
- Added package scripts:
  - `bun run start:storage-reporter`
  - `bun run start:storage-reporter:once`

What the reporter does:
- reads active nodes from `NodeStakingManager.getAllNodes()` + `getNodeInfo()`
- resolves a storage base URL from `node.rpcUrl` or explicit endpoint overrides
- calls the new DWS audit endpoints:
  - `GET /storage/health`
  - `GET /storage/activity/summary`
  - `GET /storage/audit`
  - `GET /storage/audit/:cid/challenge`
  - `GET /storage/audit/:cid/prove`
- verifies returned chunk proofs locally in Gateway using `storage-audit-verifier.ts`
- maps results into the existing generic staking fields:
  - `uptimeScore`
    - first-pass formula:
      - 40% storage health success
      - 60% verified challenged chunks / challenged chunks
  - `requestsServed`
    - first-pass source: rolling paid operations count from `/storage/activity/summary?sinceHours=...`
  - `avgResponseTime`
    - first-pass source: average proof-request latency, falling back to storage health latency if there were no proofs
- optionally submits `updatePerformance(...)` on-chain
- optionally calls `AutoSlasher.checkAndProposeSlashing(...)`
- optionally attempts `AutoSlasher.executeSlashing(...)` if a proposal exists and is already executable

Important policy/implementation notes:
- this is intentionally a FIRST PASS mapping for storage into the generic staking contract
- it does NOT change contract reward math
- `avgResponseTime` is still not used by `NodeStakingManager` rewards today
- `AutoSlasher` is still the existing uptime-only/month-based policy
- the reporter just wires the current contract surface; it does not redesign slashing economics

Environment flags for Claude:
- `STORAGE_REPORTER_SERVICE_ID`
  - default: `storage-reporter`
- `STORAGE_REPORTER_RPC_URL`
  - optional override for L2 RPC
- `STORAGE_REPORTER_POLL_INTERVAL_MS`
  - default: 15 minutes
- `STORAGE_REPORTER_REQUEST_TIMEOUT_MS`
  - default: 15000
- `STORAGE_REPORTER_LOOKBACK_HOURS`
  - default: 720 (30 days)
- `STORAGE_REPORTER_MAX_COMMITMENTS`
  - default: 5
- `STORAGE_REPORTER_CHUNK_COUNT`
  - default: 3
- `STORAGE_REPORTER_NODE_IDS`
  - optional allowlist of node IDs
- `STORAGE_REPORTER_ENDPOINT_OVERRIDES`
  - optional `nodeId=url;nodeId=url` mapping if `rpcUrl` is not the actual DWS storage base URL
- `STORAGE_REPORTER_SUBMIT_ON_CHAIN=true`
  - required to actually call `updatePerformance(...)`
- `STORAGE_REPORTER_REGISTER_AS_PERFORMANCE_ORACLE=true`
  - optional; attempts `addPerformanceOracle(self)` if the signer is the staking owner
- `STORAGE_REPORTER_ENABLE_AUTO_SLASHING=true`
  - optional; attempts `setAutoSlashingEnabled(true)` if the signer is the slasher owner
- `STORAGE_REPORTER_CHECK_SLASHING=true`
  - optional; calls `checkAndProposeSlashing(nodeId)` after a successful on-chain performance update
- `STORAGE_REPORTER_EXECUTE_SLASHING=true`
  - optional; attempts `executeSlashing(nodeId)` when a proposal is already executable
- `STORAGE_REPORTER_RUN_ONCE=true`
  - run a single cycle and exit

Signer behavior:
- reporter uses `createMigrationWalletClient(...)`
- KMS-first
- testnet fallback key:
  - `ORACLE_PRIVATE_KEY` or `PRIVATE_KEY`

Validation status:
- imported successfully via Bun:
  - `apps/gateway/api/oracle/storage-reporter.ts`
  - `apps/gateway/api/oracle/index.ts`
- passed a focused temporary TypeScript project check covering:
  - `apps/gateway/api/oracle/storage-reporter.ts`
  - `apps/gateway/api/oracle/storage-audit-verifier.ts`
  - `apps/gateway/api/oracle/index.ts`
  - `apps/gateway/lib/nodeStaking.ts`
- full Gateway/DWS app typecheck still not claimed clean; there are known unrelated errors elsewhere in the monorepo

What Claude should do next:
1. inspect these local reporter files and confirm the env mapping against the Oracle deployment model
2. validate the DWS node on AWS exposes:
   - `/storage/health`
   - `/storage/activity/summary`
   - `/storage/audit`
   - `/storage/audit/:cid/challenge`
   - `/storage/audit/:cid/prove`
3. on Oracle, run the reporter in `RUN_ONCE` mode first with on-chain submission OFF
4. check that endpoint discovery / override mapping is correct for the AWS storage node
5. only then decide whether to enable:
   - `STORAGE_REPORTER_SUBMIT_ON_CHAIN`
   - `STORAGE_REPORTER_REGISTER_AS_PERFORMANCE_ORACLE`
   - `STORAGE_REPORTER_ENABLE_AUTO_SLASHING`
   - `STORAGE_REPORTER_CHECK_SLASHING`
6. if the signer is not already authorized on-chain, Claude must coordinate the owner/admin step instead of assuming the reporter can self-authorize

## 2026-03-02 17:25:00 -01 MultiOracleConsensus reality check

- local only
- `packages/contracts/src/staking/MultiOracleConsensus.sol` is intended as a fan-in oracle contract:
  1. 3+ authorized oracle addresses submit metrics with `submitPerformance(...)`
  2. contract gathers recent submissions for a node (1 hour window)
  3. computes medians
  4. if consensus passes, it calls `NodeStakingManager.updatePerformance(...)`
- integration with existing testnet is operationally easy:
  - deploy a new `MultiOracleConsensus`
  - set 3 oracle addresses in constructor (or add more later)
  - owner of the existing `NodeStakingManager` calls `addPerformanceOracle(consensusAddress)`
  - reporter instances submit to the consensus contract instead of directly to `NodeStakingManager`
- important contract flaws in the CURRENT implementation:
  1. duplicate submissions are not blocked
     - same oracle can submit multiple times for the same node/window
     - this defeats the whole multi-oracle premise
  2. consensus threshold is only checked on `uptimeScore`
     - `requestsServed` and `avgResponseTime` are medianed but not threshold-validated
  3. `_withinThreshold(...)` can divide by zero if the reference value is zero
  4. `autoSlashingEnabled` exists but is not wired to any slashing call
- because of those issues, I would NOT tell Claude to deploy `MultiOracleConsensus.sol` unchanged if the goal is to test actual multi-oracle behavior rather than just a demo.
- recommendation:
  1. patch `MultiOracleConsensus.sol`
  2. add a focused Foundry test file for:
     - 3 distinct oracles reaching consensus
     - duplicate oracle rejected
     - disagreement on requests/latency rejected
     - zero-value edge cases
  3. only then deploy a fresh consensus contract to testnet

## 2026-03-02 18:45:00 -01 advanced oracle consensus branch

- local only
- created and continued work on dedicated branch:
  - `codex/advanced-oracle-consensus`
- note:
  - Claude briefly switched onto that branch by mistake and later deleted/recreated it
  - branch state is restored locally and current work is on `codex/advanced-oracle-consensus`

Implemented on this branch:
- new contracts:
  - `packages/contracts/src/staking/OraclePowerRegistry.sol`
  - `packages/contracts/src/staking/AdvancedOracleConsensus.sol`
  - `packages/contracts/src/staking/OracleSlashGovernor.sol`
- patched existing contracts:
  - `packages/contracts/src/staking/NodeStakingManager.sol`
    - added `slashAuthority`
    - added `setSlashAuthority(address)`
    - `proposeSlash`, `executeSlash`, and legacy `slashNode` can now be called by owner or `slashAuthority`
  - `packages/contracts/src/staking/MultiOracleConsensus.sol`
    - added minimal migration/handoff state:
      - `nextConsensus`
      - delayed handoff threshold fields
      - `canHandOffToNextConsensus()`
- new design doc:
  - `ADVANCED_ORACLE_CONSENSUS.md`
- new focused Foundry test:
  - `packages/contracts/test/staking/AdvancedOracleConsensus.t.sol`

Design implemented:
- bootstrap phase:
  - owner-managed oracle allowlist
- delayed transition:
  - activation after enough blocks and enough bootstrap-approved oracles
- advanced phase:
  - permissionless oracle participation by staking threshold
  - first-pass target is `1%` of total supply via `minPermissionlessStakeBps = 100`
- performance consensus:
  - weighted medians
  - minimum distinct oracles
  - weighted quorum requirement
- slashing governance:
  - slash recommendations can be queued from performance consensus
  - eligible oracles vote with oracle stake weight
  - strong support -> shorter delay
  - moderate support -> longer delay

Validation:
- targeted Foundry suite passes:
  - `forge test --match-path test/staking/AdvancedOracleConsensus.t.sol`
- currently covered:
  1. bootstrap consensus finalizes with 3 approved oracles
  2. advanced mode uses stake-weighted medians
  3. duplicate oracle submission reverts
  4. unstaking below threshold removes oracle eligibility/weight
  5. slash governor fast-track path queues and executes through the mocked staking manager

Important caveat:
- `OracleSlashGovernor.executeProposal(...)` currently calls `NodeStakingManager.slashNode(...)`
- because `NodeStakingManager.slashNode(...)` is still the dispute-period path, the oracle governor does NOT directly seize stake immediately
- instead, it triggers the staking manager’s pending-slash flow
- this is intentional for now because it preserves an extra dispute layer

## 2026-03-02 oracle reporter key handling

- Claude using `~/oracle-key.env` is acceptable only as a short-lived testnet fallback.
- The reporter code in `apps/gateway/api/oracle/storage-reporter.ts` is KMS-first via `createMigrationWalletClient(...)` and only falls back to `ORACLE_PRIVATE_KEY` / `PRIVATE_KEY` if KMS is unavailable.
- Jeju's production-oriented services explicitly require KMS in production and treat raw private keys as development-only or insecure fallbacks (see `packages/monitoring/api/heartbeat.ts`, `apps/dws/src/cdn/edge/index.ts`, `apps/dws/src/cdn/routing/coordinator.ts`, `apps/dws/src/cdn/sdk/index.ts`, and `packages/kms/src/sdk/migration.ts`).
- Recommendation: for the Oracle-hosted reporter/oracle signer, use the Jeju KMS service if it is available on that host; keep `~/oracle-key.env` only as a disposable testnet/bootstrap fallback.
- Because the key was previously printed in terminal output, treat that specific key as exposed and rotate/regenerate it before relying on it for persistent on-chain oracle duties.
- If Claude keeps the env-file fallback temporarily, he should scope it to the reporter service only, avoid reusing it for deployer/admin duties, and remove it after KMS is wired.

## 2026-03-02 gateway registry + live paymaster state

- local only:
  - Gateway frontend config was patched to stop hardcoding stale ERC-4337 addresses.
  - updated:
    - `packages/config/schemas.ts`
    - `packages/config/index.ts`
    - `apps/gateway/lib/config/index.ts`
  - `apps/gateway/lib/config/index.ts` now sources:
    - `entryPoint` / `entryPointV07` from `contracts.accountAbstraction.entryPointV07`
    - `simpleAccountFactory` from `contracts.accountAbstraction.simpleAccountFactory`
    - `weth` from shared config/constants instead of a literal

- important frontend finding:
  - `/gateway/registry` is still a direct wallet flow today.
  - files:
    - `apps/gateway/web/hooks/useRegistry.ts`
    - `apps/gateway/web/components/RegisterAppForm.tsx`
  - current behavior is plain:
    1. ERC-20 `approve(...)`
    2. direct `registerWithStake(...)`
  - the paymaster is not in that flow yet.

- live Oracle Cloud reads:
  - current IdentityRegistry:
    - `0xefAB0Beb0A557E452b398035eA964948c750b2Fd`
  - current JEJU token:
    - `0xb224f7607215139130ea79111358c1908e69f30e`
  - current governance of IdentityRegistry:
    - `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
  - current supported stake tokens on IdentityRegistry:
    - `[ETH only]`
  - `isSupportedStakeToken(JEJU)` on current registry:
    - `false`
  - current ServiceRegistry:
    - `0xefc5a8c31cfd2a693e0169790421076916405083`
  - current CreditManager:
    - `0x6cfc5f9b0e5fe29470778b018aaaeb014281ea19`
  - ServiceRegistry owner:
    - `0x86d240bFf6C1Fdc0A5a4D7e371E59F0938f1666c`
  - CreditManager owner:
    - `0x86d240bFf6C1Fdc0A5a4D7e371E59F0938f1666c`

- live paymaster/service findings:
  - the actual live gas abstraction path is `packages/contracts/src/services/MultiTokenPaymaster.sol`
    - not the simpler `LiquidityPaymaster.sol`
  - the current live `MultiTokenPaymaster` depends on:
    - `ServiceRegistry.isServiceAvailable(serviceName)`
    - `ServiceRegistry.getServiceCost(serviceName, user)`
    - `CreditManager.hasSufficientCredit(...)`
  - read-only live checks on Oracle testnet showed no active registry-related service entries:
    - `registry` -> `false`
    - `register-agent` -> `false`
    - `identity-register` -> `false`
    - `gateway-registry` -> `false`
    - `app-registration` -> `false`
    - `agent-registration` -> `false`
    - `Jeju Gateway` -> `false`
    - `Jeju x402 Facilitator` -> `false`
    - `Jeju Registry` -> `false`
    - `Jeju Agent Registration` -> `false`
    - `Jeju App Registration` -> `false`

- important design blocker for gasless staked registry registration:
  - even after browser AA wiring is added, `registerWithStake(...)` pulls the stake token from `msg.sender`.
  - under ERC-4337, `msg.sender` at the target contract is the smart account, not the user's EOA.
  - therefore a first-time gasless staked identity registration only works if the smart account already:
    1. holds JEJU
    2. has approved the IdentityRegistry to spend JEJU
  - same issue exists for token-based gas payment:
    - the paymaster checks the smart account's JEJU balance/allowance, not the EOA's.
  - conclusion:
    - current "pay gas in JEJU while staking JEJU from my normal wallet" UX is not deploy-complete on live testnet yet.

- practical implication:
  - frontend work alone will not make `/gateway/registry` succeed gaslessly on live testnet.
  - live chain also needs:
    1. JEJU re-added via `IdentityRegistry.addSupportedToken(JEJU)`
    2. a real ServiceRegistry entry for agent/app registration if MultiTokenPaymaster is to sponsor it
    3. a bootstrap story for smart-account credit / JEJU funding / registry approval

- docs mismatch to keep in mind:
  - `apps/documentation/docs/pages/guides/register-agent.mdx` still says "A wallet with ETH for gas is required."
  - that is closer to current live reality than the gasless docs for this specific flow.

- GitHub auth on this Mac:
  - `origin` already points to `https://github.com/prophet10x/jeju`
  - `upstream` points to `https://github.com/JejuNetwork/jeju.git`
  - `gh auth status` currently reports an invalid token for account `prophet10x`
  - before Codex can push directly from this Mac, GitHub auth must be refreshed here (`gh auth login` or equivalent credential helper/PAT/SSH setup)

## 2026-03-02 live Oracle testnet fixes applied

- deployed/live changes:
  - GitHub auth on the Mac was refreshed successfully for `prophet10x`.
  - live Oracle testnet contract state was updated.

- JEJU re-enabled on current IdentityRegistry:
  - contract:
    - `0xefAB0Beb0A557E452b398035eA964948c750b2Fd`
  - governance tx:
    - `0xc7f3be25ee77bc1a9dbd32ec6168fad9e44ff634d6ded4c127f73ab6bc30b3c9`
  - result:
    - `isSupportedStakeToken(JEJU)` is now `true`
    - supported stake tokens are now:
      - `ETH`
      - `JEJU`

- live ServiceRegistry/CreditManager paymaster wiring fixed:
  - ServiceRegistry:
    - `0xefc5a8c31cfd2a693e0169790421076916405083`
  - CreditManager:
    - `0x6cfc5f9b0e5fe29470778b018aaaeb014281ea19`
  - MultiTokenPaymaster:
    - `0xfc86aeccf568e966c404387037195eee2f97f51d`
  - live changes applied with the deployer key already present on Oracle in:
    - `/home/ubuntu/jeju-l2/docker/.env`
    - `/home/ubuntu/jeju-l2/keys/.env`
  - results:
    - `CreditManager.authorizedServices(MultiTokenPaymaster)` is now `true`
    - `ServiceRegistry.identityRegistry` is now set to the current IdentityRegistry
    - `ServiceRegistry.getServiceCount()` is now `4`
    - registered services:
      1. `Jeju Agent Registration`
      2. `Jeju App Registration`
      3. `Jeju Node Registration`
      4. `Jeju Gateway`

- important remaining blocker:
  - this does NOT by itself make fully gasless staked registration work in the browser.
  - `/gateway/registry` is still a direct wagmi flow in frontend code.
  - even after browser AA wiring is added, `registerWithStake(...)` and token-paymaster charges both come from the smart account, not the EOA.
  - so first-time gasless staked registration still needs a bootstrap strategy for:
    1. smart-account JEJU balance
    2. smart-account JEJU allowance to IdentityRegistry
    3. frontend AA/bundler/paymaster wiring

- practical effect of the live fixes:
  - current direct-wallet JEJU staking flows should now be unblocked again at the contract level on the new IdentityRegistry.
  - full “user never sees ETH” UX is still not complete.

## 2026-03-02 gateway smart-account bootstrap wiring

- local Gateway/browser AA wiring is now implemented for:
  - `/gateway/registry`
  - `/gateway/nodes`
- new hook:
  - `apps/gateway/web/hooks/useGaslessSmartAccount.ts`
- updated files:
  - `apps/gateway/web/hooks/useRegistry.ts`
  - `apps/gateway/web/hooks/useNodeStaking.ts`
  - `apps/gateway/web/components/RegisterAppForm.tsx`
  - `apps/gateway/web/components/RegisterNodeForm.tsx`
  - `apps/gateway/lib/config/index.ts`
  - `packages/config/index.ts`
  - `packages/config/schemas.ts`

### Behavior

- Gateway now derives and displays the user SimpleAccount address in the browser.
- It reads:
  - JEJU balance on the smart account
  - JEJU credit in `CreditManager`
  - JEJU allowance to `MultiTokenPaymaster`
- It now uses the live same-origin bundler endpoint:
  - `/bundler`
- Registry gasless flow:
  - batches `approve(IdentityRegistry)` + `registerWithStake(...)`
  - paymaster service name: `Jeju Agent Registration`
- Node gasless flow:
  - batches `approve(NodeStakingManager)` + `registerNodeWithAgent(...)` / `registerNode(...)`
  - paymaster service name: `Jeju Node Registration`

### Bootstrap / readiness rules now surfaced in UI

- Gasless is marked ready only if the smart account has:
  - enough JEJU for the actual stake, and
  - either enough JEJU credit, or enough prior JEJU allowance to the paymaster
- If the first gasless op succeeds via the credit path, it also auto-approves the paymaster for future JEJU slow-path use.
- Current first pass keeps the gasless staking path JEJU-only.
  - `/gateway/nodes` explicitly blocks non-JEJU gasless staking selections for now.

### Validation

- Gateway production build succeeded locally with:
  - `bun run scripts/build.ts`
- Oracle remote rebuild initially failed because `apps/gateway/package.json` did not declare `permissionless`, even though the local workspace resolved it.
- Follow-up fix:
  - add `permissionless: "0.2.0"` to `apps/gateway/package.json`
  - pull again on Oracle
  - run workspace install there before future Gateway rebuilds

### Deploy note

- Oracle Cloud repo is already on branch:
  - `codex/storage-audit-registration`
- So the next live step is:
  1. commit and push the above files on that branch
  2. pull on Oracle
  3. rebuild/restart Gateway
  4. test `/gateway/registry` and `/gateway/nodes`
