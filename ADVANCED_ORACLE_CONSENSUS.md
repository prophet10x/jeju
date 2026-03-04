# Advanced Oracle Consensus

This branch introduces a first-pass design for moving Jeju from the current owner-managed, equal-weight oracle allowlist into a stake-weighted oracle and slashing system.

## Goal

Move from:
- owner-managed oracle allowlist
- simple 3-of-N median
- owner-managed slashing

To:
- bootstrap allowlist first
- automatic transition after enough time and enough bootstrap oracles
- permissionless oracle participation for addresses staking at least 1% of token supply
- stake-weighted performance consensus
- stake-weighted slash voting with faster or slower execution windows depending on support

## Contracts

### `OraclePowerRegistry.sol`

Purpose:
- bootstrap oracle approvals
- permissionless oracle staking
- transition gate between bootstrap and advanced mode
- oracle voting power source

Key ideas:
- bootstrap starts at deploy block
- advanced mode activates after:
  - `activationDelayBlocks` has passed
  - `minBootstrapApprovedOracles` has been reached
- before advanced mode:
  - oracle weight is `1` for bootstrap-approved oracles
- after advanced mode:
  - oracle weight is the oracle’s eligible staked amount
- minimum oracle stake is:
  - `token.totalSupply() * minPermissionlessStakeBps / 10000`
  - default design target here is `100 bps = 1%`

### `AdvancedOracleConsensus.sol`

Purpose:
- receive oracle performance submissions
- block duplicate submissions per oracle / node / epoch
- finalize stake-weighted median metrics
- call `NodeStakingManager.updatePerformance(...)`
- optionally queue slash proposals into the oracle slash governor

Key ideas:
- rounds are per `nodeId + epoch`
- each eligible oracle can submit once per round
- finalization requires:
  - minimum number of distinct oracles
  - minimum stake-weighted quorum
- medians are weighted medians, not plain medians

### `OracleSlashGovernor.sol`

Purpose:
- take slash recommendations from consensus
- let eligible oracles cast stake-weighted votes
- change execution timing based on support thresholds

Key ideas:
- strong support => shorter wait
- weaker but still acceptable support => longer wait
- if support falls below threshold => not executable
- execution currently calls `NodeStakingManager.slashNode(...)`
  - which still produces a pending slash inside `NodeStakingManager`
  - so the existing dispute period remains as an extra safety layer

## Patched Existing Contracts

### `NodeStakingManager.sol`

Added:
- `slashAuthority`
- `setSlashAuthority(address)`
- `onlySlashManager`

This lets a future oracle slash governor create and execute slash actions without transferring ownership of the whole staking manager.

### `MultiOracleConsensus.sol`

Added light migration support:
- `authorizedOracleCount()`
- `nextConsensus`
- `advancedActivationDelayBlocks`
- `minimumBootstrapOraclesForUpgrade`
- `canHandOffToNextConsensus()`

This does not fully auto-switch `NodeStakingManager`. It gives the legacy contract enough state to express when the network is ready for handoff.

## Proposed Migration

### Phase 1: Bootstrap

- deploy `OraclePowerRegistry`
- owner approves bootstrap oracle addresses
- bootstrap oracles run equal-weight reporting
- deploy `AdvancedOracleConsensus`
- deploy `OracleSlashGovernor`
- add `AdvancedOracleConsensus` as an authorized performance oracle in `NodeStakingManager`
- set `slashAuthority` to `OracleSlashGovernor`

### Phase 2: Delayed Activation

The branch is set up for a delayed transition concept:
- `10_000_000` blocks delay by default
- at least `5` bootstrap-approved oracles

Once both conditions are satisfied:
- `OraclePowerRegistry` can activate advanced mode
- oracle eligibility changes from bootstrap allowlist to stake threshold
- voting power changes from equal weight to stake weight

### Phase 3: Permissionless Oracle Participation

After activation:
- any address staking at least `1%` of supply can become an oracle
- consensus and slash voting use oracle stake weight

## Dfinity-Style Timing Influence

This branch does not copy Dfinity governance exactly, but it does implement the same broad principle:

- overwhelming support should finalize faster
- borderline support should remain open longer
- insufficient support should not execute

Current first-pass slash timing parameters:
- `fastSupportBps`
- `standardSupportBps`
- `fastExecutionDelayBlocks`
- `standardExecutionDelayBlocks`

## Important Limitations

This is still a first-pass architecture branch.

Not fully solved yet:
- oracle stake snapshots at vote-start block
  - current implementation uses current oracle weight at vote time
- oracle rewards / slashing of malicious oracle reporters
- cross-chain or external evidence settlement
- automatic replacement of the legacy oracle in live deployed staking contracts
- deployment scripts for these new contracts

## Suggested Next Steps

1. Add focused Foundry tests for the new contracts.
2. Decide whether slash voting should execute `slashNode(...)` or `proposeSlash(...)` on the staking manager as the canonical path.
3. Add oracle reward / penalty economics so oracle stake is not just Sybil-resistance.
4. Add deployment scripts and explicit migration runbooks for testnet.
