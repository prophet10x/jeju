# Codex Review Stacks (4-Thread Split)

This branch is intentionally split into 4 feature stacks so reviews can run in parallel without cross-thread collisions.

## Stack 1: QoSV + Attestation + Service Reporters

Focus:
- Non-storage service reporter framework and module-specific reporters.
- Node-side nonce attestation endpoint + shared attestation schema/message.
- Gateway runner scripts and module wiring.

Files:
- `apps/gateway/api/oracle/index.ts`
- `apps/gateway/api/oracle/qos-validator-types.ts`
- `apps/gateway/api/oracle/storage-reporter.ts`
- `apps/gateway/api/oracle/qos-service-reporter.ts`
- `apps/gateway/api/oracle/service-reporter.ts`
- `apps/gateway/api/oracle/compute-reporter.ts`
- `apps/gateway/api/oracle/rpc-reporter.ts`
- `apps/gateway/api/oracle/cdn-reporter.ts`
- `apps/gateway/scripts/run-qos-validator-once.sh`
- `apps/gateway/scripts/run-qosv-testnet.sh`
- `apps/gateway/README.md`
- `apps/gateway/package.json`
- `apps/node/src/daemon/node-proof-server.ts`
- `packages/shared/src/qos-attestation.ts`
- `packages/shared/src/index.ts`

Review command:
```bash
git -C '/Users/admin69/Documents/New project/work/jeju' diff -- \
  apps/gateway/api/oracle/index.ts \
  apps/gateway/api/oracle/qos-validator-types.ts \
  apps/gateway/api/oracle/storage-reporter.ts \
  apps/gateway/api/oracle/qos-service-reporter.ts \
  apps/gateway/api/oracle/service-reporter.ts \
  apps/gateway/api/oracle/compute-reporter.ts \
  apps/gateway/api/oracle/rpc-reporter.ts \
  apps/gateway/api/oracle/cdn-reporter.ts \
  apps/gateway/scripts/run-qos-validator-once.sh \
  apps/gateway/scripts/run-qosv-testnet.sh \
  apps/gateway/README.md \
  apps/gateway/package.json \
  apps/node/src/daemon/node-proof-server.ts \
  packages/shared/src/qos-attestation.ts \
  packages/shared/src/index.ts
```

## Stack 2: Staking/Slashing + Identity Contract Adjustments

Focus:
- 24h grace/dispute confirmations and pending slash flow alignment.
- Identity registry metadata reporter authorization integration.

Files:
- `packages/contracts/src/staking/AutoSlasher.sol`
- `packages/contracts/src/staking/NodeStakingManager.sol`
- `packages/contracts/src/registry/IdentityRegistry.sol`
- `packages/contracts/src/registry/interfaces/IIdentityRegistry.sol`
- `packages/contracts/test/staking/NodeStakingManagerSlashDispute.t.sol`
- `packages/contracts/test/compute/ComputeRegistryIntegration.t.sol`

Review command:
```bash
git -C '/Users/admin69/Documents/New project/work/jeju' diff -- \
  packages/contracts/src/staking/AutoSlasher.sol \
  packages/contracts/src/staking/NodeStakingManager.sol \
  packages/contracts/src/registry/IdentityRegistry.sol \
  packages/contracts/src/registry/interfaces/IIdentityRegistry.sol \
  packages/contracts/test/staking/NodeStakingManagerSlashDispute.t.sol \
  packages/contracts/test/compute/ComputeRegistryIntegration.t.sol
```

## Stack 3: Meta-Agent Dual-Lane Governance + QoS Governance Contracts

Focus:
- DAO-parameterized runoff governance contracts.
- Runtime lane + constitutional lane routing.
- QoS metadata reporter consensus and upgrade validation manager.

Files:
- `packages/contracts/src/governance/MetaAgentGovernanceParameters.sol`
- `packages/contracts/src/governance/MetaAgentRoundCoordinator.sol`
- `packages/contracts/src/governance/MetaAgentRunoffGovernor.sol`
- `packages/contracts/src/governance/MetaAgentActionRouter.sol`
- `packages/contracts/src/governance/MetaAgentConstitutionalGovernor.sol`
- `packages/contracts/src/governance/UpgradeValidationRegistry.sol`
- `packages/contracts/src/governance/ProtocolUpgradeManager.sol`
- `packages/contracts/src/staking/QoSMetadataReporterConsensus.sol`
- `packages/contracts/test/governance/MetaAgentDualLaneGovernance.t.sol`
- `packages/contracts/test/governance/ProtocolUpgradeManager.t.sol`
- `packages/contracts/test/staking/QoSMetadataReporterConsensus.t.sol`

Review command:
```bash
git -C '/Users/admin69/Documents/New project/work/jeju' diff -- \
  packages/contracts/src/governance/MetaAgentGovernanceParameters.sol \
  packages/contracts/src/governance/MetaAgentRoundCoordinator.sol \
  packages/contracts/src/governance/MetaAgentRunoffGovernor.sol \
  packages/contracts/src/governance/MetaAgentActionRouter.sol \
  packages/contracts/src/governance/MetaAgentConstitutionalGovernor.sol \
  packages/contracts/src/governance/UpgradeValidationRegistry.sol \
  packages/contracts/src/governance/ProtocolUpgradeManager.sol \
  packages/contracts/src/staking/QoSMetadataReporterConsensus.sol \
  packages/contracts/test/governance/MetaAgentDualLaneGovernance.t.sol \
  packages/contracts/test/governance/ProtocolUpgradeManager.t.sol \
  packages/contracts/test/staking/QoSMetadataReporterConsensus.t.sol
```

## Stack 4: Deployment/Ops Docs + DWS/UI Changes

Focus:
- Deploy scripts/artifacts and runbook updates.
- DWS UI/API workflow adjustments.

Files:
- `packages/contracts/script/DeployQoSGovernanceUpgrade.s.sol`
- `packages/contracts/script/DeployMetaAgentGovernanceUpgrade.s.sol`
- `packages/contracts/deployments/qos-governance-testnet.json`
- `packages/contracts/DEPLOYMENT.md`
- `packages/contracts/README.md`
- `packages/contracts/foundry.lock`
- `apps/dws/api/dns/routes.ts`
- `apps/dws/api/infrastructure/source-uploader.ts`
- `apps/dws/api/workers/runtime.ts`
- `apps/dws/src/cdn/gateway/jns-gateway.ts`
- `apps/dws/web/components/AgentSettingsModal.tsx`
- `apps/dws/web/components/NodeRegistrationWizard.tsx`
- `apps/dws/web/config/index.ts`
- `apps/dws/web/pages/Agents.tsx`
- `apps/dws/web/pages/developer/Packages.tsx`
- `apps/dws/web/pages/storage/IPFS.tsx`
- `apps/dws/web/hooks/useGaslessBootstrap.ts`
- `apps/dws/web/hooks/useGaslessSmartAccount.ts`
- `apps/gateway/web/components/AppDetailModal.tsx`
- `apps/gateway/web/hooks/useGaslessBootstrap.ts`
- `apps/gateway/web/hooks/useGaslessSmartAccount.ts`

Review command:
```bash
git -C '/Users/admin69/Documents/New project/work/jeju' diff -- \
  packages/contracts/script/DeployQoSGovernanceUpgrade.s.sol \
  packages/contracts/script/DeployMetaAgentGovernanceUpgrade.s.sol \
  packages/contracts/deployments/qos-governance-testnet.json \
  packages/contracts/DEPLOYMENT.md \
  packages/contracts/README.md \
  packages/contracts/foundry.lock \
  apps/dws/api/dns/routes.ts \
  apps/dws/api/infrastructure/source-uploader.ts \
  apps/dws/api/workers/runtime.ts \
  apps/dws/src/cdn/gateway/jns-gateway.ts \
  apps/dws/web/components/AgentSettingsModal.tsx \
  apps/dws/web/components/NodeRegistrationWizard.tsx \
  apps/dws/web/config/index.ts \
  apps/dws/web/pages/Agents.tsx \
  apps/dws/web/pages/developer/Packages.tsx \
  apps/dws/web/pages/storage/IPFS.tsx \
  apps/dws/web/hooks/useGaslessBootstrap.ts \
  apps/dws/web/hooks/useGaslessSmartAccount.ts \
  apps/gateway/web/components/AppDetailModal.tsx \
  apps/gateway/web/hooks/useGaslessBootstrap.ts \
  apps/gateway/web/hooks/useGaslessSmartAccount.ts
```

## Deploy/Migration Coverage Note

The branch now contains:
- Existing QoS governance deploy/migration script: `DeployQoSGovernanceUpgrade.s.sol`.
- New Meta-Agent deploy/migration script: `DeployMetaAgentGovernanceUpgrade.s.sol`.

This closes the previous gap where Meta-Agent contracts existed without a dedicated deployment wiring script.
