// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.33;

/**
 * @title ModerationVotingLib
 * @notice Internal library for voting weight calculations
 * @dev All functions are internal (inlined at compile time, no linking needed)
 */
library ModerationVotingLib {
    uint256 internal constant QUADRATIC_SCALE = 1e18;
    uint256 internal constant ABSOLUTE_MAX_VOTE_WEIGHT = 707106781186547524; // sqrt(0.5e18 * 1e18)
    uint256 internal constant TIME_WEIGHT_BPS_PER_HOUR = 100;
    uint256 internal constant MAX_VOTE_WEIGHT_BPS = 2500;

    function calculateVoteWeight(
        uint256 rawStake,
        uint256 marketOpenUntil,
        uint256 currentTimestamp,
        uint256 currentYesVotes,
        uint256 currentNoVotes
    ) internal pure returns (uint256 effectiveWeight) {
        uint256 quadraticWeight = sqrt(rawStake * QUADRATIC_SCALE);

        if (quadraticWeight > ABSOLUTE_MAX_VOTE_WEIGHT) {
            quadraticWeight = ABSOLUTE_MAX_VOTE_WEIGHT;
        }

        uint256 timeRemaining = marketOpenUntil > currentTimestamp ? marketOpenUntil - currentTimestamp : 0;
        uint256 hoursRemaining = timeRemaining / 1 hours;
        uint256 timeBonus = hoursRemaining * TIME_WEIGHT_BPS_PER_HOUR;
        if (timeBonus > 7200) timeBonus = 7200;

        uint256 timeWeightedVote = quadraticWeight * (10000 + timeBonus) / 10000;

        uint256 currentTotalVotes = currentYesVotes + currentNoVotes;
        if (currentTotalVotes > 0) {
            uint256 maxWeight = (currentTotalVotes * MAX_VOTE_WEIGHT_BPS) / 10000;
            if (timeWeightedVote > maxWeight) {
                timeWeightedVote = maxWeight;
            }
        }

        if (timeWeightedVote > ABSOLUTE_MAX_VOTE_WEIGHT * 172 / 100) {
            timeWeightedVote = ABSOLUTE_MAX_VOTE_WEIGHT * 172 / 100;
        }

        return timeWeightedVote;
    }

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
