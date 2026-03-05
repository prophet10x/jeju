// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

interface INodeManagerModule {
    function version() external pure returns (uint16);

    function registerNode(
        address operator,
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        uint8 region
    ) external returns (bytes32 nodeId);

    function registerNodeWithAgent(
        address operator,
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        uint8 region,
        uint256 operatorAgentId
    ) external returns (bytes32 nodeId);

    function increaseStake(address operator, bytes32 nodeId, uint256 amount) external;

    function updateNodeConfig(address operator, bytes32 nodeId, string calldata rpcUrl, uint8 region) external;

    function updateNodeServices(address operator, bytes32 nodeId, bytes32 servicesHash) external;

    function setNodeMetadataURI(address operator, bytes32 nodeId, string calldata metadataURI) external;

    function claimRewards(address operator, bytes32 nodeId) external returns (uint256 rewardsUSD);

    function deregisterNode(address operator, bytes32 nodeId) external returns (uint256 unstakedAmount);
}
