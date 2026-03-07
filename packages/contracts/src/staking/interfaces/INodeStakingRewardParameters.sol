// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

interface INodeStakingRewardParameters {
    function baseRewardPerMonthUSD() external view returns (uint256);
    function rewardPayoutBPS() external view returns (uint256);
    function paymasterRewardCutBPS() external view returns (uint256);
    function paymasterStakeCutBPS() external view returns (uint256);
}
