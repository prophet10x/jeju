// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

interface INodeRewardVault {
    function available(address token) external view returns (uint256);
    function disburse(address token, address recipient, uint256 amount) external;
}
