// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {NodeStateTypes} from "../libraries/NodeStateTypes.sol";

interface INodeStateRegistry {
    function getNodeState(bytes32 nodeId) external view returns (NodeStateTypes.NodeState memory);

    function getNodeVersion(bytes32 nodeId) external view returns (uint16);

    function getMigrationCursor(bytes32 nodeId) external view returns (NodeStateTypes.MigrationCursor memory);

    function getOperatorNodes(address operator) external view returns (bytes32[] memory);

    function getAllNodes() external view returns (bytes32[] memory);

    function getModule(uint16 version) external view returns (address);

    function getOperatorStats(address operator) external view returns (NodeStateTypes.OperatorStats memory);

    function getNetworkStats()
        external
        view
        returns (uint256 totalNodesActive, uint256 totalStakedUSD, uint256 totalRewardsClaimedUSD);

    function getTokenDistribution(address token) external view returns (NodeStateTypes.TokenDistribution memory);

    function createNode(NodeStateTypes.NodeStateInput calldata input) external returns (bytes32 nodeId);

    function increaseStakeFromModule(bytes32 nodeId, address operator, uint256 amount, uint256 addedValueUSD) external;

    function updateNodeConfigFromModule(bytes32 nodeId, address operator, string calldata rpcUrl, uint8 region) external;

    function updateNodeServicesFromModule(bytes32 nodeId, address operator, bytes32 servicesHash) external;

    function setNodeMetadataURIFromModule(bytes32 nodeId, address operator, string calldata metadataURI) external;

    function recordRewardClaimFromModule(bytes32 nodeId, address operator, uint256 rewardsUSD) external;

    function deactivateNodeFromModule(bytes32 nodeId, address operator, address payoutRecipient)
        external
        returns (uint256 unstakedAmount);

    function applyMigrationPatch(bytes32 nodeId, NodeStateTypes.MigrationPatch calldata patch) external;

    function upgradeNodeVersion(bytes32 nodeId, uint16 targetVersion, uint256 maxSteps) external;
}
