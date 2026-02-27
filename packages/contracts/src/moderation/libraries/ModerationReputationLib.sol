// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.33;

/**
 * @title ModerationReputationLib
 * @notice Internal library for moderator reputation calculations
 * @dev All functions are internal (inlined at compile time, no DELEGATECALL, no linking needed)
 */
library ModerationReputationLib {
    uint256 internal constant MAX_REPUTATION = 10000;
    uint256 internal constant INITIAL_REPUTATION = 4000;
    uint256 internal constant REP_GAIN_PER_WIN = 200;
    uint256 internal constant REP_LOSS_PER_LOSS = 600;
    uint256 internal constant SLASH_REP_MULTIPLIER = 3;

    uint256 internal constant TIER_LOW = 1000;
    uint256 internal constant TIER_MEDIUM = 3000;
    uint256 internal constant TIER_HIGH = 6000;
    uint256 internal constant TIER_TRUSTED = 8000;

    uint256 internal constant LOW_REP_QUORUM = 3;
    uint256 internal constant MEDIUM_REP_QUORUM = 2;
    uint256 internal constant TRUSTED_STAKE_DISCOUNT_BPS = 5000;

    uint256 internal constant REPORT_COOLDOWN = 24 hours;
    uint256 internal constant MIN_REPORT_INTERVAL = 24 hours;
    uint256 internal constant MAX_REPORTS_PER_DAY = 3;
    uint256 internal constant MAX_REPORTS_PER_WEEK = 10;
    uint256 internal constant MAX_ACTIVE_REPORTS = 3;

    uint256 internal constant REP_DECAY_PER_WEEK = 100;
    uint256 internal constant REP_DECAY_GRACE_WEEKS = 4;
    uint256 internal constant CONSECUTIVE_WIN_THRESHOLD = 5;
    uint256 internal constant PROGRESSIVE_COOLDOWN_HOURS = 6;

    enum ReputationTier {
        UNTRUSTED,
        LOW,
        MEDIUM,
        HIGH,
        TRUSTED
    }

    struct ReputationUpdate {
        uint256 newScore;
        uint256 cooldownDuration;
    }

    function getTier(uint256 score, bool isNew) internal pure returns (ReputationTier tier) {
        if (isNew) {
            score = INITIAL_REPUTATION;
        }
        if (score <= TIER_LOW) return ReputationTier.UNTRUSTED;
        if (score <= TIER_MEDIUM) return ReputationTier.LOW;
        if (score <= TIER_HIGH) return ReputationTier.MEDIUM;
        if (score <= TIER_TRUSTED) return ReputationTier.HIGH;
        return ReputationTier.TRUSTED;
    }

    function getQuorumForTier(ReputationTier tier) internal pure returns (uint256 quorum) {
        if (tier == ReputationTier.UNTRUSTED) {
            return type(uint256).max;
        } else if (tier == ReputationTier.LOW) {
            return LOW_REP_QUORUM;
        } else if (tier == ReputationTier.MEDIUM) {
            return MEDIUM_REP_QUORUM;
        }
        return 1;
    }

    function getStakeDiscountBps(ReputationTier tier) internal pure returns (uint256 discountBps) {
        if (tier == ReputationTier.TRUSTED) {
            return TRUSTED_STAKE_DISCOUNT_BPS;
        } else if (tier == ReputationTier.HIGH) {
            return 2500;
        }
        return 0;
    }

    function calculateReputationUpdate(
        uint256 currentScore,
        bool won,
        uint256 amountLost,
        uint256 consecutiveWins,
        uint256 unsuccessfulBans
    ) internal pure returns (ReputationUpdate memory result) {
        if (won) {
            uint256 repGain = REP_GAIN_PER_WIN;
            if (consecutiveWins > CONSECUTIVE_WIN_THRESHOLD) {
                uint256 halvings = consecutiveWins - CONSECUTIVE_WIN_THRESHOLD;
                for (uint256 i = 0; i < halvings && repGain > 10; i++) {
                    repGain = repGain / 2;
                }
            }
            result.newScore = currentScore + repGain;
            if (result.newScore > MAX_REPUTATION) {
                result.newScore = MAX_REPUTATION;
            }
            result.cooldownDuration = 0;
        } else {
            uint256 penalty = REP_LOSS_PER_LOSS;
            if (amountLost > 0) {
                penalty = penalty * SLASH_REP_MULTIPLIER;
            }
            if (currentScore > penalty) {
                result.newScore = currentScore - penalty;
            } else {
                result.newScore = 0;
            }
            result.cooldownDuration = REPORT_COOLDOWN + (unsuccessfulBans * PROGRESSIVE_COOLDOWN_HOURS * 1 hours);
            if (result.cooldownDuration > 7 days) {
                result.cooldownDuration = 7 days;
            }
        }
    }

    function calculateDecay(uint256 currentScore, uint256 lastActivityTimestamp, uint256 currentTimestamp)
        internal
        pure
        returns (uint256 newScore)
    {
        if (lastActivityTimestamp == 0) {
            return currentScore;
        }

        uint256 timeSinceActivity = currentTimestamp - lastActivityTimestamp;

        if (timeSinceActivity <= REP_DECAY_GRACE_WEEKS * 7 days) {
            return currentScore;
        }

        uint256 secondsPastGrace = timeSinceActivity - REP_DECAY_GRACE_WEEKS * 7 days;
        uint256 weekSeconds = 7 days;

        uint256 decayAmount = (currentScore * REP_DECAY_PER_WEEK * secondsPastGrace) / (weekSeconds * 10000);

        uint256 minDecay = secondsPastGrace >= 1 days ? 10 : 0;
        if (decayAmount < minDecay) {
            decayAmount = minDecay;
        }

        if (currentScore > decayAmount + TIER_MEDIUM) {
            return currentScore - decayAmount;
        }
        return TIER_MEDIUM;
    }
}
