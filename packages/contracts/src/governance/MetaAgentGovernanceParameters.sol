// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {GovernableParameterBase, IGovernableParameter} from "./interfaces/IGovernableParameter.sol";

/**
 * @title MetaAgentGovernanceParameters
 * @notice Runtime-tunable parameters for Meta-Agent proposer/runoff governance.
 * @dev Parameter values are governed by the runtime lane (governance), while
 *      parameter bounds are controlled by constitutional governance.
 */
contract MetaAgentGovernanceParameters is GovernableParameterBase {
    bytes32 public constant PARAM_VOTE_BLEND_BPS = keccak256("meta.voteBlendBps");
    bytes32 public constant PARAM_BASE_PARTICIPATION_WEIGHT_BPS = keccak256("meta.baseParticipationWeightBps");
    bytes32 public constant PARAM_MAX_PARTICIPATION_WEIGHT_BPS = keccak256("meta.maxParticipationWeightBps");
    bytes32 public constant PARAM_BOARD_TARGET_TURNOUT_BPS = keccak256("meta.boardTargetTurnoutBps");
    bytes32 public constant PARAM_STAKE_TARGET_TURNOUT_BPS = keccak256("meta.stakeTargetTurnoutBps");
    bytes32 public constant PARAM_LOOKBACK_DAYS = keccak256("meta.lookbackDays");
    bytes32 public constant PARAM_HALF_LIFE_DAYS = keccak256("meta.halfLifeDays");
    bytes32 public constant PARAM_PROPOSER_SLA_SECONDS = keccak256("meta.proposerSlaSeconds");
    bytes32 public constant PARAM_RUNTIME_DELAY_SECONDS = keccak256("meta.runtimeDelaySeconds");
    bytes32 public constant PARAM_BOARD_ROUND_SECONDS = keccak256("meta.boardRoundSeconds");
    bytes32 public constant PARAM_STAKE_ROUND_SECONDS = keccak256("meta.stakeRoundSeconds");
    bytes32 public constant PARAM_FINALIZE_ROUND_SECONDS = keccak256("meta.finalizeRoundSeconds");

    uint256 public voteBlendBps;
    uint256 public baseParticipationWeightBps;
    uint256 public maxParticipationWeightBps;
    uint256 public boardTargetTurnoutBps;
    uint256 public stakeTargetTurnoutBps;
    uint256 public lookbackDays;
    uint256 public halfLifeDays;
    uint256 public proposerSlaSeconds;
    uint256 public runtimeDelaySeconds;
    uint256 public boardRoundSeconds;
    uint256 public stakeRoundSeconds;
    uint256 public finalizeRoundSeconds;

    address public constitutionalGovernor;

    event ConstitutionalGovernorUpdated(address indexed oldGovernor, address indexed newGovernor);
    event ParameterBoundsUpdated(bytes32 indexed parameterId, uint256 oldMinValue, uint256 newMinValue, uint256 oldMaxValue, uint256 newMaxValue);

    error NotConstitutionalGovernor();
    error InvalidBounds();
    error InvalidAddress();
    error ValueOutsideBounds();
    error InvalidParticipationWeights();
    error InvalidDecayConfiguration();

    modifier onlyConstitutionalGovernor() {
        if (msg.sender != constitutionalGovernor) revert NotConstitutionalGovernor();
        _;
    }

    constructor(address runtimeGovernor, address initialConstitutionalGovernor)
        GovernableParameterBase(runtimeGovernor)
    {
        if (runtimeGovernor == address(0) || initialConstitutionalGovernor == address(0)) {
            revert InvalidAddress();
        }

        constitutionalGovernor = initialConstitutionalGovernor;

        _registerParameter(
            PARAM_VOTE_BLEND_BPS,
            "voteBlendBps",
            "Blend weight for vote share in final score",
            IGovernableParameter.ParameterType.UINT256,
            5000,
            9000,
            7000,
            true
        );

        _registerParameter(
            PARAM_BASE_PARTICIPATION_WEIGHT_BPS,
            "baseParticipationWeightBps",
            "Base participation component weight",
            IGovernableParameter.ParameterType.UINT256,
            500,
            5000,
            2000,
            true
        );

        _registerParameter(
            PARAM_MAX_PARTICIPATION_WEIGHT_BPS,
            "maxParticipationWeightBps",
            "Max participation component weight under low turnout",
            IGovernableParameter.ParameterType.UINT256,
            1000,
            8000,
            5000,
            true
        );

        _registerParameter(
            PARAM_BOARD_TARGET_TURNOUT_BPS,
            "boardTargetTurnoutBps",
            "Target board turnout in basis points",
            IGovernableParameter.ParameterType.UINT256,
            1000,
            10000,
            6000,
            true
        );

        _registerParameter(
            PARAM_STAKE_TARGET_TURNOUT_BPS,
            "stakeTargetTurnoutBps",
            "Target stake turnout in basis points",
            IGovernableParameter.ParameterType.UINT256,
            100,
            10000,
            1500,
            true
        );

        _registerParameter(
            PARAM_LOOKBACK_DAYS,
            "lookbackDays",
            "Participation history lookback window in days",
            IGovernableParameter.ParameterType.UINT256,
            30,
            720,
            360,
            true
        );

        _registerParameter(
            PARAM_HALF_LIFE_DAYS,
            "halfLifeDays",
            "Half-life in days for participation decay",
            IGovernableParameter.ParameterType.UINT256,
            7,
            360,
            90,
            true
        );

        _registerParameter(
            PARAM_PROPOSER_SLA_SECONDS,
            "proposerSlaSeconds",
            "Proposer submit deadline",
            IGovernableParameter.ParameterType.UINT256,
            300,
            7200,
            1800,
            true
        );

        _registerParameter(
            PARAM_RUNTIME_DELAY_SECONDS,
            "runtimeDelaySeconds",
            "Runtime lane execution delay",
            IGovernableParameter.ParameterType.UINT256,
            600,
            2 days,
            6 hours,
            true
        );

        _registerParameter(
            PARAM_BOARD_ROUND_SECONDS,
            "boardRoundSeconds",
            "Board round voting duration",
            IGovernableParameter.ParameterType.UINT256,
            60,
            2 hours,
            10 minutes,
            true
        );

        _registerParameter(
            PARAM_STAKE_ROUND_SECONDS,
            "stakeRoundSeconds",
            "Stake round voting duration",
            IGovernableParameter.ParameterType.UINT256,
            60,
            2 hours,
            15 minutes,
            true
        );

        _registerParameter(
            PARAM_FINALIZE_ROUND_SECONDS,
            "finalizeRoundSeconds",
            "Post-vote finalize window",
            IGovernableParameter.ParameterType.UINT256,
            60,
            30 minutes,
            5 minutes,
            true
        );

        voteBlendBps = 7000;
        baseParticipationWeightBps = 2000;
        maxParticipationWeightBps = 5000;
        boardTargetTurnoutBps = 6000;
        stakeTargetTurnoutBps = 1500;
        lookbackDays = 360;
        halfLifeDays = 90;
        proposerSlaSeconds = 1800;
        runtimeDelaySeconds = 6 hours;
        boardRoundSeconds = 10 minutes;
        stakeRoundSeconds = 15 minutes;
        finalizeRoundSeconds = 5 minutes;
    }

    function setConstitutionalGovernor(address newGovernor) external onlyGovernance {
        if (newGovernor == address(0)) revert InvalidAddress();
        address oldGovernor = constitutionalGovernor;
        constitutionalGovernor = newGovernor;
        emit ConstitutionalGovernorUpdated(oldGovernor, newGovernor);
    }

    function setParameterBounds(bytes32 parameterId, uint256 newMinValue, uint256 newMaxValue)
        external
        onlyConstitutionalGovernor
    {
        if (newMinValue > newMaxValue) revert InvalidBounds();

        ParameterInfo storage parameter = _parameters[parameterId];
        if (parameter.id == bytes32(0)) revert InvalidParameter();

        if (parameter.currentValue < newMinValue || parameter.currentValue > newMaxValue) {
            revert ValueOutsideBounds();
        }

        uint256 oldMinValue = parameter.minValue;
        uint256 oldMaxValue = parameter.maxValue;
        parameter.minValue = newMinValue;
        parameter.maxValue = newMaxValue;

        emit ParameterBoundsUpdated(parameterId, oldMinValue, newMinValue, oldMaxValue, newMaxValue);
    }

    function _applyParameter(bytes32 parameterId, uint256 /* oldValue */ , uint256 newValue) internal override {
        if (parameterId == PARAM_VOTE_BLEND_BPS) {
            voteBlendBps = newValue;
        } else if (parameterId == PARAM_BASE_PARTICIPATION_WEIGHT_BPS) {
            baseParticipationWeightBps = newValue;
        } else if (parameterId == PARAM_MAX_PARTICIPATION_WEIGHT_BPS) {
            maxParticipationWeightBps = newValue;
        } else if (parameterId == PARAM_BOARD_TARGET_TURNOUT_BPS) {
            boardTargetTurnoutBps = newValue;
        } else if (parameterId == PARAM_STAKE_TARGET_TURNOUT_BPS) {
            stakeTargetTurnoutBps = newValue;
        } else if (parameterId == PARAM_LOOKBACK_DAYS) {
            lookbackDays = newValue;
        } else if (parameterId == PARAM_HALF_LIFE_DAYS) {
            halfLifeDays = newValue;
        } else if (parameterId == PARAM_PROPOSER_SLA_SECONDS) {
            proposerSlaSeconds = newValue;
        } else if (parameterId == PARAM_RUNTIME_DELAY_SECONDS) {
            runtimeDelaySeconds = newValue;
        } else if (parameterId == PARAM_BOARD_ROUND_SECONDS) {
            boardRoundSeconds = newValue;
        } else if (parameterId == PARAM_STAKE_ROUND_SECONDS) {
            stakeRoundSeconds = newValue;
        } else if (parameterId == PARAM_FINALIZE_ROUND_SECONDS) {
            finalizeRoundSeconds = newValue;
        } else {
            revert InvalidParameter();
        }

        _validateRuntimeConfiguration();
    }

    function _validateRuntimeConfiguration() internal view {
        if (baseParticipationWeightBps > maxParticipationWeightBps || maxParticipationWeightBps > 10_000) {
            revert InvalidParticipationWeights();
        }

        if (halfLifeDays == 0 || lookbackDays == 0 || halfLifeDays > lookbackDays) {
            revert InvalidDecayConfiguration();
        }
    }
}
