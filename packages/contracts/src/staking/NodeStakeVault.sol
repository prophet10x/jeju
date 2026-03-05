// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract NodeStakeVault is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");
    bytes32 public constant OPERATIONS_ROLE = keccak256("OPERATIONS_ROLE");

    event StakeDeposited(address indexed token, address indexed from, uint256 amount);
    event StakeReleased(address indexed token, address indexed to, uint256 amount);
    event RecoveredToken(address indexed token, address indexed to, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();

    constructor(address admin, address registry) {
        if (admin == address(0) || registry == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATIONS_ROLE, admin);
        _grantRole(REGISTRY_ROLE, registry);
    }

    function depositFrom(address token, address from, uint256 amount) external onlyRole(REGISTRY_ROLE) {
        if (token == address(0) || from == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        IERC20(token).safeTransferFrom(from, address(this), amount);
        emit StakeDeposited(token, from, amount);
    }

    function releaseTo(address token, address to, uint256 amount) external onlyRole(REGISTRY_ROLE) {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        IERC20(token).safeTransfer(to, amount);
        emit StakeReleased(token, to, amount);
    }

    function recoverToken(address token, address to, uint256 amount) external onlyRole(OPERATIONS_ROLE) {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        IERC20(token).safeTransfer(to, amount);
        emit RecoveredToken(token, to, amount);
    }
}
