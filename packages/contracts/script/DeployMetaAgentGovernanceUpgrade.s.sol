// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";
import {MetaAgentGovernanceParameters} from "../src/governance/MetaAgentGovernanceParameters.sol";
import {MetaAgentRoundCoordinator} from "../src/governance/MetaAgentRoundCoordinator.sol";
import {MetaAgentRunoffGovernor} from "../src/governance/MetaAgentRunoffGovernor.sol";
import {MetaAgentActionRouter} from "../src/governance/MetaAgentActionRouter.sol";
import {MetaAgentConstitutionalGovernor} from "../src/governance/MetaAgentConstitutionalGovernor.sol";

interface INodeStakingAdmin {
    function owner() external view returns (address);
    function setSlashAuthority(address newSlashAuthority) external;
}

interface IOwnableLike {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface ITimelockDelayLike {
    function timelockDelay() external view returns (uint256);
}

/**
 * @title DeployMetaAgentGovernanceUpgrade
 * @notice Deploy Meta-Agent dual-lane governance contracts and wire dependencies.
 *
 * Required env:
 *   - PRIVATE_KEY
 *   - NODE_STAKING_MANAGER_ADDRESS
 *   - DAO_REGISTRY_ADDRESS
 *   - GOVERNANCE_TOKEN_ADDRESS
 *   - GOVERNANCE_TIMELOCK
 *   - PROTOCOL_UPGRADE_MANAGER_ADDRESS
 *
 * Optional env:
 *   - META_OWNER (default deployer)
 *   - META_ROUND_MANAGER (default deployer)
 *   - META_TIMEOUT_SLASH_BPS (default 9000)
 *   - META_SET_SLASH_AUTHORITY (default false)
 *   - META_REQUIRE_7D_TIMELOCK (default true)
 *
 * Run example:
 *   forge script script/DeployMetaAgentGovernanceUpgrade.s.sol:DeployMetaAgentGovernanceUpgrade --rpc-url jeju_testnet --broadcast
 */
contract DeployMetaAgentGovernanceUpgrade is Script {
    uint256 internal constant REQUIRED_CORE_TIMELOCK_DELAY = 7 days;

    error TimelockDelayCheckFailed();
    error TimelockDelayMismatch(uint256 expected, uint256 actual);

    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);

        address nodeStakingManager = vm.envAddress("NODE_STAKING_MANAGER_ADDRESS");
        address daoRegistry = vm.envAddress("DAO_REGISTRY_ADDRESS");
        address governanceToken = vm.envAddress("GOVERNANCE_TOKEN_ADDRESS");
        address governanceTimelock = vm.envAddress("GOVERNANCE_TIMELOCK");
        address protocolUpgradeManager = vm.envAddress("PROTOCOL_UPGRADE_MANAGER_ADDRESS");

        address finalOwner = vm.envOr("META_OWNER", deployer);
        address roundManager = vm.envOr("META_ROUND_MANAGER", deployer);
        uint256 timeoutSlashBps = vm.envOr("META_TIMEOUT_SLASH_BPS", uint256(9000));
        bool setSlashAuthority = vm.envOr("META_SET_SLASH_AUTHORITY", false);
        bool requireSevenDayTimelock = vm.envOr("META_REQUIRE_7D_TIMELOCK", true);

        console.log("==================================================");
        console.log("Deploy Meta-Agent Governance Upgrade");
        console.log("==================================================");
        console.log("Chain ID:", block.chainid);
        console.log("Deployer:", deployer);
        console.log("Final owner:", finalOwner);
        console.log("Round manager:", roundManager);
        console.log("NodeStakingManager:", nodeStakingManager);
        console.log("DAORegistry:", daoRegistry);
        console.log("Governance token:", governanceToken);
        console.log("Governance timelock:", governanceTimelock);
        console.log("ProtocolUpgradeManager:", protocolUpgradeManager);
        console.log("Require 7d timelock:", requireSevenDayTimelock);
        console.log("");

        _checkTimelockDelay(governanceTimelock, requireSevenDayTimelock);

        vm.startBroadcast(privateKey);

        MetaAgentConstitutionalGovernor constitutionalGovernor = new MetaAgentConstitutionalGovernor(
            governanceToken, governanceTimelock, protocolUpgradeManager, deployer
        );
        console.log("MetaAgentConstitutionalGovernor:", address(constitutionalGovernor));

        MetaAgentGovernanceParameters parameters =
            new MetaAgentGovernanceParameters(deployer, address(constitutionalGovernor));
        console.log("MetaAgentGovernanceParameters:", address(parameters));

        // Bootstrap with deployer as temporary coordinator owner for first-pass wiring.
        MetaAgentRunoffGovernor runoffGovernor =
            new MetaAgentRunoffGovernor(daoRegistry, address(parameters), governanceToken, deployer, deployer);
        console.log("MetaAgentRunoffGovernor:", address(runoffGovernor));

        MetaAgentRoundCoordinator coordinator = new MetaAgentRoundCoordinator(
            nodeStakingManager, address(parameters), address(runoffGovernor), deployer, roundManager
        );
        console.log("MetaAgentRoundCoordinator:", address(coordinator));

        if (timeoutSlashBps != 9000) {
            coordinator.setTimeoutSlashBps(timeoutSlashBps);
            console.log("MetaAgentRoundCoordinator timeoutSlashBps set to:", timeoutSlashBps);
        }

        MetaAgentActionRouter actionRouter =
            new MetaAgentActionRouter(address(parameters), address(constitutionalGovernor), address(runoffGovernor), deployer);
        console.log("MetaAgentActionRouter:", address(actionRouter));

        // Wire circular dependencies.
        runoffGovernor.setCoordinator(address(coordinator));
        runoffGovernor.setActionRouter(address(actionRouter));

        // Runtime lane executes via router; transfer parameter governance to router.
        parameters.transferGovernance(address(actionRouter));
        actionRouter.acceptParameterGovernance();
        console.log("MetaAgentGovernanceParameters governance moved to ActionRouter");

        _maybeSetSlashAuthority(nodeStakingManager, address(coordinator), setSlashAuthority, deployer);
        _handoffOwnership(
            constitutionalGovernor, runoffGovernor, coordinator, actionRouter, deployer, finalOwner
        );

        vm.stopBroadcast();

        console.log("");
        console.log("==================================================");
        console.log("Meta-Agent Governance Deployment Complete");
        console.log("==================================================");
        console.log("  MetaAgentConstitutionalGovernor:", address(constitutionalGovernor));
        console.log("  MetaAgentGovernanceParameters:", address(parameters));
        console.log("  MetaAgentRunoffGovernor:", address(runoffGovernor));
        console.log("  MetaAgentRoundCoordinator:", address(coordinator));
        console.log("  MetaAgentActionRouter:", address(actionRouter));
        console.log("");
    }

    function _checkTimelockDelay(address governanceTimelock, bool required) internal view {
        (bool ok, bytes memory data) = governanceTimelock.staticcall(
            abi.encodeWithSelector(ITimelockDelayLike.timelockDelay.selector)
        );
        if (!ok || data.length < 32) {
            if (required) revert TimelockDelayCheckFailed();
            console.log("WARNING: could not read governance timelock delay.");
            return;
        }

        uint256 delay = abi.decode(data, (uint256));
        if (delay != REQUIRED_CORE_TIMELOCK_DELAY) {
            if (required) {
                revert TimelockDelayMismatch(REQUIRED_CORE_TIMELOCK_DELAY, delay);
            }
            console.log("WARNING: MetaAgentConstitutionalGovernor expects timelockDelay == 7 days.");
            console.log("  current timelockDelay:", delay);
            console.log("  expected:", REQUIRED_CORE_TIMELOCK_DELAY);
        }
    }

    function _maybeSetSlashAuthority(
        address nodeStakingManager,
        address coordinator,
        bool setSlashAuthority,
        address deployer
    ) internal {
        if (!setSlashAuthority) {
            return;
        }

        address stakingOwner = INodeStakingAdmin(nodeStakingManager).owner();
        if (stakingOwner == deployer) {
            INodeStakingAdmin(nodeStakingManager).setSlashAuthority(coordinator);
            console.log("NodeStakingManager slashAuthority set to MetaAgentRoundCoordinator");
            return;
        }

        console.log("NOTICE: NodeStakingManager owner is not deployer.");
        console.log("  owner:", stakingOwner);
        console.log("  Submit governance action to set slashAuthority:", coordinator);
    }

    function _handoffOwnership(
        MetaAgentConstitutionalGovernor constitutionalGovernor,
        MetaAgentRunoffGovernor runoffGovernor,
        MetaAgentRoundCoordinator coordinator,
        MetaAgentActionRouter actionRouter,
        address deployer,
        address finalOwner
    ) internal {
        if (finalOwner == address(0) || finalOwner == deployer) {
            return;
        }

        if (IOwnableLike(address(constitutionalGovernor)).owner() == deployer) {
            constitutionalGovernor.transferOwnership(finalOwner);
        }
        if (IOwnableLike(address(runoffGovernor)).owner() == deployer) {
            runoffGovernor.transferOwnership(finalOwner);
        }
        if (IOwnableLike(address(coordinator)).owner() == deployer) {
            coordinator.transferOwnership(finalOwner);
        }
        if (IOwnableLike(address(actionRouter)).owner() == deployer) {
            actionRouter.transferOwnership(finalOwner);
        }

        console.log("Ownership handed off to:", finalOwner);
    }
}
