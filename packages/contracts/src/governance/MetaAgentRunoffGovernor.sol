// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IDAORegistry} from "./interfaces/IDAORegistry.sol";

interface IMetaAgentScoreParameters {
    function voteBlendBps() external view returns (uint256);
    function baseParticipationWeightBps() external view returns (uint256);
    function maxParticipationWeightBps() external view returns (uint256);
    function boardTargetTurnoutBps() external view returns (uint256);
    function stakeTargetTurnoutBps() external view returns (uint256);
    function boardRoundSeconds() external view returns (uint256);
    function stakeRoundSeconds() external view returns (uint256);
    function finalizeRoundSeconds() external view returns (uint256);
}

interface IVotesToken {
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
}

interface IMetaAgentActionRouter {
    function queueRuntimeParameterUpdate(bytes32 roundId, bytes32 parameterId, uint256 newValue)
        external
        returns (bytes32 actionId);

    function forwardConstitutionalUpgrade(
        bytes32 roundId,
        address target,
        bytes calldata data,
        string calldata description,
        string calldata metadataURI
    ) external returns (bytes32 constitutionalProposalId);
}

/**
 * @title MetaAgentRunoffGovernor
 * @notice Two-round selection (board then stake) for 3 proposer candidates.
 * @dev Final scores always blend vote share with composite QoSV/participation score
 *      and use dynamic participation weighting based on turnout targets.
 */
contract MetaAgentRunoffGovernor is Ownable {
    struct Candidate {
        bytes32 nodeId;
        bytes32 proposalHash;
        uint16 serviceQoSBps;
        uint16 participationScoreBps;
        uint256 boardVoteWeight;
        uint256 stakeVoteWeight;
    }

    struct Round {
        bytes32 daoId;
        uint256 snapshotTime;
        uint256 snapshotDelegatedSupply;
        uint256 boardStartTime;
        uint256 boardEndTime;
        uint256 stakeStartTime;
        uint256 stakeEndTime;
        uint256 finalizeAfterTime;
        uint256 totalBoardWeight;
        uint256 boardVoteWeightCast;
        uint256 stakeVoteWeightCast;
        uint8 finalistA;
        uint8 finalistB;
        uint8 winnerIndex;
        bool boardFinalized;
        bool finalized;
    }

    IDAORegistry public daoRegistry;
    IMetaAgentScoreParameters public parameters;
    IVotesToken public governanceToken;
    address public coordinator;
    IMetaAgentActionRouter public actionRouter;

    mapping(bytes32 => bool) public roundExists;
    mapping(bytes32 => Round) public rounds;
    mapping(bytes32 => Candidate[3]) public candidatesByRound;
    mapping(bytes32 => mapping(address => bool)) public hasBoardVoted;
    mapping(bytes32 => mapping(address => bool)) public hasStakeVoted;

    event CoordinatorUpdated(address indexed oldCoordinator, address indexed newCoordinator);
    event DAORegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ParametersUpdated(address indexed oldParameters, address indexed newParameters);
    event GovernanceTokenUpdated(address indexed oldToken, address indexed newToken);
    event ActionRouterUpdated(address indexed oldRouter, address indexed newRouter);

    event RoundCreated(
        bytes32 indexed roundId,
        bytes32 indexed daoId,
        uint256 snapshotTime,
        uint256 boardEndTime,
        uint256 stakeEndTime,
        uint256 finalizeAfterTime
    );
    event BoardVoteCast(bytes32 indexed roundId, address indexed voter, uint8 indexed candidateIndex, uint256 weight);
    event BoardRoundFinalized(bytes32 indexed roundId, uint8 finalistA, uint8 finalistB, uint256 turnoutBps);
    event StakeVoteCast(bytes32 indexed roundId, address indexed voter, uint8 finalistSlot, uint256 weight);
    event RoundFinalized(
        bytes32 indexed roundId,
        uint8 winnerIndex,
        bytes32 winnerNodeId,
        bytes32 winnerProposalHash,
        uint256 turnoutBps
    );

    error InvalidAddress();
    error NotCoordinator();
    error ActionRouterNotConfigured();
    error RoundAlreadyExists();
    error RoundNotFound();
    error InvalidCandidateIndex();
    error InvalidCandidateData();
    error BoardVotingNotActive();
    error StakeVotingNotActive();
    error FinalizationWindowNotOpen();
    error BoardRoundNotFinalized();
    error AlreadyVoted();
    error NotBoardMember();
    error NoVotingPower();

    modifier onlyCoordinator() {
        if (msg.sender != coordinator) revert NotCoordinator();
        _;
    }

    constructor(
        address _daoRegistry,
        address _parameters,
        address _governanceToken,
        address _coordinator,
        address initialOwner
    ) Ownable(initialOwner) {
        if (
            _daoRegistry == address(0) || _parameters == address(0) || _governanceToken == address(0)
                || _coordinator == address(0)
        ) {
            revert InvalidAddress();
        }

        daoRegistry = IDAORegistry(_daoRegistry);
        parameters = IMetaAgentScoreParameters(_parameters);
        governanceToken = IVotesToken(_governanceToken);
        coordinator = _coordinator;
    }

    function setCoordinator(address newCoordinator) external onlyOwner {
        if (newCoordinator == address(0)) revert InvalidAddress();
        address oldCoordinator = coordinator;
        coordinator = newCoordinator;
        emit CoordinatorUpdated(oldCoordinator, newCoordinator);
    }

    function setDAORegistry(address newDAORegistry) external onlyOwner {
        if (newDAORegistry == address(0)) revert InvalidAddress();
        address oldRegistry = address(daoRegistry);
        daoRegistry = IDAORegistry(newDAORegistry);
        emit DAORegistryUpdated(oldRegistry, newDAORegistry);
    }

    function setParameters(address newParameters) external onlyOwner {
        if (newParameters == address(0)) revert InvalidAddress();
        address oldParameters = address(parameters);
        parameters = IMetaAgentScoreParameters(newParameters);
        emit ParametersUpdated(oldParameters, newParameters);
    }

    function setGovernanceToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert InvalidAddress();
        address oldToken = address(governanceToken);
        governanceToken = IVotesToken(newToken);
        emit GovernanceTokenUpdated(oldToken, newToken);
    }

    function setActionRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert InvalidAddress();
        address oldRouter = address(actionRouter);
        actionRouter = IMetaAgentActionRouter(newRouter);
        emit ActionRouterUpdated(oldRouter, newRouter);
    }

    function createRoundFromCoordinator(
        bytes32 roundId,
        bytes32 daoId,
        bytes32[3] calldata nodeIds,
        bytes32[3] calldata proposalHashes,
        uint16[3] calldata serviceQoSBps,
        uint16[3] calldata participationScoresBps
    ) external onlyCoordinator {
        if (roundExists[roundId]) revert RoundAlreadyExists();

        uint256 snapshotTime = block.timestamp > 0 ? block.timestamp - 1 : 0;
        uint256 snapshotDelegatedSupply = governanceToken.getPastTotalSupply(snapshotTime);

        uint256 boardStart = block.timestamp;
        uint256 boardEnd = boardStart + parameters.boardRoundSeconds();
        uint256 stakeEnd = boardEnd + parameters.stakeRoundSeconds();
        uint256 finalizeAfter = stakeEnd + parameters.finalizeRoundSeconds();

        roundExists[roundId] = true;
        rounds[roundId] = Round({
            daoId: daoId,
            snapshotTime: snapshotTime,
            snapshotDelegatedSupply: snapshotDelegatedSupply,
            boardStartTime: boardStart,
            boardEndTime: boardEnd,
            stakeStartTime: boardEnd,
            stakeEndTime: stakeEnd,
            finalizeAfterTime: finalizeAfter,
            totalBoardWeight: _computeTotalBoardWeight(daoId),
            boardVoteWeightCast: 0,
            stakeVoteWeightCast: 0,
            finalistA: 0,
            finalistB: 1,
            winnerIndex: 0,
            boardFinalized: false,
            finalized: false
        });

        for (uint8 i = 0; i < 3; i++) {
            if (serviceQoSBps[i] > 10_000 || participationScoresBps[i] > 10_000) revert InvalidCandidateData();
            candidatesByRound[roundId][i] = Candidate({
                nodeId: nodeIds[i],
                proposalHash: proposalHashes[i],
                serviceQoSBps: serviceQoSBps[i],
                participationScoreBps: participationScoresBps[i],
                boardVoteWeight: 0,
                stakeVoteWeight: 0
            });
        }

        emit RoundCreated(roundId, daoId, snapshotTime, boardEnd, stakeEnd, finalizeAfter);
    }

    function castBoardVote(bytes32 roundId, uint8 candidateIndex) external {
        if (candidateIndex >= 3) revert InvalidCandidateIndex();

        Round storage round = rounds[roundId];
        if (!roundExists[roundId]) revert RoundNotFound();
        if (round.boardFinalized || round.finalized || block.timestamp < round.boardStartTime || block.timestamp > round.boardEndTime) {
            revert BoardVotingNotActive();
        }
        if (hasBoardVoted[roundId][msg.sender]) revert AlreadyVoted();

        uint256 weight = _getBoardMemberWeight(round.daoId, msg.sender);
        if (weight == 0) revert NotBoardMember();

        hasBoardVoted[roundId][msg.sender] = true;
        round.boardVoteWeightCast += weight;
        candidatesByRound[roundId][candidateIndex].boardVoteWeight += weight;

        emit BoardVoteCast(roundId, msg.sender, candidateIndex, weight);
    }

    function finalizeBoardRound(bytes32 roundId) public {
        Round storage round = rounds[roundId];
        if (!roundExists[roundId]) revert RoundNotFound();
        if (round.boardFinalized) return;
        if (block.timestamp < round.boardEndTime) revert BoardVotingNotActive();

        uint256 turnoutBps = round.totalBoardWeight == 0 ? 0 : (round.boardVoteWeightCast * 10_000) / round.totalBoardWeight;

        (uint8 first, uint8 second) = _topTwoCandidates(roundId, turnoutBps, true);

        round.finalistA = first;
        round.finalistB = second;
        round.boardFinalized = true;

        emit BoardRoundFinalized(roundId, first, second, turnoutBps);
    }

    function castStakeVote(bytes32 roundId, uint8 finalistSlot) external {
        if (finalistSlot > 1) revert InvalidCandidateIndex();

        Round storage round = rounds[roundId];
        if (!roundExists[roundId]) revert RoundNotFound();
        if (!round.boardFinalized || round.finalized || block.timestamp < round.stakeStartTime || block.timestamp > round.stakeEndTime) {
            revert StakeVotingNotActive();
        }
        if (hasStakeVoted[roundId][msg.sender]) revert AlreadyVoted();

        uint256 votingWeight = governanceToken.getPastVotes(msg.sender, round.snapshotTime);
        if (votingWeight == 0) revert NoVotingPower();

        hasStakeVoted[roundId][msg.sender] = true;
        round.stakeVoteWeightCast += votingWeight;

        uint8 candidateIndex = finalistSlot == 0 ? round.finalistA : round.finalistB;
        candidatesByRound[roundId][candidateIndex].stakeVoteWeight += votingWeight;

        emit StakeVoteCast(roundId, msg.sender, finalistSlot, votingWeight);
    }

    function finalizeRound(bytes32 roundId) external {
        Round storage round = rounds[roundId];
        if (!roundExists[roundId]) revert RoundNotFound();
        if (!round.boardFinalized) revert BoardRoundNotFinalized();
        if (round.finalized) return;
        if (block.timestamp < round.finalizeAfterTime) revert FinalizationWindowNotOpen();

        uint256 turnoutBps =
            round.snapshotDelegatedSupply == 0 ? 0 : (round.stakeVoteWeightCast * 10_000) / round.snapshotDelegatedSupply;

        (uint256 finalistAScore, uint256 finalistAComposite) = _scoreCandidate(roundId, round.finalistA, turnoutBps, false);
        (uint256 finalistBScore, uint256 finalistBComposite) = _scoreCandidate(roundId, round.finalistB, turnoutBps, false);

        uint8 winnerIndex;
        if (finalistAScore > finalistBScore) {
            winnerIndex = round.finalistA;
        } else if (finalistBScore > finalistAScore) {
            winnerIndex = round.finalistB;
        } else {
            Candidate storage candidateA = candidatesByRound[roundId][round.finalistA];
            Candidate storage candidateB = candidatesByRound[roundId][round.finalistB];

            if (finalistAComposite > finalistBComposite) {
                winnerIndex = round.finalistA;
            } else if (finalistBComposite > finalistAComposite) {
                winnerIndex = round.finalistB;
            } else if (candidateA.serviceQoSBps >= candidateB.serviceQoSBps) {
                winnerIndex = round.finalistA;
            } else {
                winnerIndex = round.finalistB;
            }
        }

        round.winnerIndex = winnerIndex;
        round.finalized = true;

        Candidate storage winner = candidatesByRound[roundId][winnerIndex];
        emit RoundFinalized(roundId, winnerIndex, winner.nodeId, winner.proposalHash, turnoutBps);
    }

    function queueRuntimeWinnerParameterUpdate(bytes32 roundId, bytes32 parameterId, uint256 newValue)
        external
        returns (bytes32 actionId)
    {
        Round storage round = rounds[roundId];
        if (!roundExists[roundId]) revert RoundNotFound();
        if (!round.finalized) revert StakeVotingNotActive();
        if (address(actionRouter) == address(0)) revert ActionRouterNotConfigured();

        actionId = actionRouter.queueRuntimeParameterUpdate(roundId, parameterId, newValue);
    }

    function forwardWinnerConstitutionalUpgrade(
        bytes32 roundId,
        address target,
        bytes calldata data,
        string calldata description,
        string calldata metadataURI
    ) external returns (bytes32 constitutionalProposalId) {
        Round storage round = rounds[roundId];
        if (!roundExists[roundId]) revert RoundNotFound();
        if (!round.finalized) revert StakeVotingNotActive();
        if (address(actionRouter) == address(0)) revert ActionRouterNotConfigured();

        constitutionalProposalId = actionRouter.forwardConstitutionalUpgrade(
            roundId,
            target,
            data,
            description,
            metadataURI
        );
    }

    function getRoundCandidates(bytes32 roundId)
        external
        view
        returns (
            bytes32[3] memory nodeIds,
            bytes32[3] memory proposalHashes,
            uint16[3] memory serviceQoSBps,
            uint16[3] memory participationScoresBps,
            uint256[3] memory boardVoteWeight,
            uint256[3] memory stakeVoteWeight
        )
    {
        if (!roundExists[roundId]) revert RoundNotFound();

        for (uint8 i = 0; i < 3; i++) {
            Candidate storage candidate = candidatesByRound[roundId][i];
            nodeIds[i] = candidate.nodeId;
            proposalHashes[i] = candidate.proposalHash;
            serviceQoSBps[i] = candidate.serviceQoSBps;
            participationScoresBps[i] = candidate.participationScoreBps;
            boardVoteWeight[i] = candidate.boardVoteWeight;
            stakeVoteWeight[i] = candidate.stakeVoteWeight;
        }
    }

    function getRoundScores(bytes32 roundId, bool boardPhase)
        external
        view
        returns (
            uint256 turnoutBps,
            uint256 participationWeightBps,
            uint256[3] memory compositeScoresBps,
            uint256[3] memory finalScoresBps
        )
    {
        Round storage round = rounds[roundId];
        if (!roundExists[roundId]) revert RoundNotFound();

        if (boardPhase) {
            turnoutBps = round.totalBoardWeight == 0 ? 0 : (round.boardVoteWeightCast * 10_000) / round.totalBoardWeight;
            participationWeightBps = _dynamicParticipationWeight(turnoutBps, parameters.boardTargetTurnoutBps());
            for (uint8 i = 0; i < 3; i++) {
                (uint256 finalScore, uint256 compositeScore) = _scoreCandidateWithWeight(
                    roundId, i, participationWeightBps, round.boardVoteWeightCast, true
                );
                compositeScoresBps[i] = compositeScore;
                finalScoresBps[i] = finalScore;
            }
            return (turnoutBps, participationWeightBps, compositeScoresBps, finalScoresBps);
        }

        turnoutBps =
            round.snapshotDelegatedSupply == 0 ? 0 : (round.stakeVoteWeightCast * 10_000) / round.snapshotDelegatedSupply;
        participationWeightBps = _dynamicParticipationWeight(turnoutBps, parameters.stakeTargetTurnoutBps());

        for (uint8 i = 0; i < 3; i++) {
            (uint256 finalScore, uint256 compositeScore) = _scoreCandidateWithWeight(
                roundId, i, participationWeightBps, round.stakeVoteWeightCast, false
            );
            compositeScoresBps[i] = compositeScore;
            finalScoresBps[i] = finalScore;
        }

        return (turnoutBps, participationWeightBps, compositeScoresBps, finalScoresBps);
    }

    function _computeTotalBoardWeight(bytes32 daoId) internal view returns (uint256 totalWeight) {
        IDAORegistry.BoardMember[] memory members = daoRegistry.getBoardMembers(daoId);
        uint256 length = members.length;
        for (uint256 i = 0; i < length; i++) {
            if (members[i].isActive) {
                totalWeight += members[i].weight;
            }
        }
    }

    function _getBoardMemberWeight(bytes32 daoId, address account) internal view returns (uint256 weight) {
        IDAORegistry.BoardMember[] memory members = daoRegistry.getBoardMembers(daoId);
        uint256 length = members.length;
        for (uint256 i = 0; i < length; i++) {
            if (members[i].isActive && members[i].member == account) {
                return members[i].weight;
            }
        }
        return 0;
    }

    function _topTwoCandidates(bytes32 roundId, uint256 turnoutBps, bool boardPhase)
        internal
        view
        returns (uint8 first, uint8 second)
    {
        uint8[3] memory indexes = [uint8(0), uint8(1), uint8(2)];

        for (uint8 i = 0; i < 3; i++) {
            for (uint8 j = i + 1; j < 3; j++) {
                if (_isCandidateHigher(roundId, indexes[j], indexes[i], turnoutBps, boardPhase)) {
                    uint8 temp = indexes[i];
                    indexes[i] = indexes[j];
                    indexes[j] = temp;
                }
            }
        }

        return (indexes[0], indexes[1]);
    }

    function _isCandidateHigher(
        bytes32 roundId,
        uint8 candidateA,
        uint8 candidateB,
        uint256 turnoutBps,
        bool boardPhase
    ) internal view returns (bool) {
        (uint256 scoreA, uint256 compositeA) = _scoreCandidate(roundId, candidateA, turnoutBps, boardPhase);
        (uint256 scoreB, uint256 compositeB) = _scoreCandidate(roundId, candidateB, turnoutBps, boardPhase);

        if (scoreA > scoreB) return true;
        if (scoreB > scoreA) return false;

        Candidate storage a = candidatesByRound[roundId][candidateA];
        Candidate storage b = candidatesByRound[roundId][candidateB];

        if (compositeA > compositeB) return true;
        if (compositeB > compositeA) return false;

        if (a.serviceQoSBps > b.serviceQoSBps) return true;
        if (b.serviceQoSBps > a.serviceQoSBps) return false;

        return candidateA < candidateB;
    }

    function _scoreCandidate(bytes32 roundId, uint8 candidateIndex, uint256 turnoutBps, bool boardPhase)
        internal
        view
        returns (uint256 finalScoreBps, uint256 compositeScoreBps)
    {
        uint256 target = boardPhase ? parameters.boardTargetTurnoutBps() : parameters.stakeTargetTurnoutBps();
        uint256 dynamicWeightBps = _dynamicParticipationWeight(turnoutBps, target);

        uint256 voteTotal = boardPhase ? rounds[roundId].boardVoteWeightCast : rounds[roundId].stakeVoteWeightCast;

        return _scoreCandidateWithWeight(roundId, candidateIndex, dynamicWeightBps, voteTotal, boardPhase);
    }

    function _scoreCandidateWithWeight(
        bytes32 roundId,
        uint8 candidateIndex,
        uint256 participationWeightBps,
        uint256 voteTotal,
        bool boardPhase
    ) internal view returns (uint256 finalScoreBps, uint256 compositeScoreBps) {
        Candidate storage candidate = candidatesByRound[roundId][candidateIndex];

        compositeScoreBps = ((10_000 - participationWeightBps) * candidate.serviceQoSBps
            + participationWeightBps * candidate.participationScoreBps) / 10_000;

        uint256 voteWeight = boardPhase ? candidate.boardVoteWeight : candidate.stakeVoteWeight;
        uint256 voteShareBps = voteTotal == 0 ? 0 : (voteWeight * 10_000) / voteTotal;
        uint256 voteBlendBps = parameters.voteBlendBps();

        if (voteTotal == 0) {
            finalScoreBps = compositeScoreBps;
        } else {
            finalScoreBps = (voteBlendBps * voteShareBps + (10_000 - voteBlendBps) * compositeScoreBps) / 10_000;
        }
    }

    function _dynamicParticipationWeight(uint256 turnoutBps, uint256 targetTurnoutBps) internal view returns (uint256) {
        uint256 baseWeightBps = parameters.baseParticipationWeightBps();
        uint256 maxWeightBps = parameters.maxParticipationWeightBps();

        if (targetTurnoutBps == 0 || turnoutBps >= targetTurnoutBps || maxWeightBps <= baseWeightBps) {
            return baseWeightBps;
        }

        uint256 shortfallRatioBps = ((targetTurnoutBps - turnoutBps) * 10_000) / targetTurnoutBps;
        uint256 additionalWeight = ((maxWeightBps - baseWeightBps) * shortfallRatioBps) / 10_000;
        uint256 dynamicWeightBps = baseWeightBps + additionalWeight;

        if (dynamicWeightBps > maxWeightBps) {
            return maxWeightBps;
        }

        return dynamicWeightBps;
    }
}
