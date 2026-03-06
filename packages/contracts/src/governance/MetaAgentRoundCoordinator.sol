// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {INodeStakingManager} from "../staking/INodeStakingManager.sol";

interface IMetaAgentRuntimeParameters {
    function proposerSlaSeconds() external view returns (uint256);
}

interface IMetaAgentRunoffGovernor {
    function createRoundFromCoordinator(
        bytes32 roundId,
        bytes32 daoId,
        bytes32[3] calldata nodeIds,
        bytes32[3] calldata proposalHashes,
        uint16[3] calldata serviceQoSBps,
        uint16[3] calldata participationScoresBps
    ) external;
}

/**
 * @title MetaAgentRoundCoordinator
 * @notice Selects 3 proposers, enforces proposer SLA, and queues timeout slashing/redraw.
 * @dev Eligibility filtering (QoSV/attestation/service capability) is expected off-chain and
 *      supplied as the eligible node list for each round.
 */
contract MetaAgentRoundCoordinator is Ownable {
    struct Candidate {
        bytes32 nodeId;
        bytes32 proposalHash;
        uint16 serviceQoSBps;
        uint16 participationScoreBps;
        bool submitted;
        bool timedOut;
    }

    struct Round {
        bytes32 entropy;
        uint256 createdAt;
        uint256 proposerDeadline;
        uint256 drawNonce;
        bool votingOpened;
        bytes32[] eligibleNodeIds;
        Candidate[3] candidates;
    }

    INodeStakingManager public immutable stakingManager;
    IMetaAgentRuntimeParameters public parameters;
    IMetaAgentRunoffGovernor public runoffGovernor;

    address public roundManager;
    uint256 public timeoutSlashBps = 9000;

    mapping(bytes32 => Round) private _rounds;
    mapping(bytes32 => bool) public roundExists;
    mapping(bytes32 => mapping(bytes32 => bool)) public nodeUnavailableForRound;

    event RoundManagerUpdated(address indexed oldManager, address indexed newManager);
    event ParametersUpdated(address indexed oldParameters, address indexed newParameters);
    event RunoffGovernorUpdated(address indexed oldGovernor, address indexed newGovernor);
    event TimeoutSlashBpsUpdated(uint256 oldSlashBps, uint256 newSlashBps);

    event RoundStarted(bytes32 indexed roundId, bytes32 entropy, uint256 proposerDeadline, uint256 eligibleCount);
    event ProposerSelected(bytes32 indexed roundId, uint8 indexed slot, bytes32 indexed nodeId);
    event ProposalSubmitted(bytes32 indexed roundId, uint8 indexed slot, bytes32 indexed nodeId, bytes32 proposalHash);
    event ProposerDeclined(bytes32 indexed roundId, uint8 indexed slot, bytes32 indexed nodeId, string reason);
    event ProposerTimedOut(bytes32 indexed roundId, uint8 indexed slot, bytes32 indexed nodeId, string reason);
    event ProposerRedrawn(bytes32 indexed roundId, uint8 indexed slot, bytes32 indexed oldNodeId, bytes32 newNodeId);
    event VotingOpened(bytes32 indexed roundId, bytes32 indexed daoId);

    error NotRoundManager();
    error InvalidAddress();
    error InvalidConfig();
    error RoundAlreadyExists();
    error RoundNotFound();
    error RoundAlreadyOpened();
    error InsufficientEligibleNodes();
    error ProposerWindowClosed();
    error ProposerWindowOpen();
    error CandidateNotFound();
    error CandidateAlreadySubmitted();
    error CandidateAlreadyTimedOut();
    error UnauthorizedCandidateOperator();
    error InvalidScore();

    modifier onlyRoundManager() {
        if (msg.sender != roundManager && msg.sender != owner()) revert NotRoundManager();
        _;
    }

    constructor(
        address _stakingManager,
        address _parameters,
        address _runoffGovernor,
        address initialOwner,
        address initialRoundManager
    ) Ownable(initialOwner) {
        if (_stakingManager == address(0) || _parameters == address(0) || _runoffGovernor == address(0)) {
            revert InvalidAddress();
        }

        stakingManager = INodeStakingManager(_stakingManager);
        parameters = IMetaAgentRuntimeParameters(_parameters);
        runoffGovernor = IMetaAgentRunoffGovernor(_runoffGovernor);
        roundManager = initialRoundManager;
    }

    function setRoundManager(address newRoundManager) external onlyOwner {
        address oldManager = roundManager;
        roundManager = newRoundManager;
        emit RoundManagerUpdated(oldManager, newRoundManager);
    }

    function setParameters(address newParameters) external onlyOwner {
        if (newParameters == address(0)) revert InvalidAddress();
        address oldParameters = address(parameters);
        parameters = IMetaAgentRuntimeParameters(newParameters);
        emit ParametersUpdated(oldParameters, newParameters);
    }

    function setRunoffGovernor(address newRunoffGovernor) external onlyOwner {
        if (newRunoffGovernor == address(0)) revert InvalidAddress();
        address oldGovernor = address(runoffGovernor);
        runoffGovernor = IMetaAgentRunoffGovernor(newRunoffGovernor);
        emit RunoffGovernorUpdated(oldGovernor, newRunoffGovernor);
    }

    function setTimeoutSlashBps(uint256 newTimeoutSlashBps) external onlyOwner {
        if (newTimeoutSlashBps == 0 || newTimeoutSlashBps > 10_000) revert InvalidConfig();
        uint256 oldTimeoutSlashBps = timeoutSlashBps;
        timeoutSlashBps = newTimeoutSlashBps;
        emit TimeoutSlashBpsUpdated(oldTimeoutSlashBps, newTimeoutSlashBps);
    }

    function startRound(bytes32 roundId, bytes32 entropy, bytes32[] calldata eligibleNodeIds) external onlyRoundManager {
        if (roundExists[roundId]) revert RoundAlreadyExists();
        if (eligibleNodeIds.length < 3) revert InsufficientEligibleNodes();

        Round storage round = _rounds[roundId];
        roundExists[roundId] = true;
        round.entropy = entropy;
        round.createdAt = block.timestamp;
        round.proposerDeadline = block.timestamp + parameters.proposerSlaSeconds();

        uint256 eligibleLength = eligibleNodeIds.length;
        for (uint256 i = 0; i < eligibleLength; i++) {
            round.eligibleNodeIds.push(eligibleNodeIds[i]);
        }

        for (uint8 slot = 0; slot < 3; slot++) {
            (bytes32 selectedNodeId, bool found) = _drawAvailableNode(roundId, round);
            if (!found) revert InsufficientEligibleNodes();
            nodeUnavailableForRound[roundId][selectedNodeId] = true;
            round.candidates[slot] = Candidate({
                nodeId: selectedNodeId,
                proposalHash: bytes32(0),
                serviceQoSBps: 0,
                participationScoreBps: 0,
                submitted: false,
                timedOut: false
            });
            emit ProposerSelected(roundId, slot, selectedNodeId);
        }

        emit RoundStarted(roundId, entropy, round.proposerDeadline, eligibleNodeIds.length);
    }

    function submitProposal(
        bytes32 roundId,
        bytes32 nodeId,
        bytes32 proposalHash,
        uint16 serviceQoSBps,
        uint16 participationScoreBps
    ) external {
        if (!roundExists[roundId]) revert RoundNotFound();
        if (serviceQoSBps > 10_000 || participationScoreBps > 10_000) revert InvalidScore();

        Round storage round = _rounds[roundId];
        if (round.votingOpened) revert RoundAlreadyOpened();
        if (block.timestamp > round.proposerDeadline) revert ProposerWindowClosed();

        uint8 slot = _findCandidateSlotOrRevert(round, nodeId);
        Candidate storage candidate = round.candidates[slot];

        if (candidate.submitted) revert CandidateAlreadySubmitted();
        if (candidate.timedOut) revert CandidateAlreadyTimedOut();

        (INodeStakingManager.NodeStake memory node,,) = stakingManager.getNodeInfo(nodeId);
        if (node.operator != msg.sender) revert UnauthorizedCandidateOperator();

        candidate.submitted = true;
        candidate.proposalHash = proposalHash;
        candidate.serviceQoSBps = serviceQoSBps;
        candidate.participationScoreBps = participationScoreBps;

        emit ProposalSubmitted(roundId, slot, nodeId, proposalHash);
    }

    function declineAndRedraw(bytes32 roundId, uint8 slot, string calldata reason) external {
        if (!roundExists[roundId]) revert RoundNotFound();
        Round storage round = _rounds[roundId];
        if (round.votingOpened) revert RoundAlreadyOpened();
        if (slot >= 3) revert CandidateNotFound();

        Candidate storage candidate = round.candidates[slot];
        if (candidate.submitted) revert CandidateAlreadySubmitted();
        if (candidate.timedOut) revert CandidateAlreadyTimedOut();

        (INodeStakingManager.NodeStake memory node,,) = stakingManager.getNodeInfo(candidate.nodeId);
        if (node.operator != msg.sender) revert UnauthorizedCandidateOperator();

        _slashAndRedraw(roundId, round, slot, reason, true);
    }

    function slashTimeoutAndRedraw(bytes32 roundId, uint8 slot) external {
        if (!roundExists[roundId]) revert RoundNotFound();
        Round storage round = _rounds[roundId];
        if (round.votingOpened) revert RoundAlreadyOpened();
        if (slot >= 3) revert CandidateNotFound();

        if (block.timestamp <= round.proposerDeadline) revert ProposerWindowOpen();

        Candidate storage candidate = round.candidates[slot];
        if (candidate.submitted) revert CandidateAlreadySubmitted();
        if (candidate.timedOut) revert CandidateAlreadyTimedOut();

        _slashAndRedraw(roundId, round, slot, "META_PROPOSER_TIMEOUT", false);
    }

    function openVoting(bytes32 roundId, bytes32 daoId) external {
        if (!roundExists[roundId]) revert RoundNotFound();

        Round storage round = _rounds[roundId];
        if (round.votingOpened) revert RoundAlreadyOpened();

        bool proposerWindowElapsed = block.timestamp >= round.proposerDeadline;
        if (!proposerWindowElapsed && !_allSubmitted(round)) revert ProposerWindowOpen();

        round.votingOpened = true;

        bytes32[3] memory nodeIds;
        bytes32[3] memory proposalHashes;
        uint16[3] memory serviceQoSBps;
        uint16[3] memory participationScoresBps;

        for (uint8 i = 0; i < 3; i++) {
            Candidate storage candidate = round.candidates[i];
            nodeIds[i] = candidate.nodeId;
            proposalHashes[i] = candidate.proposalHash;
            serviceQoSBps[i] = candidate.serviceQoSBps;
            participationScoresBps[i] = candidate.participationScoreBps;
        }

        runoffGovernor.createRoundFromCoordinator(
            roundId,
            daoId,
            nodeIds,
            proposalHashes,
            serviceQoSBps,
            participationScoresBps
        );

        emit VotingOpened(roundId, daoId);
    }

    function getRound(bytes32 roundId)
        external
        view
        returns (
            bytes32 entropy,
            uint256 createdAt,
            uint256 proposerDeadline,
            bool votingOpened,
            bytes32[3] memory nodeIds,
            bytes32[3] memory proposalHashes,
            uint16[3] memory serviceQoSBps,
            uint16[3] memory participationScoresBps,
            bool[3] memory submitted,
            bool[3] memory timedOut,
            uint256 eligibleCount
        )
    {
        if (!roundExists[roundId]) revert RoundNotFound();
        Round storage round = _rounds[roundId];

        for (uint8 i = 0; i < 3; i++) {
            Candidate storage candidate = round.candidates[i];
            nodeIds[i] = candidate.nodeId;
            proposalHashes[i] = candidate.proposalHash;
            serviceQoSBps[i] = candidate.serviceQoSBps;
            participationScoresBps[i] = candidate.participationScoreBps;
            submitted[i] = candidate.submitted;
            timedOut[i] = candidate.timedOut;
        }

        return (
            round.entropy,
            round.createdAt,
            round.proposerDeadline,
            round.votingOpened,
            nodeIds,
            proposalHashes,
            serviceQoSBps,
            participationScoresBps,
            submitted,
            timedOut,
            round.eligibleNodeIds.length
        );
    }

    function _slashAndRedraw(
        bytes32 roundId,
        Round storage round,
        uint8 slot,
        string memory reason,
        bool isDecline
    ) internal {
        Candidate storage candidate = round.candidates[slot];
        bytes32 oldNodeId = candidate.nodeId;

        candidate.timedOut = true;
        candidate.submitted = false;
        candidate.proposalHash = bytes32(0);
        candidate.serviceQoSBps = 0;
        candidate.participationScoreBps = 0;

        stakingManager.slashNode(oldNodeId, timeoutSlashBps, reason);

        if (isDecline) {
            emit ProposerDeclined(roundId, slot, oldNodeId, reason);
        } else {
            emit ProposerTimedOut(roundId, slot, oldNodeId, reason);
        }

        (bytes32 replacementNodeId, bool found) = _drawAvailableNode(roundId, round);
        if (!found) {
            return;
        }

        nodeUnavailableForRound[roundId][replacementNodeId] = true;

        candidate.nodeId = replacementNodeId;
        candidate.timedOut = false;
        candidate.submitted = false;
        candidate.proposalHash = bytes32(0);
        candidate.serviceQoSBps = 0;
        candidate.participationScoreBps = 0;

        emit ProposerRedrawn(roundId, slot, oldNodeId, replacementNodeId);
    }

    function _drawAvailableNode(bytes32 roundId, Round storage round) internal returns (bytes32 selected, bool found) {
        uint256 candidateCount = round.eligibleNodeIds.length;
        if (candidateCount == 0) {
            return (bytes32(0), false);
        }

        uint256 seed = uint256(keccak256(abi.encode(round.entropy, roundId, round.drawNonce)));
        round.drawNonce++;

        uint256 start = seed % candidateCount;
        for (uint256 i = 0; i < candidateCount; i++) {
            bytes32 nodeId = round.eligibleNodeIds[(start + i) % candidateCount];
            if (nodeId == bytes32(0) || nodeUnavailableForRound[roundId][nodeId]) {
                continue;
            }
            return (nodeId, true);
        }

        return (bytes32(0), false);
    }

    function _allSubmitted(Round storage round) internal view returns (bool) {
        for (uint8 i = 0; i < 3; i++) {
            if (!round.candidates[i].submitted) {
                return false;
            }
        }
        return true;
    }

    function _findCandidateSlotOrRevert(Round storage round, bytes32 nodeId) internal view returns (uint8 slot) {
        for (uint8 i = 0; i < 3; i++) {
            if (round.candidates[i].nodeId == nodeId) {
                return i;
            }
        }
        revert CandidateNotFound();
    }
}
