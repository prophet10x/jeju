// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {INodeStakingManager} from "./INodeStakingManager.sol";

interface INodeStakingManagerV2 is INodeStakingManager {
    event NodeStakeIncreased(bytes32 indexed nodeId, address indexed operator, uint256 amount, uint256 newStakeAmount);
    event NodeConfigUpdated(
        bytes32 indexed nodeId,
        address indexed operator,
        string rpcUrl,
        Region region,
        string previousRpcUrl,
        Region previousRegion
    );
    event NodeServicesUpdated(bytes32 indexed nodeId, address indexed operator, bytes32 servicesHash);
    event NodeMetadataURIUpdated(bytes32 indexed nodeId, address indexed operator, string metadataURI);

    function increaseStake(bytes32 nodeId, uint256 amount) external;

    function updateNodeConfig(bytes32 nodeId, string calldata rpcUrl, Region region) external;

    function updateNodeServices(bytes32 nodeId, bytes32 servicesHash) external;

    function setNodeMetadataURI(bytes32 nodeId, string calldata metadataURI) external;

    function getNodeServicesHash(bytes32 nodeId) external view returns (bytes32);

    function getNodeMetadataURI(bytes32 nodeId) external view returns (string memory);
}
