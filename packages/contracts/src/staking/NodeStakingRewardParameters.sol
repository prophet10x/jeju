// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {GovernableParameterBase, IGovernableParameter} from "../governance/interfaces/IGovernableParameter.sol";

/**
 * @title NodeStakingRewardParameters
 * @notice Governance-controlled runtime parameters for node reward emissions and payout fees.
 */
contract NodeStakingRewardParameters is GovernableParameterBase {
    bytes32 public constant PARAM_BASE_REWARD_PER_MONTH_USD = keccak256("node.baseRewardPerMonthUSD");
    bytes32 public constant PARAM_REWARD_PAYOUT_BPS = keccak256("node.rewardPayoutBps");
    bytes32 public constant PARAM_PAYMASTER_REWARD_CUT_BPS = keccak256("node.paymasterRewardCutBPS");
    bytes32 public constant PARAM_PAYMASTER_STAKE_CUT_BPS = keccak256("node.paymasterStakeCutBPS");
    bytes32 public constant PARAM_MIN_STAKING_PERIOD = keccak256("node.minStakingPeriod");

    uint256 public baseRewardPerMonthUSD;
    uint256 public rewardPayoutBPS;
    uint256 public paymasterRewardCutBPS;
    uint256 public paymasterStakeCutBPS;
    uint256 public minStakingPeriod;

    error InvalidFeeConfiguration();

    constructor(address governance) GovernableParameterBase(governance) {
        _registerParameter(
            PARAM_BASE_REWARD_PER_MONTH_USD,
            "baseRewardPerMonthUSD",
            "Base monthly reward accrual in USD wei before multipliers",
            IGovernableParameter.ParameterType.UINT256,
            0,
            10_000 ether,
            100 ether,
            true
        );

        _registerParameter(
            PARAM_REWARD_PAYOUT_BPS,
            "rewardPayoutBPS",
            "Global payout multiplier applied to accrued node rewards",
            IGovernableParameter.ParameterType.UINT256,
            0,
            10_000,
            10_000,
            true
        );

        _registerParameter(
            PARAM_PAYMASTER_REWARD_CUT_BPS,
            "paymasterRewardCutBPS",
            "Paymaster fee cut on reward payouts",
            IGovernableParameter.ParameterType.UINT256,
            0,
            1_000,
            500,
            true
        );

        _registerParameter(
            PARAM_PAYMASTER_STAKE_CUT_BPS,
            "paymasterStakeCutBPS",
            "Paymaster fee cut on staking-token conversions",
            IGovernableParameter.ParameterType.UINT256,
            0,
            1_000,
            200,
            true
        );

        _registerParameter(
            PARAM_MIN_STAKING_PERIOD,
            "minStakingPeriod",
            "Minimum staking lock duration before claims and deregistration",
            IGovernableParameter.ParameterType.UINT256,
            1 hours,
            365 days,
            7 days,
            true
        );

        baseRewardPerMonthUSD = 100 ether;
        rewardPayoutBPS = 10_000;
        paymasterRewardCutBPS = 500;
        paymasterStakeCutBPS = 200;
        minStakingPeriod = 7 days;
    }

    function _applyParameter(bytes32 parameterId, uint256, uint256 newValue) internal override {
        if (parameterId == PARAM_BASE_REWARD_PER_MONTH_USD) {
            baseRewardPerMonthUSD = newValue;
            return;
        }

        if (parameterId == PARAM_REWARD_PAYOUT_BPS) {
            rewardPayoutBPS = newValue;
            return;
        }

        if (parameterId == PARAM_PAYMASTER_REWARD_CUT_BPS) {
            if (newValue + paymasterStakeCutBPS > 1_000) revert InvalidFeeConfiguration();
            paymasterRewardCutBPS = newValue;
            return;
        }

        if (parameterId == PARAM_PAYMASTER_STAKE_CUT_BPS) {
            if (paymasterRewardCutBPS + newValue > 1_000) revert InvalidFeeConfiguration();
            paymasterStakeCutBPS = newValue;
            return;
        }

        if (parameterId == PARAM_MIN_STAKING_PERIOD) {
            minStakingPeriod = newValue;
            return;
        }

        revert InvalidParameter();
    }
}
