// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.33;

import "./ModerationMarketplace.sol";
import {ModerationReputationLib} from "./libraries/ModerationReputationLib.sol";

/**
 * @title ModerationMarketplaceViews
 * @notice Read-only helper contract for complex view functions
 * @dev Separated from ModerationMarketplace to stay under EIP-170 bytecode limit.
 *      All functions are view-only and read from the main marketplace contract.
 */
contract ModerationMarketplaceViews {
    ModerationMarketplace public immutable marketplace;

    constructor(address _marketplace) {
        marketplace = ModerationMarketplace(payable(_marketplace));
    }

    function checkQuorumStatus(address target)
        external
        view
        returns (bool reached, uint256 currentCount, uint256 requiredCount)
    {
        // Get count via public array getter - iterate until revert
        currentCount = _getPendingQuorumCount(target);
        requiredCount = type(uint256).max;

        for (uint256 i = 0; i < currentCount; i++) {
            address reporter = marketplace.pendingQuorumReports(target, i);
            uint256 q = marketplace.getQuorumRequired(reporter);
            if (q < requiredCount) {
                requiredCount = q;
            }
        }
        reached = currentCount >= requiredCount && requiredCount != type(uint256).max;
    }

    function getReportLimits(address user)
        external
        view
        returns (
            uint256 dailyUsed,
            uint256 dailyLimit,
            uint256 weeklyUsed,
            uint256 weeklyLimit,
            uint256 activeReports,
            uint256 activeLimit
        )
    {
        (,,,,,, uint256 reportCooldownUntil_,
         uint256 dailyReportCount, uint256 weeklyReportCount,
         uint256 reportDayStart, uint256 reportWeekStart,
         ,, uint256 activeReportCount) = marketplace.moderatorReputation(user);

        dailyUsed = block.timestamp >= reportDayStart + 1 days ? 0 : dailyReportCount;
        weeklyUsed = block.timestamp >= reportWeekStart + 7 days ? 0 : weeklyReportCount;

        dailyLimit = ModerationReputationLib.MAX_REPORTS_PER_DAY;
        weeklyLimit = ModerationReputationLib.MAX_REPORTS_PER_WEEK;
        activeReports = activeReportCount;
        activeLimit = ModerationReputationLib.MAX_ACTIVE_REPORTS;
    }

    function getQuorumRequirements(address target)
        external
        view
        returns (
            uint256 combinedStakeRequired,
            uint256 currentCombinedStake,
            uint256 participantsRequired,
            uint256 currentParticipants,
            uint256 stakeAgeRequired
        )
    {
        currentParticipants = _getPendingQuorumCount(target);

        for (uint256 i = 0; i < currentParticipants; i++) {
            address reporter = marketplace.pendingQuorumReports(target, i);
            (uint256 amount,,,,) = marketplace.stakes(reporter);
            currentCombinedStake += amount;
        }

        participantsRequired = type(uint256).max;
        for (uint256 i = 0; i < currentParticipants; i++) {
            address reporter = marketplace.pendingQuorumReports(target, i);
            uint256 q = marketplace.getQuorumRequired(reporter);
            if (q < participantsRequired) {
                participantsRequired = q;
            }
        }
        if (participantsRequired == type(uint256).max) {
            participantsRequired = ModerationReputationLib.LOW_REP_QUORUM;
        }

        combinedStakeRequired = marketplace.MIN_COMBINED_QUORUM_STAKE();
        stakeAgeRequired = marketplace.MIN_QUORUM_STAKE_AGE();
    }

    function _getPendingQuorumCount(address target) internal view returns (uint256 count) {
        // pendingQuorumReports is a public mapping(address => address[])
        // Public array mappings expose index-based getters that revert on out-of-bounds
        while (true) {
            try marketplace.pendingQuorumReports(target, count) returns (address) {
                count++;
            } catch {
                break;
            }
        }
    }
}
