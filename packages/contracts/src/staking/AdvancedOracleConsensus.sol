// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {INodeStakingManager} from "./INodeStakingManager.sol";
import {OraclePowerRegistry} from "./OraclePowerRegistry.sol";

interface IOracleSlashGovernor {
    function queueProposalFromConsensus(bytes32 nodeId, uint256 epoch, uint256 slashBps, bytes32 evidenceHash)
        external
        returns (bytes32 proposalId);
}

/**
 * @title AdvancedOracleConsensus
 * @notice Bootstrap-to-stake-weighted performance consensus
 * @dev Uses equal-weight bootstrap oracle approvals until the registry
 * activates advanced mode, then shifts to stake-weighted weighted medians.
 */
contract AdvancedOracleConsensus is Ownable {
    struct PerformanceSubmission {
        address oracle;
        uint256 weight;
        uint256 uptimeScore;
        uint256 requestsServed;
        uint256 avgResponseTime;
        uint256 recommendedSlashBps;
        bytes32 evidenceHash;
        bool supportsSlash;
        uint256 submittedAtBlock;
    }

    struct Round {
        uint256 epoch;
        uint256 totalWeight;
        uint256 slashSupportWeight;
        bool finalized;
        address[] submitters;
        PerformanceSubmission[] submissions;
        mapping(address => bool) hasSubmitted;
    }

    INodeStakingManager public immutable stakingManager;
    OraclePowerRegistry public immutable oracleRegistry;
    address public slashGovernor;

    uint256 public epochLengthBlocks;
    uint256 public minimumDistinctOracles;
    uint256 public consensusQuorumBps;
    uint256 public slashRecommendationQuorumBps;

    mapping(bytes32 => Round) private rounds;

    event PerformanceSubmitted(bytes32 indexed nodeId, uint256 indexed epoch, address indexed oracle, uint256 weight);
    event RoundFinalized(bytes32 indexed nodeId, uint256 indexed epoch, uint256 uptimeScore, uint256 requestsServed);
    event SlashGovernorUpdated(address indexed oldGovernor, address indexed newGovernor);
    event EpochLengthUpdated(uint256 oldEpochLength, uint256 newEpochLength);
    event ConsensusThresholdsUpdated(
        uint256 oldDistinctOracles,
        uint256 newDistinctOracles,
        uint256 oldConsensusQuorumBps,
        uint256 newConsensusQuorumBps,
        uint256 oldSlashRecommendationQuorumBps,
        uint256 newSlashRecommendationQuorumBps
    );

    error InvalidAddress();
    error InvalidEpoch();
    error InvalidAmount();
    error NotEligibleOracle();
    error DuplicateSubmission();
    error RoundAlreadyFinalized();
    error NotEnoughDistinctOracles();
    error NotEnoughConsensusWeight();
    error NoSubmissions();

    constructor(
        address _stakingManager,
        address _oracleRegistry,
        address initialOwner,
        uint256 _epochLengthBlocks,
        uint256 _minimumDistinctOracles,
        uint256 _consensusQuorumBps,
        uint256 _slashRecommendationQuorumBps
    ) Ownable(initialOwner) {
        if (_stakingManager == address(0) || _oracleRegistry == address(0)) revert InvalidAddress();
        if (_epochLengthBlocks == 0 || _minimumDistinctOracles < 3) revert InvalidAmount();
        if (_consensusQuorumBps == 0 || _consensusQuorumBps > 10_000) revert InvalidAmount();
        if (_slashRecommendationQuorumBps == 0 || _slashRecommendationQuorumBps > 10_000) revert InvalidAmount();

        stakingManager = INodeStakingManager(_stakingManager);
        oracleRegistry = OraclePowerRegistry(_oracleRegistry);
        epochLengthBlocks = _epochLengthBlocks;
        minimumDistinctOracles = _minimumDistinctOracles;
        consensusQuorumBps = _consensusQuorumBps;
        slashRecommendationQuorumBps = _slashRecommendationQuorumBps;
    }

    function currentEpoch() public view returns (uint256) {
        return block.number / epochLengthBlocks;
    }

    function roundKey(bytes32 nodeId, uint256 epoch) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(nodeId, epoch));
    }

    function getRoundSummary(bytes32 nodeId, uint256 epoch)
        external
        view
        returns (uint256 totalWeight, uint256 submissionCount, uint256 slashSupportWeight, bool finalized_)
    {
        Round storage round = rounds[roundKey(nodeId, epoch)];
        return (round.totalWeight, round.submissions.length, round.slashSupportWeight, round.finalized);
    }

    function submitPerformance(
        bytes32 nodeId,
        uint256 epoch,
        uint256 uptimeScore,
        uint256 requestsServed,
        uint256 avgResponseTime,
        bytes32 evidenceHash,
        bool supportsSlash,
        uint256 recommendedSlashBps
    ) external {
        oracleRegistry.maybeActivateAdvancedMode();

        if (!oracleRegistry.isEligibleOracle(msg.sender)) revert NotEligibleOracle();
        if (epoch != currentEpoch()) revert InvalidEpoch();

        bytes32 key = roundKey(nodeId, epoch);
        Round storage round = rounds[key];

        if (round.finalized) revert RoundAlreadyFinalized();
        if (round.hasSubmitted[msg.sender]) revert DuplicateSubmission();
        if (round.epoch == 0) {
            round.epoch = epoch;
        }

        uint256 weight = oracleRegistry.getOracleWeight(msg.sender);
        if (weight == 0) revert NotEligibleOracle();

        round.hasSubmitted[msg.sender] = true;
        round.submitters.push(msg.sender);
        round.submissions.push(
            PerformanceSubmission({
                oracle: msg.sender,
                weight: weight,
                uptimeScore: uptimeScore,
                requestsServed: requestsServed,
                avgResponseTime: avgResponseTime,
                recommendedSlashBps: recommendedSlashBps,
                evidenceHash: evidenceHash,
                supportsSlash: supportsSlash,
                submittedAtBlock: block.number
            })
        );
        round.totalWeight += weight;
        if (supportsSlash && recommendedSlashBps > 0) {
            round.slashSupportWeight += weight;
        }

        emit PerformanceSubmitted(nodeId, epoch, msg.sender, weight);

        if (_canFinalize(round)) {
            _finalizeRound(nodeId, epoch);
        }
    }

    function finalize(bytes32 nodeId, uint256 epoch) external {
        _finalizeRound(nodeId, epoch);
    }

    function setSlashGovernor(address newSlashGovernor) external onlyOwner {
        address oldGovernor = slashGovernor;
        slashGovernor = newSlashGovernor;
        emit SlashGovernorUpdated(oldGovernor, newSlashGovernor);
    }

    function setEpochLengthBlocks(uint256 newEpochLengthBlocks) external onlyOwner {
        if (newEpochLengthBlocks == 0) revert InvalidAmount();
        uint256 oldValue = epochLengthBlocks;
        epochLengthBlocks = newEpochLengthBlocks;
        emit EpochLengthUpdated(oldValue, newEpochLengthBlocks);
    }

    function setConsensusThresholds(
        uint256 newMinimumDistinctOracles,
        uint256 newConsensusQuorumBps,
        uint256 newSlashRecommendationQuorumBps
    ) external onlyOwner {
        if (newMinimumDistinctOracles < 3) revert InvalidAmount();
        if (newConsensusQuorumBps == 0 || newConsensusQuorumBps > 10_000) revert InvalidAmount();
        if (newSlashRecommendationQuorumBps == 0 || newSlashRecommendationQuorumBps > 10_000) revert InvalidAmount();

        emit ConsensusThresholdsUpdated(
            minimumDistinctOracles,
            newMinimumDistinctOracles,
            consensusQuorumBps,
            newConsensusQuorumBps,
            slashRecommendationQuorumBps,
            newSlashRecommendationQuorumBps
        );

        minimumDistinctOracles = newMinimumDistinctOracles;
        consensusQuorumBps = newConsensusQuorumBps;
        slashRecommendationQuorumBps = newSlashRecommendationQuorumBps;
    }

    function _canFinalize(Round storage round) internal view returns (bool) {
        if (round.finalized) return false;
        if (round.submissions.length < minimumDistinctOracles) return false;

        uint256 totalConsensusWeight = oracleRegistry.totalConsensusWeight();
        if (totalConsensusWeight == 0) return false;

        return round.totalWeight * 10_000 >= totalConsensusWeight * consensusQuorumBps;
    }

    function _finalizeRound(bytes32 nodeId, uint256 epoch) internal {
        Round storage round = rounds[roundKey(nodeId, epoch)];
        if (round.submissions.length == 0) revert NoSubmissions();
        if (round.finalized) revert RoundAlreadyFinalized();
        if (round.submissions.length < minimumDistinctOracles) revert NotEnoughDistinctOracles();

        uint256 totalConsensusWeight = oracleRegistry.totalConsensusWeight();
        if (totalConsensusWeight == 0 || round.totalWeight * 10_000 < totalConsensusWeight * consensusQuorumBps) {
            revert NotEnoughConsensusWeight();
        }

        uint256 medianUptime = _weightedMedian(round, 0);
        uint256 medianRequests = _weightedMedian(round, 1);
        uint256 medianResponseTime = _weightedMedian(round, 2);

        round.finalized = true;
        emit RoundFinalized(nodeId, epoch, medianUptime, medianRequests);

        stakingManager.updatePerformance(nodeId, medianUptime, medianRequests, medianResponseTime);

        if (
            slashGovernor != address(0)
                && round.slashSupportWeight * 10_000 >= totalConsensusWeight * slashRecommendationQuorumBps
        ) {
            IOracleSlashGovernor(slashGovernor).queueProposalFromConsensus(
                nodeId, epoch, _weightedSlashMedian(round), _firstNonZeroEvidence(round)
            );
        }
    }

    function _weightedMedian(Round storage round, uint256 field) internal view returns (uint256) {
        uint256 count = round.submissions.length;
        uint256[] memory values = new uint256[](count);
        uint256[] memory weights = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            PerformanceSubmission storage submission = round.submissions[i];
            if (field == 0) values[i] = submission.uptimeScore;
            else if (field == 1) values[i] = submission.requestsServed;
            else values[i] = submission.avgResponseTime;
            weights[i] = submission.weight;
        }

        _sort(values, weights);

        uint256 runningWeight = 0;
        uint256 threshold = (round.totalWeight + 1) / 2;

        for (uint256 i = 0; i < count; i++) {
            runningWeight += weights[i];
            if (runningWeight >= threshold) {
                return values[i];
            }
        }

        return values[count - 1];
    }

    function _weightedSlashMedian(Round storage round) internal view returns (uint256) {
        uint256 supporters = 0;
        for (uint256 i = 0; i < round.submissions.length; i++) {
            if (round.submissions[i].supportsSlash && round.submissions[i].recommendedSlashBps > 0) {
                supporters++;
            }
        }
        if (supporters == 0) return 0;

        uint256[] memory values = new uint256[](supporters);
        uint256[] memory weights = new uint256[](supporters);
        uint256 totalSupportWeight = 0;
        uint256 cursor = 0;

        for (uint256 i = 0; i < round.submissions.length; i++) {
            PerformanceSubmission storage submission = round.submissions[i];
            if (submission.supportsSlash && submission.recommendedSlashBps > 0) {
                values[cursor] = submission.recommendedSlashBps;
                weights[cursor] = submission.weight;
                totalSupportWeight += submission.weight;
                cursor++;
            }
        }

        _sort(values, weights);

        uint256 runningWeight = 0;
        uint256 threshold = (totalSupportWeight + 1) / 2;

        for (uint256 i = 0; i < supporters; i++) {
            runningWeight += weights[i];
            if (runningWeight >= threshold) {
                return values[i];
            }
        }

        return values[supporters - 1];
    }

    function _firstNonZeroEvidence(Round storage round) internal view returns (bytes32) {
        for (uint256 i = 0; i < round.submissions.length; i++) {
            if (round.submissions[i].evidenceHash != bytes32(0)) {
                return round.submissions[i].evidenceHash;
            }
        }
        return bytes32(0);
    }

    function _sort(uint256[] memory values, uint256[] memory weights) internal pure {
        uint256 count = values.length;
        for (uint256 i = 0; i + 1 < count; i++) {
            for (uint256 j = 0; j + 1 < count - i; j++) {
                if (values[j] > values[j + 1]) {
                    uint256 tempValue = values[j];
                    values[j] = values[j + 1];
                    values[j + 1] = tempValue;

                    uint256 tempWeight = weights[j];
                    weights[j] = weights[j + 1];
                    weights[j + 1] = tempWeight;
                }
            }
        }
    }
}
