// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title NodeRewardVault
 * @notice Isolated ERC20 custody for node reward payouts.
 * @dev Keeps reward liquidity separate from staked principal held in staking managers.
 */
contract NodeRewardVault is Ownable {
    using SafeERC20 for IERC20;

    mapping(address => bool) public authorizedManagers;

    error InvalidAddress();
    error InvalidAmount();
    error UnauthorizedManager();

    event AuthorizedManagerUpdated(address indexed manager, bool authorized);
    event RewardDeposited(address indexed funder, address indexed token, uint256 amount);
    event RewardWithdrawn(address indexed recipient, address indexed token, uint256 amount);
    event RewardDisbursed(address indexed manager, address indexed recipient, address indexed token, uint256 amount);

    modifier onlyAuthorizedManager() {
        if (!authorizedManagers[msg.sender]) revert UnauthorizedManager();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setAuthorizedManager(address manager, bool authorized) external onlyOwner {
        if (manager == address(0)) revert InvalidAddress();
        authorizedManagers[manager] = authorized;
        emit AuthorizedManagerUpdated(manager, authorized);
    }

    function deposit(address token, uint256 amount) external {
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit RewardDeposited(msg.sender, token, amount);
    }

    function withdraw(address token, address recipient, uint256 amount) external onlyOwner {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(token).safeTransfer(recipient, amount);
        emit RewardWithdrawn(recipient, token, amount);
    }

    function disburse(address token, address recipient, uint256 amount) external onlyAuthorizedManager {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(token).safeTransfer(recipient, amount);
        emit RewardDisbursed(msg.sender, recipient, token, amount);
    }

    function available(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
