// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.33;

/**
 * @title ModerationRewardsLib
 * @notice Internal library for reward distribution calculations
 * @dev All functions are internal (inlined at compile time, no linking needed)
 */
library ModerationRewardsLib {
    uint256 internal constant WINNER_SHARE_BPS = 9000; // 90%
    uint256 internal constant TREASURY_SHARE_BPS = 500; // 5%
    uint256 internal constant VOTER_POOL_SHARE_BPS = 500; // 5%
    uint256 internal constant FAILED_REPORT_PENALTY_MULTIPLIER = 2;
    uint256 internal constant MIN_QUORUM_BPS = 1000; // 10%

    struct RewardDistribution {
        address winner;
        address loser;
        uint256 loserStake;
        uint256 actualSlash;
        uint256 winnerAmount;
        uint256 treasuryAmount;
        uint256 voterPoolAmount;
        bool isFailedReporter;
    }

    function calculateDistribution(
        bool banUpheld,
        address reporter,
        address target,
        uint256 reporterStake,
        uint256 targetStake,
        uint256 loserActualBalance
    ) internal pure returns (RewardDistribution memory dist) {
        if (banUpheld) {
            dist.winner = reporter;
            dist.loser = target;
            dist.loserStake = targetStake;
            dist.isFailedReporter = false;
        } else {
            dist.winner = target;
            dist.loser = reporter;
            dist.loserStake = reporterStake * FAILED_REPORT_PENALTY_MULTIPLIER;
            dist.isFailedReporter = true;
        }

        if (dist.loserStake == 0) return dist;

        dist.winnerAmount = (dist.loserStake * WINNER_SHARE_BPS) / 10000;
        dist.treasuryAmount = (dist.loserStake * TREASURY_SHARE_BPS) / 10000;
        dist.voterPoolAmount = (dist.loserStake * VOTER_POOL_SHARE_BPS) / 10000;

        dist.actualSlash = loserActualBalance >= dist.loserStake ? dist.loserStake : loserActualBalance;

        if (dist.actualSlash < dist.loserStake) {
            dist.winnerAmount = (dist.actualSlash * WINNER_SHARE_BPS) / 10000;
            dist.treasuryAmount = (dist.actualSlash * TREASURY_SHARE_BPS) / 10000;
            dist.voterPoolAmount = (dist.actualSlash * VOTER_POOL_SHARE_BPS) / 10000;
        }
    }

    function calculateRequiredStake(uint256 baseStake, uint256 internalDiscountBps, uint256 externalDiscountBps)
        internal
        pure
        returns (uint256 requiredStake)
    {
        uint256 totalDiscountBps = internalDiscountBps + externalDiscountBps;
        if (totalDiscountBps > 7500) {
            totalDiscountBps = 7500;
        }
        return (baseStake * (10000 - totalDiscountBps)) / 10000;
    }
}
