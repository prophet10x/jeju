// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title OraclePowerRegistry
 * @notice Bootstrap-to-permissionless oracle admission and voting power
 * @dev Bootstrap mode uses an owner-managed allowlist. After the activation
 * delay and bootstrap threshold are met, the registry switches to
 * permissionless stake-weighted oracle power.
 */
contract OraclePowerRegistry is Ownable {
    using SafeERC20 for IERC20;

    struct OraclePosition {
        uint256 stakedAmount;
        uint256 joinedAtBlock;
        bool bootstrapApproved;
        bool active;
    }

    IERC20 public immutable oracleToken;

    uint256 public immutable bootstrapStartBlock;
    uint256 public activationDelayBlocks;
    uint256 public minBootstrapApprovedOracles;
    uint256 public minPermissionlessStakeBps;

    bool public advancedMode;
    uint256 public bootstrapApprovedOracleCount;
    uint256 public activePermissionlessOracleCount;
    uint256 public totalStaked;
    uint256 public totalEligibleStake;

    mapping(address => OraclePosition) public oraclePositions;
    mapping(address => uint256) public eligibleOracleStake;

    event BootstrapOracleApproved(address indexed oracle);
    event BootstrapOracleRemoved(address indexed oracle);
    event OracleStaked(address indexed oracle, uint256 amount, uint256 totalStake);
    event OracleUnstaked(address indexed oracle, uint256 amount, uint256 remainingStake);
    event OracleEligibilityRefreshed(address indexed oracle, bool active, uint256 weight);
    event AdvancedModeActivated(uint256 activatedAtBlock, uint256 minimumStake, uint256 bootstrapApprovedOracles);
    event ActivationDelayUpdated(uint256 oldDelayBlocks, uint256 newDelayBlocks);
    event BootstrapThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event MinimumStakeBpsUpdated(uint256 oldBps, uint256 newBps);

    error InvalidAddress();
    error InvalidAmount();
    error AlreadyBootstrapApproved();
    error NotBootstrapApproved();
    error AdvancedModeAlreadyActive();
    error InsufficientOracleStake(uint256 required, uint256 actual);

    constructor(
        address _oracleToken,
        address initialOwner,
        uint256 _activationDelayBlocks,
        uint256 _minBootstrapApprovedOracles,
        uint256 _minPermissionlessStakeBps
    ) Ownable(initialOwner) {
        if (_oracleToken == address(0)) revert InvalidAddress();
        if (_minBootstrapApprovedOracles == 0) revert InvalidAmount();
        if (_minPermissionlessStakeBps == 0 || _minPermissionlessStakeBps > 10_000) revert InvalidAmount();

        oracleToken = IERC20(_oracleToken);
        bootstrapStartBlock = block.number;
        activationDelayBlocks = _activationDelayBlocks;
        minBootstrapApprovedOracles = _minBootstrapApprovedOracles;
        minPermissionlessStakeBps = _minPermissionlessStakeBps;
    }

    function minimumRequiredStake() public view returns (uint256) {
        return (oracleToken.totalSupply() * minPermissionlessStakeBps) / 10_000;
    }

    function currentModeUsesStakeWeight() external view returns (bool) {
        return advancedMode;
    }

    function canActivateAdvancedMode() public view returns (bool) {
        return !advancedMode
            && block.number >= bootstrapStartBlock + activationDelayBlocks
            && bootstrapApprovedOracleCount >= minBootstrapApprovedOracles;
    }

    function maybeActivateAdvancedMode() external returns (bool activated) {
        if (!canActivateAdvancedMode()) return false;
        _activateAdvancedMode();
        return true;
    }

    function approveBootstrapOracle(address oracle) external onlyOwner {
        if (oracle == address(0)) revert InvalidAddress();

        OraclePosition storage position = oraclePositions[oracle];
        if (position.bootstrapApproved) revert AlreadyBootstrapApproved();

        position.bootstrapApproved = true;
        if (position.joinedAtBlock == 0) {
            position.joinedAtBlock = block.number;
        }
        bootstrapApprovedOracleCount++;

        emit BootstrapOracleApproved(oracle);
    }

    function removeBootstrapOracle(address oracle) external onlyOwner {
        OraclePosition storage position = oraclePositions[oracle];
        if (!position.bootstrapApproved) revert NotBootstrapApproved();

        position.bootstrapApproved = false;
        bootstrapApprovedOracleCount--;

        emit BootstrapOracleRemoved(oracle);
    }

    function stakeAsOracle(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();

        OraclePosition storage position = oraclePositions[msg.sender];
        oracleToken.safeTransferFrom(msg.sender, address(this), amount);

        position.stakedAmount += amount;
        if (position.joinedAtBlock == 0) {
            position.joinedAtBlock = block.number;
        }

        totalStaked += amount;
        emit OracleStaked(msg.sender, amount, position.stakedAmount);

        _refreshOracleEligibility(msg.sender);
    }

    function unstakeOracle(uint256 amount) external {
        OraclePosition storage position = oraclePositions[msg.sender];
        if (amount == 0 || amount > position.stakedAmount) revert InvalidAmount();

        position.stakedAmount -= amount;
        totalStaked -= amount;

        emit OracleUnstaked(msg.sender, amount, position.stakedAmount);

        _refreshOracleEligibility(msg.sender);
        oracleToken.safeTransfer(msg.sender, amount);
    }

    function refreshOracleEligibility(address oracle) external returns (bool active, uint256 weight) {
        _refreshOracleEligibility(oracle);
        return (oraclePositions[oracle].active, getOracleWeight(oracle));
    }

    function isEligibleOracle(address oracle) public view returns (bool) {
        OraclePosition storage position = oraclePositions[oracle];

        if (!advancedMode) {
            return position.bootstrapApproved;
        }

        return position.active && position.stakedAmount >= minimumRequiredStake();
    }

    function getOracleWeight(address oracle) public view returns (uint256) {
        OraclePosition storage position = oraclePositions[oracle];

        if (!advancedMode) {
            return position.bootstrapApproved ? 1 : 0;
        }

        if (!position.active) return 0;
        return position.stakedAmount >= minimumRequiredStake() ? position.stakedAmount : 0;
    }

    function totalConsensusWeight() public view returns (uint256) {
        return advancedMode ? totalEligibleStake : bootstrapApprovedOracleCount;
    }

    function setActivationDelayBlocks(uint256 newDelayBlocks) external onlyOwner {
        if (newDelayBlocks == 0) revert InvalidAmount();
        uint256 oldDelay = activationDelayBlocks;
        activationDelayBlocks = newDelayBlocks;
        emit ActivationDelayUpdated(oldDelay, newDelayBlocks);
    }

    function setBootstrapThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold == 0) revert InvalidAmount();
        uint256 oldThreshold = minBootstrapApprovedOracles;
        minBootstrapApprovedOracles = newThreshold;
        emit BootstrapThresholdUpdated(oldThreshold, newThreshold);
    }

    function setMinimumStakeBps(uint256 newBps) external onlyOwner {
        if (newBps == 0 || newBps > 10_000) revert InvalidAmount();
        uint256 oldBps = minPermissionlessStakeBps;
        minPermissionlessStakeBps = newBps;
        emit MinimumStakeBpsUpdated(oldBps, newBps);
    }

    function _activateAdvancedMode() internal {
        advancedMode = true;
        emit AdvancedModeActivated(block.number, minimumRequiredStake(), bootstrapApprovedOracleCount);
    }

    function _refreshOracleEligibility(address oracle) internal {
        OraclePosition storage position = oraclePositions[oracle];
        uint256 previousEligibleStake = eligibleOracleStake[oracle];

        if (!advancedMode) {
            emit OracleEligibilityRefreshed(oracle, position.bootstrapApproved, getOracleWeight(oracle));
            return;
        }

        uint256 required = minimumRequiredStake();
        bool shouldBeActive = position.stakedAmount >= required;
        uint256 nextEligibleStake = shouldBeActive ? position.stakedAmount : 0;

        if (totalEligibleStake >= previousEligibleStake) {
            totalEligibleStake -= previousEligibleStake;
        }
        totalEligibleStake += nextEligibleStake;

        if (!position.active && shouldBeActive) {
            activePermissionlessOracleCount++;
        } else if (position.active && !shouldBeActive) {
            activePermissionlessOracleCount--;
        }

        position.active = shouldBeActive;
        eligibleOracleStake[oracle] = nextEligibleStake;

        emit OracleEligibilityRefreshed(oracle, shouldBeActive, getOracleWeight(oracle));
    }
}
