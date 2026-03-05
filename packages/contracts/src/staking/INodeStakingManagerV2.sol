// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {INodeStakingManager} from "./INodeStakingManager.sol";
import {IIdentityRegistry} from "../registry/interfaces/IIdentityRegistry.sol";

interface INodeStakingManagerV2 is INodeStakingManager {
    event NodeStakeIncreased(bytes32 indexed nodeId, address indexed operator, uint256 amount, uint256 newStakeAmount);
    event BootstrapOwnershipCapConfigUpdated(bool enabled, uint256 nodeThreshold);
    event NodeStakeRevalued(
        bytes32 indexed nodeId,
        address indexed operator,
        address indexed stakedToken,
        uint256 previousStakedValueUSD,
        uint256 newStakedValueUSD
    );
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
    event NodeIdentityLinked(
        bytes32 indexed nodeId,
        uint256 indexed nodeIdentityAgentId,
        uint256 indexed operatorAgentId,
        address owner
    );

    function registerNodeWithAgentAndIdentity(
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        Region region,
        uint256 operatorAgentId,
        string calldata nodeIdentityTokenURI,
        IIdentityRegistry.MetadataEntry[] calldata nodeIdentityMetadata
    ) external returns (bytes32 nodeId, uint256 nodeIdentityAgentId);

    function increaseStake(bytes32 nodeId, uint256 amount) external;

    function updateNodeConfig(bytes32 nodeId, string calldata rpcUrl, Region region) external;

    function updateNodeServices(bytes32 nodeId, bytes32 servicesHash) external;

    function setNodeMetadataURI(bytes32 nodeId, string calldata metadataURI) external;

    function setBootstrapOwnershipCapConfig(bool enabled, uint256 nodeThreshold) external;

    function revalueNode(bytes32 nodeId) external returns (uint256 previousStakedValueUSD, uint256 newStakedValueUSD);

    function revalueNodes(bytes32[] calldata nodeIds) external returns (uint256 updatedCount);

    function getNodeServicesHash(bytes32 nodeId) external view returns (bytes32);

    function getNodeMetadataURI(bytes32 nodeId) external view returns (string memory);

    function getNodeIdentityAgentId(bytes32 nodeId) external view returns (uint256 nodeIdentityAgentId);

    function getNodeIdByIdentityAgent(uint256 nodeIdentityAgentId) external view returns (bytes32 nodeId);

    function getCurrentStakeValueUSD(bytes32 nodeId) external view returns (uint256 currentStakeValueUSD);

    function bootstrapOwnershipCapExemptionEnabled() external view returns (bool);

    function bootstrapOwnershipCapExemptionNodeThreshold() external view returns (uint256);

    function supportsAtomicNodeIdentityRegistration() external pure returns (bool);
}
