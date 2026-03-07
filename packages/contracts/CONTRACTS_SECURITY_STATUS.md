# Contracts Security Status

Current status as of March 7, 2026.

This document describes what security coverage is actually documented in-repo for `packages/contracts` today. It is a status file, not an audit report.

## Bottom Line

- The repo does not contain a current comprehensive audit for the full contracts package.
- The only in-repo audit artifact is [SECURITY_AUDIT.md](./SECURITY_AUDIT.md), dated January 2, 2026.
- That artifact is an automated AI review scoped to:
  - `src/bridge/eil/CrossChainPaymasterUpgradeable.sol`
  - `src/bridge/eil/L1StakeManager.sol`
- That artifact predates the February-March 2026 staking, delegated-wallet, paymaster, governance, and moderation changes.

## Current Surface Area

- `384` Solidity source files under `packages/contracts/src`
- `122` Foundry test files under `packages/contracts/test`
- `66` top-level source domains under `packages/contracts/src`

Tests and broad surface area are useful context, but neither should be described as audit coverage.

## What Is Documented

| Artifact | Date | Type | Scope | How to describe it accurately |
|----------|------|------|-------|-------------------------------|
| [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) | January 2, 2026 | Automated AI review | `CrossChainPaymasterUpgradeable`, `L1StakeManager`, messenger assumptions around that flow | Historical, limited, file-specific review |
| [DEPLOYMENT-HARDENING.md](../../DEPLOYMENT-HARDENING.md) | March 2026 active ops doc | Operational hardening checklist | Deployment, routing, paymaster, proof, and rollout checks | Hardening/runbook guidance, not an audit |
| `packages/contracts/test/*.t.sol` | Ongoing | Test suite | Behavioral and regression coverage | Tests, not an audit |

## Post-February 2026 Change Concentration

Since February 1, 2026, `43` unique Solidity source files under `packages/contracts/src` changed.

Unique changed files by area:

- `staking`: `24`
- `governance`: `7`
- `moderation`: `5`
- `bridge`: `2`
- `registry`: `2`
- `interfaces`: `1`
- `paymaster`: `1`
- `services`: `1`

This means the highest-churn areas in the code you are actively working on are not the areas covered by the January 2, 2026 AI review.

## High-Risk Areas Without Current In-Repo Audit Coverage

### Node Staking and Registration

No current audit artifact covers the February-March 2026 node staking rollout, including router/vault/module changes such as:

- `src/staking/NodeStakingManagerV2.sol`
- `src/staking/NodeStakingManagerV2Atomic.sol`
- `src/staking/NodeManagerRouter.sol`
- `src/staking/modules/NodeManagerV3.sol`
- `src/staking/NodeRewardVault.sol`
- `src/staking/NodeStakeVault.sol`
- `src/staking/NodeStateRegistry.sol`

### Identity and Delegated Wallet Flow

No current audit artifact covers the delegated-wallet and operator-wallet migration path in:

- `src/registry/IdentityRegistry.sol`
- `src/registry/interfaces/IIdentityRegistry.sol`

### Paymaster and Credit Path

No current audit artifact covers the live gas sponsorship stack as currently used by the apps, including:

- `src/services/MultiTokenPaymaster.sol`
- `src/services/CreditManager.sol`
- `src/paymaster/*`

The historical AI audit should not be stretched to cover this broader paymaster and allowance/credit path.

### Governance and Upgrade Control

No current audit artifact covers the governance and upgrade-control additions, including:

- `src/governance/UpgradeValidationRegistry.sol`
- `src/governance/ProtocolUpgradeManager.sol`
- `src/governance/MetaAgentActionRouter.sol`
- `src/governance/MetaAgentConstitutionalGovernor.sol`
- `src/governance/MetaAgentRoundCoordinator.sol`
- `src/governance/MetaAgentRunoffGovernor.sol`

### Moderation Refactor

No current audit artifact covers the post-February moderation refactor, including:

- `src/moderation/ModerationMarketplace.sol`
- `src/moderation/ModerationMarketplaceViews.sol`
- `src/moderation/libraries/ModerationReputationLib.sol`
- `src/moderation/libraries/ModerationRewardsLib.sol`
- `src/moderation/libraries/ModerationVotingLib.sol`

## What We Can Honestly Claim

- There is a limited in-repo AI-generated review for specific EIL contracts dated January 2, 2026.
- There are tests and deployment-hardening documents in the repo.
- There is no evidence in this repo of a comprehensive third-party audit for the full `packages/contracts` surface.
- There is no evidence in this repo of a post-February 2026 audit covering the current staking, registry, paymaster, governance, or moderation changes.

## Release Guidance

Before mainnet use, security statements, or investor/public claims:

1. Treat post-February 2026 contract changes as unaudited unless a newer review is produced.
2. Do not describe `packages/contracts` as "audited" without naming the exact files and date.
3. If an audit claim is made, scope it narrowly to the reviewed contracts.
4. Prioritize targeted review for staking, delegated wallet flow, paymaster-credit path, and governance upgrade control.

## Maintenance Rule

If a new audit, manual review, or formal verification artifact lands, update this file first so the repo has one canonical statement of current coverage.
