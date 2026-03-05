# ADR: Agent Staking Upgradeability via Stable Registry + Versioned Modules

## Status
Proposed

## Date
2026-03-05

## Context
Current agent staking data is embedded in `IdentityRegistry`. That tightly couples:
- canonical agent identity state
- staking balances
- staking policy logic

This creates the same upgrade risk node staking had before V3 architecture: future V3/V4 policy changes require invasive contract replacement or user migration flows.

## Decision
Do not implement agent staking migration in this phase.  
Adopt the same architecture direction as node staking and schedule it as a dedicated follow-up:

1. `AgentStateRegistry` as canonical agent staking storage.
2. `AgentStakeVault` as token custody.
3. `AgentManagerRouter` as stable user entrypoint.
4. Versioned manager modules (`AgentManagerV1`, `AgentManagerV2`, ...).
5. Per-agent `stateVersion` + resumable `upgradeAgentVersion(agentId, targetVersion, maxSteps)`.

## Why This Matches Node V3
- Keeps funds in a dedicated vault, not in version-specific manager logic.
- Lets protocol evolve policy logic without unstake/re-register.
- Keeps upgrades deterministic and resumable.
- Supports dual-read legacy behavior while migrating.

## Migration Strategy Options
1. Dual-read + opt-in migration (recommended):
- Keep legacy `IdentityRegistry` staking reads.
- New agent staking registrations use registry/router stack.
- Add explicit per-agent migration methods later.

2. Bulk migration:
- High risk and operationally heavier.
- Not recommended until stack is stable in production.

## Security/Governance Requirements
- Timelock-controlled module registration/activation.
- Multisig emergency controls.
- Registry-enforced allowlists for modules and migration handlers.

## Consequences
- Near-term: no behavior change for current agent staking.
- Medium-term: clear path to agent upgrades without deregistration.
- Long-term: consistent upgrade model across node and agent staking subsystems.
