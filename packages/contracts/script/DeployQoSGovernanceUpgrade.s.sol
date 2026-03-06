// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";
import {QoSMetadataReporterConsensus} from "../src/staking/QoSMetadataReporterConsensus.sol";
import {OraclePowerRegistry} from "../src/staking/OraclePowerRegistry.sol";
import {UpgradeValidationRegistry} from "../src/governance/UpgradeValidationRegistry.sol";
import {ProtocolUpgradeManager} from "../src/governance/ProtocolUpgradeManager.sol";

interface IIdentityRegistryGovernance {
    function governance() external view returns (address);
    function setMetadataReporter(address reporter, bool authorized) external;
    function replaceMetadataReporter(address oldReporter, address newReporter) external;
}

interface IOwnableLike {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface INodeStakingAdmin {
    function owner() external view returns (address);
    function setSlashAuthority(address newSlashAuthority) external;
}

interface IAutoSlasherAdmin {
    function owner() external view returns (address);
    function setGovernance(address newGovernance) external;
}

/**
 * @title DeployQoSGovernanceUpgrade
 * @notice Deploy QoSV governance contracts and perform optional migration wiring
 * @dev Required env:
 *      - PRIVATE_KEY
 *      - IDENTITY_REGISTRY_ADDRESS
 *
 * Optional env:
 *      - ORACLE_POWER_REGISTRY_ADDRESS (if omitted, deploys a new OraclePowerRegistry)
 *      - ORACLE_TOKEN_ADDRESS (required only when deploying OraclePowerRegistry)
 *      - ORACLE_POWER_ACTIVATION_DELAY_BLOCKS (default 43_200)
 *      - ORACLE_POWER_MIN_BOOTSTRAP_ORACLES (default 1)
 *      - ORACLE_POWER_MIN_STAKE_BPS (default 100)
 *      - QOS_INITIAL_REPORTER (default deployer)
 *      - QOS_GOV_OWNER (default deployer)
 *      - QOS_MIN_REPORTERS (default 1)
 *      - QOS_SUPPORT_BPS (default 5500)
 *      - QOS_MIN_PROPOSAL_DURATION_SEC (default 120)
 *      - QOS_MAX_PROPOSAL_DURATION_SEC (default 7200)
 *      - QOS_VALIDATION_MIN_DURATION_SEC (default 3600)
 *      - QOS_VALIDATION_MAX_DURATION_SEC (default 604800)
 *      - QOS_OLD_CONSENSUS (default 0x0)
 *      - GOVERNANCE_TIMELOCK (default 0x0)
 *      - NODE_STAKING_MANAGER_ADDRESS (default 0x0)
 *      - AUTO_SLASHER_ADDRESS (default 0x0)
 *
 * Run example:
 *   forge script script/DeployQoSGovernanceUpgrade.s.sol:DeployQoSGovernanceUpgrade --rpc-url jeju_testnet --broadcast
 */
contract DeployQoSGovernanceUpgrade is Script {
    error MissingOracleTokenAddress();

    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);

        address existingOracleRegistry = vm.envOr("ORACLE_POWER_REGISTRY_ADDRESS", address(0));
        address oracleToken = vm.envOr("ORACLE_TOKEN_ADDRESS", address(0));
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY_ADDRESS");

        address ownerAddr = vm.envOr("QOS_GOV_OWNER", deployer);
        address initialReporter = vm.envOr("QOS_INITIAL_REPORTER", deployer);
        uint256 minimumReporterCount = vm.envOr("QOS_MIN_REPORTERS", uint256(1));
        uint256 supportThresholdBps = vm.envOr("QOS_SUPPORT_BPS", uint256(5500));
        uint256 minProposalDurationSec = vm.envOr("QOS_MIN_PROPOSAL_DURATION_SEC", uint256(120));
        uint256 maxProposalDurationSec = vm.envOr("QOS_MAX_PROPOSAL_DURATION_SEC", uint256(7200));
        uint256 minValidationDurationSec = vm.envOr("QOS_VALIDATION_MIN_DURATION_SEC", uint256(1 hours));
        uint256 maxValidationDurationSec = vm.envOr("QOS_VALIDATION_MAX_DURATION_SEC", uint256(7 days));
        uint256 powerActivationDelayBlocks = vm.envOr("ORACLE_POWER_ACTIVATION_DELAY_BLOCKS", uint256(43_200));
        uint256 powerMinBootstrapOracles = vm.envOr("ORACLE_POWER_MIN_BOOTSTRAP_ORACLES", uint256(1));
        uint256 powerMinStakeBps = vm.envOr("ORACLE_POWER_MIN_STAKE_BPS", uint256(100));

        address oldConsensus = vm.envOr("QOS_OLD_CONSENSUS", address(0));
        address governanceTimelock = vm.envOr("GOVERNANCE_TIMELOCK", address(0));
        address nodeStakingManager = vm.envOr("NODE_STAKING_MANAGER_ADDRESS", address(0));
        address autoSlasher = vm.envOr("AUTO_SLASHER_ADDRESS", address(0));

        console.log("==================================================");
        console.log("Deploy QoSV Governance Upgrade");
        console.log("==================================================");
        console.log("Chain ID:", block.chainid);
        console.log("Deployer:", deployer);
        console.log("Owner:", ownerAddr);
        console.log("Existing OraclePowerRegistry:", existingOracleRegistry);
        console.log("Oracle token:", oracleToken);
        console.log("Initial reporter:", initialReporter);
        console.log("IdentityRegistry:", identityRegistry);
        console.log("GovernanceTimelock:", governanceTimelock);
        console.log("");

        vm.startBroadcast(privateKey);

        OraclePowerRegistry oracleRegistry = _resolveOrDeployOracleRegistry(
            existingOracleRegistry,
            oracleToken,
            ownerAddr,
            powerActivationDelayBlocks,
            powerMinBootstrapOracles,
            powerMinStakeBps
        );
        _ensureReporterEligibility(oracleRegistry, initialReporter, deployer);

        QoSMetadataReporterConsensus consensus = new QoSMetadataReporterConsensus(
            address(oracleRegistry),
            identityRegistry,
            ownerAddr,
            minimumReporterCount,
            supportThresholdBps,
            minProposalDurationSec,
            maxProposalDurationSec
        );
        console.log("QoSMetadataReporterConsensus:", address(consensus));

        UpgradeValidationRegistry validationRegistry = new UpgradeValidationRegistry(
            address(oracleRegistry),
            ownerAddr,
            minValidationDurationSec,
            maxValidationDurationSec,
            minimumReporterCount,
            supportThresholdBps
        );
        console.log("UpgradeValidationRegistry:", address(validationRegistry));

        ProtocolUpgradeManager upgradeManager =
            new ProtocolUpgradeManager(ownerAddr, address(validationRegistry), true);
        console.log("ProtocolUpgradeManager:", address(upgradeManager));

        _migrateIdentityReporter(identityRegistry, deployer, oldConsensus, address(consensus));
        _wireSlashAuthority(nodeStakingManager, autoSlasher, deployer);
        _wireAutoSlasherGovernance(autoSlasher, governanceTimelock, deployer);
        _handoffOwnership(consensus, validationRegistry, upgradeManager, governanceTimelock, deployer);

        vm.stopBroadcast();

        console.log("");
        console.log("==================================================");
        console.log("QoSV Governance Upgrade Deployment Complete");
        console.log("==================================================");
        console.log("  QoSMetadataReporterConsensus:", address(consensus));
        console.log("  UpgradeValidationRegistry:", address(validationRegistry));
        console.log("  ProtocolUpgradeManager:", address(upgradeManager));
        console.log("  OraclePowerRegistry:", address(oracleRegistry));
        console.log("");
    }

    function _resolveOrDeployOracleRegistry(
        address existingOracleRegistry,
        address oracleToken,
        address ownerAddr,
        uint256 powerActivationDelayBlocks,
        uint256 powerMinBootstrapOracles,
        uint256 powerMinStakeBps
    ) internal returns (OraclePowerRegistry oracleRegistry) {
        if (existingOracleRegistry != address(0)) {
            oracleRegistry = OraclePowerRegistry(existingOracleRegistry);
            console.log("Using existing OraclePowerRegistry:", existingOracleRegistry);
            return oracleRegistry;
        }

        if (oracleToken == address(0)) revert MissingOracleTokenAddress();

        oracleRegistry = new OraclePowerRegistry(
            oracleToken, ownerAddr, powerActivationDelayBlocks, powerMinBootstrapOracles, powerMinStakeBps
        );
        console.log("OraclePowerRegistry deployed:", address(oracleRegistry));
    }

    function _ensureReporterEligibility(OraclePowerRegistry oracleRegistry, address reporter, address deployer) internal {
        if (reporter == address(0)) {
            return;
        }

        if (oracleRegistry.isEligibleOracle(reporter)) {
            console.log("Reporter already eligible in OraclePowerRegistry:", reporter);
            return;
        }

        bool advancedMode = oracleRegistry.currentModeUsesStakeWeight();
        if (advancedMode) {
            console.log("NOTICE: OraclePowerRegistry in stake-weight mode; reporter must stake to become eligible.");
            console.log("  reporter:", reporter);
            return;
        }

        address registryOwner = IOwnableLike(address(oracleRegistry)).owner();
        if (registryOwner == deployer) {
            oracleRegistry.approveBootstrapOracle(reporter);
            console.log("OraclePowerRegistry bootstrap reporter approved:", reporter);
            return;
        }

        console.log("NOTICE: OraclePowerRegistry owner is not deployer.");
        console.log("  owner:", registryOwner);
        console.log("  Submit governance action to approve bootstrap oracle:", reporter);
    }

    function _migrateIdentityReporter(
        address identityRegistry,
        address deployer,
        address oldConsensus,
        address newConsensus
    ) internal {
        address governance = IIdentityRegistryGovernance(identityRegistry).governance();

        if (governance == deployer) {
            if (oldConsensus != address(0)) {
                bool rotated = _tryReplaceMetadataReporter(identityRegistry, oldConsensus, newConsensus);
                if (rotated) {
                    console.log("IdentityRegistry reporter rotated:", oldConsensus, "->", newConsensus);
                } else {
                    console.log("NOTICE: IdentityRegistry replaceMetadataReporter unavailable/reverted.");
                }
            } else {
                bool authorized = _trySetMetadataReporter(identityRegistry, newConsensus, true);
                if (authorized) {
                    console.log("IdentityRegistry reporter authorized:", newConsensus);
                } else {
                    console.log("NOTICE: IdentityRegistry setMetadataReporter unavailable/reverted.");
                }
            }
            return;
        }

        console.log("NOTICE: IdentityRegistry governance is not deployer.");
        console.log("  governance:", governance);
        console.log("  Submit governance action to authorize new reporter:", newConsensus);
    }

    function _trySetMetadataReporter(address identityRegistry, address reporter, bool authorized)
        internal
        returns (bool ok)
    {
        (ok,) = identityRegistry.call(
            abi.encodeWithSelector(IIdentityRegistryGovernance.setMetadataReporter.selector, reporter, authorized)
        );
    }

    function _tryReplaceMetadataReporter(address identityRegistry, address oldReporter, address newReporter)
        internal
        returns (bool ok)
    {
        (ok,) = identityRegistry.call(
            abi.encodeWithSelector(
                IIdentityRegistryGovernance.replaceMetadataReporter.selector, oldReporter, newReporter
            )
        );
    }

    function _wireSlashAuthority(address nodeStakingManager, address autoSlasher, address deployer) internal {
        if (nodeStakingManager == address(0) || autoSlasher == address(0)) {
            return;
        }

        address stakingOwner = INodeStakingAdmin(nodeStakingManager).owner();
        if (stakingOwner == deployer) {
            INodeStakingAdmin(nodeStakingManager).setSlashAuthority(autoSlasher);
            console.log("NodeStakingManager slashAuthority set:", autoSlasher);
            return;
        }

        console.log("NOTICE: NodeStakingManager owner is not deployer.");
        console.log("  owner:", stakingOwner);
        console.log("  Submit governance action to set slashAuthority:", autoSlasher);
    }

    function _wireAutoSlasherGovernance(address autoSlasher, address governanceTimelock, address deployer) internal {
        if (autoSlasher == address(0) || governanceTimelock == address(0)) {
            return;
        }

        address slasherOwner = IAutoSlasherAdmin(autoSlasher).owner();
        if (slasherOwner == deployer) {
            IAutoSlasherAdmin(autoSlasher).setGovernance(governanceTimelock);
            console.log("AutoSlasher governance set:", governanceTimelock);
            return;
        }

        console.log("NOTICE: AutoSlasher owner is not deployer.");
        console.log("  owner:", slasherOwner);
        console.log("  Submit governance action to set AutoSlasher governance:", governanceTimelock);
    }

    function _handoffOwnership(
        QoSMetadataReporterConsensus consensus,
        UpgradeValidationRegistry validationRegistry,
        ProtocolUpgradeManager upgradeManager,
        address governanceTimelock,
        address deployer
    ) internal {
        if (governanceTimelock == address(0)) {
            return;
        }

        if (IOwnableLike(address(consensus)).owner() == deployer) {
            consensus.transferOwnership(governanceTimelock);
            console.log("Transferred consensus ownership -> timelock");
        }

        if (IOwnableLike(address(validationRegistry)).owner() == deployer) {
            validationRegistry.transferOwnership(governanceTimelock);
            console.log("Transferred validation registry ownership -> timelock");
        }

        if (IOwnableLike(address(upgradeManager)).owner() == deployer) {
            upgradeManager.transferOwnership(governanceTimelock);
            console.log("Transferred protocol upgrade manager ownership -> timelock");
        }
    }
}
