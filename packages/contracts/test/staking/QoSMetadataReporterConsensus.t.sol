// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {OraclePowerRegistry} from "../../src/staking/OraclePowerRegistry.sol";
import {QoSMetadataReporterConsensus} from "../../src/staking/QoSMetadataReporterConsensus.sol";
import {IdentityRegistry} from "../../src/registry/IdentityRegistry.sol";
import {GovernanceTimelock} from "../../src/governance/GovernanceTimelock.sol";

contract QoSMetadataReporterConsensusTest is Test {
    MockERC20 internal jejuToken;
    OraclePowerRegistry internal powerRegistry;
    IdentityRegistry internal identityRegistry;
    QoSMetadataReporterConsensus internal consensus;

    address internal owner = address(0x100);
    address internal reporter1 = address(0x101);
    address internal reporter2 = address(0x102);
    address internal agentOwner = address(0x200);
    address internal daoGovernance = address(0x300);
    address internal securityBoard = address(0x301);

    uint256 internal agentId;

    function setUp() public {
        jejuToken = new MockERC20("Jeju", "JEJU", 18, 1_000_000 ether);

        vm.prank(owner);
        powerRegistry = new OraclePowerRegistry(address(jejuToken), owner, 1, 1, 1);

        identityRegistry = new IdentityRegistry();

        vm.prank(owner);
        consensus = new QoSMetadataReporterConsensus(
            address(powerRegistry),
            address(identityRegistry),
            owner,
            2,
            5001,
            60,
            3600
        );

        identityRegistry.setMetadataReporter(address(consensus), true);

        vm.prank(agentOwner);
        agentId = identityRegistry.register("ipfs://agent");

        jejuToken.transfer(reporter1, 1_000 ether);
        jejuToken.transfer(reporter2, 1_000 ether);

        vm.prank(reporter1);
        jejuToken.approve(address(powerRegistry), type(uint256).max);
        vm.prank(reporter2);
        jejuToken.approve(address(powerRegistry), type(uint256).max);
    }

    function test_ProposalNeedsMOfNAndOver50PercentStake() public {
        _activateStakeWeightedMode();

        vm.prank(reporter1);
        powerRegistry.stakeAsOracle(600 ether);
        vm.prank(reporter2);
        powerRegistry.stakeAsOracle(400 ether);

        string[] memory keys = new string[](1);
        keys[0] = "qos.summary.v1";
        bytes[] memory values = new bytes[](1);
        values[0] = bytes("{\"latest\":{\"uptimeBps\":9900}}");

        vm.prank(reporter1);
        (bytes32 proposalId, bool created, bool executedNow) =
            consensus.proposeOrApproveMetadataUpdate(agentId, keys, values, 300);

        assertTrue(created);
        assertFalse(executedNow);
        assertFalse(consensus.canExecute(proposalId)); // 1-of-2 fails m-of-n

        vm.prank(reporter2);
        (bytes32 sameProposalId, bool createdAgain, bool executedAfterSecondApproval) =
            consensus.proposeOrApproveMetadataUpdate(agentId, keys, values, 300);

        assertEq(sameProposalId, proposalId);
        assertFalse(createdAgain);
        assertTrue(executedAfterSecondApproval);

        bytes memory stored = identityRegistry.getMetadata(agentId, "qos.summary.v1");
        assertEq(stored, values[0]);
    }

    function test_MetadataReporterRejectsNonQoSNamespace() public {
        bytes memory value = bytes("bad");

        vm.prank(address(consensus));
        vm.expectRevert(bytes("Invalid metadata namespace"));
        identityRegistry.setMetadataByAuthorizedReporter(agentId, "serviceType", value);
    }

    function test_RevertBeforeStakeWeightedMode() public {
        string[] memory keys = new string[](1);
        keys[0] = "qos.summary.v1";
        bytes[] memory values = new bytes[](1);
        values[0] = bytes("{\"latest\":{\"uptimeBps\":9000}}");

        vm.prank(owner);
        powerRegistry.approveBootstrapOracle(reporter1);

        vm.prank(reporter1);
        vm.expectRevert(QoSMetadataReporterConsensus.StakeWeightedModeRequired.selector);
        consensus.proposeOrApproveMetadataUpdate(agentId, keys, values, 300);
    }

    function test_GovernanceCanDeprecateAndReplaceConsensus() public {
        vm.prank(owner);
        consensus.deprecateAndSetReplacement(address(0x999));

        assertTrue(consensus.deprecated());
        assertEq(consensus.replacementConsensus(), address(0x999));

        string[] memory keys = new string[](1);
        keys[0] = "qos.summary.v1";
        bytes[] memory values = new bytes[](1);
        values[0] = bytes("{\"latest\":{\"uptimeBps\":8000}}");

        vm.prank(reporter1);
        vm.expectRevert(QoSMetadataReporterConsensus.ContractDeprecated.selector);
        consensus.proposeOrApproveMetadataUpdate(agentId, keys, values, 300);
    }

    function test_JejuDaoTimelockCanRotateConsensusContract() public {
        uint256 timelockDelay = 1 hours;

        vm.prank(owner);
        GovernanceTimelock timelock = new GovernanceTimelock(daoGovernance, securityBoard, owner, timelockDelay);

        vm.prank(owner);
        consensus.transferOwnership(address(timelock));

        identityRegistry.setGovernance(address(timelock));

        vm.prank(owner);
        QoSMetadataReporterConsensus nextConsensus = new QoSMetadataReporterConsensus(
            address(powerRegistry),
            address(identityRegistry),
            address(timelock),
            2,
            5500,
            120,
            7200
        );

        bytes memory rotateReporterCall = abi.encodeWithSelector(
            IdentityRegistry.replaceMetadataReporter.selector, address(consensus), address(nextConsensus)
        );
        bytes memory deprecateCall =
            abi.encodeWithSelector(consensus.deprecateAndSetReplacement.selector, address(nextConsensus));
        bytes memory updateThresholdsCall =
            abi.encodeWithSelector(nextConsensus.setConsensusConfig.selector, 3, 6000, 180, 10_800);

        vm.startPrank(daoGovernance);
        bytes32 rotateProposalId =
            timelock.proposeUpgrade(address(identityRegistry), rotateReporterCall, "Rotate QoS metadata reporter");
        bytes32 deprecateProposalId =
            timelock.proposeUpgrade(address(consensus), deprecateCall, "Deprecate old QoS consensus");
        bytes32 configProposalId =
            timelock.proposeUpgrade(address(nextConsensus), updateThresholdsCall, "Update next consensus thresholds");
        vm.stopPrank();

        vm.warp(block.timestamp + timelockDelay + 1);

        timelock.execute(rotateProposalId);
        timelock.execute(deprecateProposalId);
        timelock.execute(configProposalId);

        assertFalse(identityRegistry.authorizedMetadataReporters(address(consensus)));
        assertTrue(identityRegistry.authorizedMetadataReporters(address(nextConsensus)));

        assertTrue(consensus.deprecated());
        assertEq(consensus.replacementConsensus(), address(nextConsensus));

        assertEq(nextConsensus.minimumReporterCount(), 3);
        assertEq(nextConsensus.supportThresholdBps(), 6000);
        assertEq(nextConsensus.minProposalDuration(), 180);
        assertEq(nextConsensus.maxProposalDuration(), 10_800);
    }

    function _activateStakeWeightedMode() internal {
        vm.prank(owner);
        powerRegistry.approveBootstrapOracle(reporter1);
        vm.roll(block.number + 2);
        powerRegistry.maybeActivateAdvancedMode();
        assertTrue(powerRegistry.advancedMode());
    }
}
