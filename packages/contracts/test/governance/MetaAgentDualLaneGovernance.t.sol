// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {IDAORegistry} from "../../src/governance/interfaces/IDAORegistry.sol";
import {IGovernableParameter} from "../../src/governance/interfaces/IGovernableParameter.sol";
import {INodeStakingManager} from "../../src/staking/INodeStakingManager.sol";
import {MetaAgentGovernanceParameters} from "../../src/governance/MetaAgentGovernanceParameters.sol";
import {MetaAgentRoundCoordinator} from "../../src/governance/MetaAgentRoundCoordinator.sol";
import {MetaAgentRunoffGovernor} from "../../src/governance/MetaAgentRunoffGovernor.sol";
import {MetaAgentActionRouter} from "../../src/governance/MetaAgentActionRouter.sol";
import {MetaAgentConstitutionalGovernor} from "../../src/governance/MetaAgentConstitutionalGovernor.sol";

contract MockVotesToken {
    mapping(address => uint256) public votes;
    uint256 public totalSupply;

    function setVotes(address account, uint256 amount) external {
        votes[account] = amount;
    }

    function setTotalSupply(uint256 amount) external {
        totalSupply = amount;
    }

    function getPastVotes(address account, uint256) external view returns (uint256) {
        return votes[account];
    }

    function getPastTotalSupply(uint256) external view returns (uint256) {
        return totalSupply;
    }
}

contract MockDAORegistry {
    mapping(bytes32 => IDAORegistry.BoardMember[]) internal _members;

    function setBoardMembers(bytes32 daoId, IDAORegistry.BoardMember[] memory members) external {
        delete _members[daoId];
        for (uint256 i = 0; i < members.length; i++) {
            _members[daoId].push(members[i]);
        }
    }

    function getBoardMembers(bytes32 daoId) external view returns (IDAORegistry.BoardMember[] memory) {
        return _members[daoId];
    }
}

contract MockNodeStakingManagerForCoordinator {
    mapping(bytes32 => address) public operators;
    bytes32 public lastSlashNodeId;
    uint256 public lastSlashBps;
    uint256 public slashCount;
    string public lastSlashReason;

    function setOperator(bytes32 nodeId, address operator_) external {
        operators[nodeId] = operator_;
    }

    function getNodeInfo(bytes32 nodeId)
        external
        view
        returns (INodeStakingManager.NodeStake memory node, INodeStakingManager.PerformanceMetrics memory perf, uint256)
    {
        node.nodeId = nodeId;
        node.operator = operators[nodeId];
        node.isActive = true;
        perf.uptimeScore = 10_000;
    }

    function slashNode(bytes32 nodeId, uint256 slashPercentageBPS, string calldata reason) external {
        lastSlashNodeId = nodeId;
        lastSlashBps = slashPercentageBPS;
        lastSlashReason = reason;
        slashCount += 1;
    }
}

contract MockRunoffGovernorReceiver {
    bytes32 public lastRoundId;
    bytes32 public lastDaoId;
    bytes32[3] public lastNodeIds;

    function createRoundFromCoordinator(
        bytes32 roundId,
        bytes32 daoId,
        bytes32[3] calldata nodeIds,
        bytes32[3] calldata,
        uint16[3] calldata,
        uint16[3] calldata
    ) external {
        lastRoundId = roundId;
        lastDaoId = daoId;
        lastNodeIds = nodeIds;
    }
}

contract MockConstitutionalGateway {
    bytes32 public lastProposalId;
    address public lastTarget;

    function submitCoreUpgradeProposal(address target, bytes calldata, string calldata, string calldata)
        external
        returns (bytes32 proposalId)
    {
        proposalId = keccak256(abi.encode(target, block.timestamp));
        lastProposalId = proposalId;
        lastTarget = target;
    }
}

contract MockCoreGovernanceTimelock {
    struct Proposal {
        address target;
        bytes data;
        uint256 executeAfter;
        bool executed;
    }

    uint256 public constant timelockDelay = 7 days;
    uint256 private _nonce;
    mapping(bytes32 => Proposal) public proposals;

    error TimelockNotReady();
    error InvalidProposal();
    error ExecutionFailed();

    function proposeUpgrade(address target, bytes calldata data, string calldata) external returns (bytes32 proposalId) {
        proposalId = keccak256(abi.encode(target, data, block.timestamp, _nonce++));
        proposals[proposalId] = Proposal({
            target: target,
            data: data,
            executeAfter: block.timestamp + timelockDelay,
            executed: false
        });
    }

    function canExecute(bytes32 proposalId) external view returns (bool) {
        Proposal memory proposal = proposals[proposalId];
        if (proposal.target == address(0) || proposal.executed) {
            return false;
        }
        return block.timestamp >= proposal.executeAfter;
    }

    function execute(bytes32 proposalId) external {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0) || proposal.executed) revert InvalidProposal();
        if (block.timestamp < proposal.executeAfter) revert TimelockNotReady();

        proposal.executed = true;
        (bool ok,) = proposal.target.call(proposal.data);
        if (!ok) revert ExecutionFailed();
    }
}

contract MockProtocolUpgradeTarget {
    uint256 public value;

    function setValue(uint256 newValue) external {
        value = newValue;
    }
}

contract MetaAgentDualLaneGovernanceTest is Test {
    bytes32 internal constant DAO_ID = keccak256("jeju-meta-dao");
    bytes32 internal constant PARAM_VOTE_BLEND_BPS = keccak256("meta.voteBlendBps");
    bytes32 internal constant PARAM_PROPOSER_SLA_SECONDS = keccak256("meta.proposerSlaSeconds");
    bytes4 internal constant VALUE_OUT_OF_RANGE_SELECTOR = bytes4(keccak256("ValueOutOfRange()"));

    address internal owner = makeAddr("owner");
    address internal boardA = makeAddr("board-a");
    address internal boardB = makeAddr("board-b");
    address internal stakeVoter = makeAddr("stake-voter");
    address internal constitutionalGov = makeAddr("constitutional-gov");

    function test_ParameterBounds_AreConstitutionalOnly() public {
        vm.startPrank(owner);
        MetaAgentGovernanceParameters params = new MetaAgentGovernanceParameters(owner, constitutionalGov);

        vm.expectRevert(VALUE_OUT_OF_RANGE_SELECTOR);
        params.setParameter(PARAM_VOTE_BLEND_BPS, abi.encode(uint256(9500)));

        vm.expectRevert(MetaAgentGovernanceParameters.NotConstitutionalGovernor.selector);
        params.setParameterBounds(PARAM_VOTE_BLEND_BPS, 6000, 8500);

        vm.stopPrank();

        vm.prank(constitutionalGov);
        params.setParameterBounds(PARAM_VOTE_BLEND_BPS, 6000, 8500);

        IGovernableParameter.ParameterInfo memory info = params.getParameterInfo(PARAM_VOTE_BLEND_BPS);
        assertEq(info.minValue, 6000);
        assertEq(info.maxValue, 8500);

        vm.prank(owner);
        vm.expectRevert(VALUE_OUT_OF_RANGE_SELECTOR);
        params.setParameter(PARAM_VOTE_BLEND_BPS, abi.encode(uint256(8600)));
    }

    function test_TimeoutSlash_RedrawsAndUses90PercentBps() public {
        vm.startPrank(owner);
        MetaAgentGovernanceParameters params = new MetaAgentGovernanceParameters(owner, constitutionalGov);
        params.setParameter(PARAM_PROPOSER_SLA_SECONDS, abi.encode(uint256(300)));

        MockNodeStakingManagerForCoordinator staking = new MockNodeStakingManagerForCoordinator();
        MockRunoffGovernorReceiver runoffReceiver = new MockRunoffGovernorReceiver();
        MetaAgentRoundCoordinator coordinator = new MetaAgentRoundCoordinator(
            address(staking), address(params), address(runoffReceiver), owner, owner
        );
        vm.stopPrank();

        bytes32[] memory eligible = new bytes32[](4);
        eligible[0] = keccak256("node-0");
        eligible[1] = keccak256("node-1");
        eligible[2] = keccak256("node-2");
        eligible[3] = keccak256("node-3");

        for (uint256 i = 0; i < eligible.length; i++) {
            staking.setOperator(eligible[i], owner);
        }

        bytes32 roundId = keccak256("round-timeout");
        vm.prank(owner);
        coordinator.startRound(roundId, keccak256("entropy"), eligible);

        (,,,, bytes32[3] memory selectedNodeIds,,,,,,) = coordinator.getRound(roundId);
        bytes32 oldSlot0Node = selectedNodeIds[0];

        vm.warp(block.timestamp + 301);
        coordinator.slashTimeoutAndRedraw(roundId, 0);

        assertEq(staking.lastSlashNodeId(), oldSlot0Node);
        assertEq(staking.lastSlashBps(), 9000);
        assertEq(staking.slashCount(), 1);

        (,,,, bytes32[3] memory updatedNodeIds,,,,,,) = coordinator.getRound(roundId);
        assertTrue(updatedNodeIds[0] != oldSlot0Node);
    }

    function test_DynamicParticipationWeight_IncreasesWhenTurnoutDropsAndCaps() public {
        vm.startPrank(owner);
        MetaAgentGovernanceParameters params = new MetaAgentGovernanceParameters(owner, constitutionalGov);
        MockDAORegistry daoRegistry = new MockDAORegistry();
        MockVotesToken votes = new MockVotesToken();
        votes.setTotalSupply(1_000);
        MetaAgentRunoffGovernor runoff =
            new MetaAgentRunoffGovernor(address(daoRegistry), address(params), address(votes), owner, owner);
        vm.stopPrank();

        _setBoardMembers(daoRegistry, 60, 40);
        _createRound(runoff, keccak256("round-turnout"));

        (uint256 turnoutLow, uint256 weightLow,,) = runoff.getRoundScores(keccak256("round-turnout"), true);
        assertEq(turnoutLow, 0);
        assertEq(weightLow, params.maxParticipationWeightBps());

        vm.prank(boardA);
        runoff.castBoardVote(keccak256("round-turnout"), 0);
        vm.prank(boardB);
        runoff.castBoardVote(keccak256("round-turnout"), 1);

        (uint256 turnoutHigh, uint256 weightHigh,,) = runoff.getRoundScores(keccak256("round-turnout"), true);
        assertEq(turnoutHigh, 10_000);
        assertEq(weightHigh, params.baseParticipationWeightBps());
    }

    function test_ZeroVoteRounds_UseCompositeForBoardStakeAndWinnerSelection() public {
        vm.startPrank(owner);
        MetaAgentGovernanceParameters params = new MetaAgentGovernanceParameters(owner, constitutionalGov);
        MockDAORegistry daoRegistry = new MockDAORegistry();
        MockVotesToken votes = new MockVotesToken();
        votes.setTotalSupply(1_000);
        MetaAgentRunoffGovernor runoff =
            new MetaAgentRunoffGovernor(address(daoRegistry), address(params), address(votes), owner, owner);
        vm.stopPrank();

        _setBoardMembers(daoRegistry, 70, 30);

        bytes32 roundId = keccak256("round-zero-votes");
        bytes32[3] memory nodeIds = [keccak256("node-a"), keccak256("node-b"), keccak256("node-c")];
        bytes32[3] memory proposalHashes = [keccak256("p-a"), keccak256("p-b"), keccak256("p-c")];
        uint16[3] memory serviceQoS = [uint16(9000), uint16(7000), uint16(4000)];
        uint16[3] memory participation = [uint16(1000), uint16(7000), uint16(9500)];

        vm.prank(owner);
        runoff.createRoundFromCoordinator(roundId, DAO_ID, nodeIds, proposalHashes, serviceQoS, participation);

        vm.warp(block.timestamp + params.boardRoundSeconds() + 1);
        runoff.finalizeBoardRound(roundId);

        (, uint256 participationWeightBoard, uint256[3] memory boardComposite, uint256[3] memory boardFinal) =
            runoff.getRoundScores(roundId, true);
        assertEq(participationWeightBoard, params.maxParticipationWeightBps());
        assertEq(boardFinal[0], boardComposite[0]);
        assertEq(boardFinal[1], boardComposite[1]);
        assertEq(boardFinal[2], boardComposite[2]);

        (,,,,,,, uint256 finalizeAfter,,,,,,,,) = runoff.rounds(roundId);
        vm.warp(finalizeAfter + 1);
        runoff.finalizeRound(roundId);

        (, uint256 participationWeightStake, uint256[3] memory stakeComposite, uint256[3] memory stakeFinal) =
            runoff.getRoundScores(roundId, false);
        assertEq(participationWeightStake, params.maxParticipationWeightBps());
        assertEq(stakeFinal[0], stakeComposite[0]);
        assertEq(stakeFinal[1], stakeComposite[1]);
        assertEq(stakeFinal[2], stakeComposite[2]);

        (,,,,,,,,,,,,, uint8 winnerIndex,,) = runoff.rounds(roundId);
        assertEq(winnerIndex, 1);
    }

    function test_RuntimeLaneParameterUpdate_ChangesScoresWithoutRedeploy() public {
        vm.startPrank(owner);
        MetaAgentGovernanceParameters params = new MetaAgentGovernanceParameters(owner, constitutionalGov);
        MockDAORegistry daoRegistry = new MockDAORegistry();
        MockVotesToken votes = new MockVotesToken();
        votes.setTotalSupply(2_000);
        votes.setVotes(stakeVoter, 1_000);

        MetaAgentRunoffGovernor runoff =
            new MetaAgentRunoffGovernor(address(daoRegistry), address(params), address(votes), owner, owner);
        MockConstitutionalGateway constitutionalGateway = new MockConstitutionalGateway();
        MetaAgentActionRouter router =
            new MetaAgentActionRouter(address(params), address(constitutionalGateway), address(runoff), owner);
        runoff.setActionRouter(address(router));

        params.transferGovernance(address(router));
        vm.stopPrank();
        vm.prank(owner);
        router.acceptParameterGovernance();

        _setBoardMembers(daoRegistry, 50, 50);

        bytes32 roundId = keccak256("round-runtime-lane");
        bytes32[3] memory nodeIds = [keccak256("node-1"), keccak256("node-2"), keccak256("node-3")];
        bytes32[3] memory proposalHashes = [keccak256("h-1"), keccak256("h-2"), keccak256("h-3")];
        uint16[3] memory serviceQoS = [uint16(6000), uint16(9000), uint16(3000)];
        uint16[3] memory participation = [uint16(6000), uint16(3000), uint16(6000)];

        vm.prank(owner);
        runoff.createRoundFromCoordinator(roundId, DAO_ID, nodeIds, proposalHashes, serviceQoS, participation);

        vm.prank(boardA);
        runoff.castBoardVote(roundId, 0);
        vm.prank(boardB);
        runoff.castBoardVote(roundId, 0);

        vm.warp(block.timestamp + params.boardRoundSeconds() + 1);
        runoff.finalizeBoardRound(roundId);

        vm.prank(stakeVoter);
        runoff.castStakeVote(roundId, 0);

        (,,, uint256[3] memory beforeScores) = runoff.getRoundScores(roundId, false);

        (,,,,,,, uint256 finalizeAfter,,,,,,,,) = runoff.rounds(roundId);
        vm.warp(finalizeAfter + 1);
        runoff.finalizeRound(roundId);

        bytes32 actionId = runoff.queueRuntimeWinnerParameterUpdate(roundId, PARAM_VOTE_BLEND_BPS, 8000);

        vm.expectRevert(MetaAgentActionRouter.RuntimeActionNotReady.selector);
        router.executeRuntimeParameterAction(actionId);

        vm.warp(block.timestamp + params.runtimeDelaySeconds() + 1);
        router.executeRuntimeParameterAction(actionId);

        assertEq(params.voteBlendBps(), 8000);

        (,,, uint256[3] memory afterScores) = runoff.getRoundScores(roundId, false);
        assertGt(afterScores[0], beforeScores[0]);
    }

    function test_ConstitutionalEarlyPass_RequiresStrictlyMoreThan50Percent() public {
        MockVotesToken votes = new MockVotesToken();
        votes.setTotalSupply(1_000);
        address voterA = makeAddr("voter-a");
        address voterB = makeAddr("voter-b");
        votes.setVotes(voterA, 500);
        votes.setVotes(voterB, 1);

        MockCoreGovernanceTimelock timelock = new MockCoreGovernanceTimelock();
        MockProtocolUpgradeTarget target = new MockProtocolUpgradeTarget();

        MetaAgentConstitutionalGovernor governor =
            new MetaAgentConstitutionalGovernor(address(votes), address(timelock), address(target), owner);

        bytes memory data = abi.encodeWithSelector(MockProtocolUpgradeTarget.setValue.selector, uint256(42));
        bytes32 proposalId = governor.submitCoreUpgradeProposal(address(target), data, "core-upgrade", "ipfs://proposal");

        assertEq(governor.requiredVotesToPass(proposalId), 501);

        vm.prank(voterA);
        governor.castVote(proposalId, true);

        vm.expectRevert(MetaAgentConstitutionalGovernor.ProposalNotQueued.selector);
        governor.executeQueuedProposal(proposalId);

        vm.prank(voterB);
        governor.castVote(proposalId, true);

        vm.expectRevert(MetaAgentConstitutionalGovernor.TimelockNotReady.selector);
        governor.executeQueuedProposal(proposalId);
    }

    function test_ConstitutionalSuccess_StillWaitsSevenDayTimelockBeforeExecution() public {
        MockVotesToken votes = new MockVotesToken();
        votes.setTotalSupply(1_000);
        address voter = makeAddr("voter");
        votes.setVotes(voter, 700);

        MockCoreGovernanceTimelock timelock = new MockCoreGovernanceTimelock();
        MockProtocolUpgradeTarget target = new MockProtocolUpgradeTarget();

        MetaAgentConstitutionalGovernor governor =
            new MetaAgentConstitutionalGovernor(address(votes), address(timelock), address(target), owner);

        bytes memory data = abi.encodeWithSelector(MockProtocolUpgradeTarget.setValue.selector, uint256(777));
        bytes32 proposalId = governor.submitCoreUpgradeProposal(address(target), data, "core-upgrade", "ipfs://proposal");

        vm.prank(voter);
        governor.castVote(proposalId, true);

        vm.expectRevert(MetaAgentConstitutionalGovernor.TimelockNotReady.selector);
        governor.executeQueuedProposal(proposalId);

        vm.warp(block.timestamp + 7 days + 1);
        governor.executeQueuedProposal(proposalId);

        assertEq(target.value(), 777);
    }

    function _setBoardMembers(MockDAORegistry daoRegistry, uint256 weightA, uint256 weightB) internal {
        IDAORegistry.BoardMember[] memory members = new IDAORegistry.BoardMember[](2);
        members[0] = IDAORegistry.BoardMember({
            member: boardA,
            agentId: 0,
            role: "board-a",
            weight: weightA,
            addedAt: block.timestamp,
            isActive: true,
            isHuman: true
        });
        members[1] = IDAORegistry.BoardMember({
            member: boardB,
            agentId: 0,
            role: "board-b",
            weight: weightB,
            addedAt: block.timestamp,
            isActive: true,
            isHuman: true
        });
        daoRegistry.setBoardMembers(DAO_ID, members);
    }

    function _createRound(MetaAgentRunoffGovernor runoff, bytes32 roundId) internal {
        bytes32[3] memory nodeIds = [keccak256("node-0"), keccak256("node-1"), keccak256("node-2")];
        bytes32[3] memory proposalHashes = [keccak256("proposal-0"), keccak256("proposal-1"), keccak256("proposal-2")];
        uint16[3] memory serviceQoS = [uint16(8000), uint16(7500), uint16(6000)];
        uint16[3] memory participation = [uint16(7000), uint16(8200), uint16(5000)];

        vm.prank(owner);
        runoff.createRoundFromCoordinator(roundId, DAO_ID, nodeIds, proposalHashes, serviceQoS, participation);
    }
}
