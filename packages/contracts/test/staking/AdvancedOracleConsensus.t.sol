// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {INodeStakingManager} from "../../src/staking/INodeStakingManager.sol";
import {OraclePowerRegistry} from "../../src/staking/OraclePowerRegistry.sol";
import {AdvancedOracleConsensus} from "../../src/staking/AdvancedOracleConsensus.sol";
import {OracleSlashGovernor} from "../../src/staking/OracleSlashGovernor.sol";

contract MockNodeStakingManagerForOracle is INodeStakingManager {
    bytes32 public lastUpdatedNodeId;
    uint256 public lastUptimeScore;
    uint256 public lastRequestsServed;
    uint256 public lastAvgResponseTime;
    bytes32 public lastSlashedNodeId;
    uint256 public lastSlashBps;
    string public lastSlashReason;

    function registerNode(address, uint256, address, string calldata, Region) external pure returns (bytes32) {
        return bytes32(0);
    }

    function claimRewards(bytes32) external pure {}

    function deregisterNode(bytes32) external pure {}

    function updatePerformance(bytes32 nodeId, uint256 uptimeScore, uint256 requestsServed, uint256 avgResponseTime)
        external
    {
        lastUpdatedNodeId = nodeId;
        lastUptimeScore = uptimeScore;
        lastRequestsServed = requestsServed;
        lastAvgResponseTime = avgResponseTime;
    }

    function slashNode(bytes32 nodeId, uint256 slashPercentageBPS, string calldata reason) external {
        lastSlashedNodeId = nodeId;
        lastSlashBps = slashPercentageBPS;
        lastSlashReason = reason;
    }

    function getNodeInfo(bytes32)
        external
        pure
        returns (NodeStake memory node, PerformanceMetrics memory perf, uint256 pendingRewardsUSD)
    {
        return (node, perf, pendingRewardsUSD);
    }

    function getOperatorNodes(address) external pure returns (bytes32[] memory nodeIds) {
        nodeIds = new bytes32[](0);
    }

    function calculatePendingRewards(bytes32) external pure returns (uint256 rewardsUSD) {
        return rewardsUSD;
    }

    function getNetworkStats()
        external
        pure
        returns (uint256 totalNodesActive, uint256 totalStakedUSD, uint256 totalRewardsClaimedUSD)
    {
        return (0, 0, 0);
    }

    function getTokenDistribution(address) external pure returns (TokenDistribution memory distribution) {
        return distribution;
    }

    function getOperatorStats(address) external pure returns (OperatorStats memory stats) {
        return stats;
    }

    function getOperatorNodeLimit(address) external pure returns (uint256 maxNodes) {
        return maxNodes;
    }

    function getOperatorNodeLimitForStakeUSD(uint256) external pure returns (uint256 maxNodes) {
        return maxNodes;
    }

    function getOperatorNodeCapTiers()
        external
        pure
        returns (uint256[] memory stakeThresholdsUSD, uint256[] memory multipliers)
    {
        stakeThresholdsUSD = new uint256[](0);
        multipliers = new uint256[](0);
    }

    function setMinStakeUSD(uint256) external pure {}

    function setBaseNodesPerOperator(uint256) external pure {}

    function setOperatorNodeCapTiers(uint256[] calldata, uint256[] calldata) external pure {}

    function setPaymasterFees(uint256, uint256) external pure {}

    function addPerformanceOracle(address) external pure {}

    function pause() external pure {}

    function unpause() external pure {}
}

contract AdvancedOracleConsensusTest is Test {
    MockERC20 internal oracleToken;
    MockNodeStakingManagerForOracle internal stakingManager;
    OraclePowerRegistry internal registry;
    AdvancedOracleConsensus internal consensus;
    OracleSlashGovernor internal slashGovernor;

    address internal owner = address(0x100);
    address internal oracle1 = address(0x101);
    address internal oracle2 = address(0x102);
    address internal oracle3 = address(0x103);
    address internal oracle4 = address(0x104);
    address internal oracle5 = address(0x105);
    address internal permissionless1 = address(0x201);
    address internal permissionless2 = address(0x202);
    address internal permissionless3 = address(0x203);

    bytes32 internal nodeId = keccak256("node-1");

    function setUp() public {
        oracleToken = new MockERC20("Oracle", "ORC", 18, 1_000_000 ether);
        stakingManager = new MockNodeStakingManagerForOracle();

        vm.prank(owner);
        registry = new OraclePowerRegistry(address(oracleToken), owner, 10_000_000, 5, 100);

        vm.prank(owner);
        consensus = new AdvancedOracleConsensus(address(stakingManager), address(registry), owner, 100, 3, 6000, 6700);

        vm.prank(owner);
        slashGovernor = new OracleSlashGovernor(address(stakingManager), address(registry), owner, 8000, 6700, 10, 100);

        vm.prank(owner);
        consensus.setSlashGovernor(address(slashGovernor));
        vm.prank(owner);
        slashGovernor.setConsensus(address(consensus));

        oracleToken.transfer(permissionless1, 50_000 ether);
        oracleToken.transfer(permissionless2, 50_000 ether);
        oracleToken.transfer(permissionless3, 50_000 ether);

        vm.prank(permissionless1);
        oracleToken.approve(address(registry), type(uint256).max);
        vm.prank(permissionless2);
        oracleToken.approve(address(registry), type(uint256).max);
        vm.prank(permissionless3);
        oracleToken.approve(address(registry), type(uint256).max);
    }

    function test_BootstrapConsensus_ReachesFinalityWithApprovedOracles() public {
        _approveBootstrap(oracle1);
        _approveBootstrap(oracle2);
        _approveBootstrap(oracle3);

        uint256 epoch = consensus.currentEpoch();

        vm.prank(oracle1);
        consensus.submitPerformance(nodeId, epoch, 9900, 1000, 50, bytes32("a"), false, 0);
        vm.prank(oracle2);
        consensus.submitPerformance(nodeId, epoch, 9925, 1200, 45, bytes32("b"), false, 0);
        vm.prank(oracle3);
        consensus.submitPerformance(nodeId, epoch, 9950, 1100, 55, bytes32("c"), false, 0);

        assertEq(stakingManager.lastUpdatedNodeId(), nodeId);
        assertEq(stakingManager.lastUptimeScore(), 9925);
        assertEq(stakingManager.lastRequestsServed(), 1100);
        assertEq(stakingManager.lastAvgResponseTime(), 50);
    }

    function test_AdvancedMode_UsesStakeWeightedMedian() public {
        _approveBootstrap(oracle1);
        _approveBootstrap(oracle2);
        _approveBootstrap(oracle3);
        _approveBootstrap(oracle4);
        _approveBootstrap(oracle5);

        vm.roll(block.number + 10_000_001);
        registry.maybeActivateAdvancedMode();
        assertTrue(registry.advancedMode());

        vm.prank(permissionless1);
        registry.stakeAsOracle(20_000 ether);
        vm.prank(permissionless2);
        registry.stakeAsOracle(15_000 ether);
        vm.prank(permissionless3);
        registry.stakeAsOracle(10_000 ether);

        uint256 epoch = consensus.currentEpoch();

        vm.prank(permissionless1);
        consensus.submitPerformance(nodeId, epoch, 7000, 500, 200, bytes32("x"), false, 0);
        vm.prank(permissionless2);
        consensus.submitPerformance(nodeId, epoch, 9950, 900, 60, bytes32("y"), false, 0);
        vm.prank(permissionless3);
        consensus.submitPerformance(nodeId, epoch, 9960, 1000, 55, bytes32("z"), false, 0);

        assertEq(stakingManager.lastUpdatedNodeId(), nodeId);
        assertEq(stakingManager.lastUptimeScore(), 9950);
        assertEq(stakingManager.lastRequestsServed(), 900);
        assertEq(stakingManager.lastAvgResponseTime(), 60);
    }

    function test_DuplicateSubmission_Reverts() public {
        _approveBootstrap(oracle1);
        _approveBootstrap(oracle2);
        _approveBootstrap(oracle3);

        uint256 epoch = consensus.currentEpoch();

        vm.prank(oracle1);
        consensus.submitPerformance(nodeId, epoch, 9900, 1000, 50, bytes32("a"), false, 0);

        vm.prank(oracle1);
        vm.expectRevert(AdvancedOracleConsensus.DuplicateSubmission.selector);
        consensus.submitPerformance(nodeId, epoch, 9901, 1001, 51, bytes32("b"), false, 0);
    }

    function test_Registry_UnstakeBelowThreshold_RemovesOracleWeight() public {
        _approveBootstrap(oracle1);
        _approveBootstrap(oracle2);
        _approveBootstrap(oracle3);
        _approveBootstrap(oracle4);
        _approveBootstrap(oracle5);

        vm.roll(block.number + 10_000_001);
        registry.maybeActivateAdvancedMode();

        vm.prank(permissionless1);
        registry.stakeAsOracle(20_000 ether);
        vm.prank(permissionless2);
        registry.stakeAsOracle(15_000 ether);
        vm.prank(permissionless3);
        registry.stakeAsOracle(10_000 ether);

        assertEq(registry.totalConsensusWeight(), 45_000 ether);
        assertEq(registry.activePermissionlessOracleCount(), 3);

        vm.prank(permissionless2);
        registry.unstakeOracle(6_000 ether);

        assertEq(registry.totalConsensusWeight(), 30_000 ether);
        assertEq(registry.activePermissionlessOracleCount(), 2);
        assertFalse(registry.isEligibleOracle(permissionless2));
    }

    function test_SlashGovernor_FastTrackExecutesAfterStrongSupport() public {
        _approveBootstrap(oracle1);
        _approveBootstrap(oracle2);
        _approveBootstrap(oracle3);
        _approveBootstrap(oracle4);
        _approveBootstrap(oracle5);

        vm.roll(block.number + 10_000_001);
        registry.maybeActivateAdvancedMode();

        vm.prank(permissionless1);
        registry.stakeAsOracle(20_000 ether);
        vm.prank(permissionless2);
        registry.stakeAsOracle(15_000 ether);
        vm.prank(permissionless3);
        registry.stakeAsOracle(10_000 ether);

        uint256 epoch = consensus.currentEpoch();

        vm.prank(permissionless1);
        consensus.submitPerformance(nodeId, epoch, 5000, 100, 500, bytes32("slash"), true, 2500);
        vm.prank(permissionless2);
        consensus.submitPerformance(nodeId, epoch, 5100, 110, 450, bytes32("slash"), true, 2500);
        vm.prank(permissionless3);
        consensus.submitPerformance(nodeId, epoch, 5200, 120, 400, bytes32("slash"), true, 2500);

        bytes32 proposalId = slashGovernor.proposalId(nodeId, epoch, bytes32("slash"));
        (,,,,,, uint256 yesWeight,,) = slashGovernor.proposals(proposalId);
        assertEq(yesWeight, 0);

        vm.prank(permissionless1);
        slashGovernor.vote(proposalId, true);
        vm.prank(permissionless2);
        slashGovernor.vote(proposalId, true);
        vm.prank(permissionless3);
        slashGovernor.vote(proposalId, true);

        vm.roll(block.number + 11);
        slashGovernor.executeProposal(proposalId);

        assertEq(stakingManager.lastSlashedNodeId(), nodeId);
        assertEq(stakingManager.lastSlashBps(), 2500);
    }

    function _approveBootstrap(address oracle) internal {
        vm.prank(owner);
        registry.approveBootstrapOracle(oracle);
    }
}
