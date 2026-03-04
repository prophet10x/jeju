// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INodeStakingManagerV2} from "./INodeStakingManagerV2.sol";
import {NodeStakingManager} from "./NodeStakingManager.sol";

/**
 * @title NodeStakingManagerV2
 * @notice Successor to NodeStakingManager with editable node operations.
 * @dev Keeps V1 registration/reward semantics and adds explicit node update methods.
 */
contract NodeStakingManagerV2 is NodeStakingManager, INodeStakingManagerV2 {
    using SafeERC20 for IERC20;

    mapping(bytes32 => bytes32) public nodeServicesHash;
    mapping(bytes32 => string) private _nodeMetadataURI;

    error InvalidRpcUrl();

    constructor(
        address _tokenRegistry,
        address _paymasterFactory,
        address _priceOracle,
        address _performanceOracle,
        address initialOwner
    ) NodeStakingManager(_tokenRegistry, _paymasterFactory, _priceOracle, _performanceOracle, initialOwner) {}

    function increaseStake(bytes32 nodeId, uint256 amount) external whenNotPaused nonReentrant {
        NodeStake storage node = nodes[nodeId];

        if (node.operator == address(0)) revert NodeNotFound(nodeId);
        if (node.operator != msg.sender) revert Unauthorized();
        if (!node.isActive) revert NodeNotActive();
        if (node.isSlashed) revert NodeAlreadySlashed();
        if (amount == 0) revert ZeroStake();
        if (!tokenRegistry.isSupported(node.stakedToken)) revert TokenNotRegistered(node.stakedToken);
        if (!paymasterFactory.isDeployed(node.stakedToken)) revert NoPaymasterForToken(node.stakedToken);

        (uint256 tokenPrice,) = priceOracle.getPrice(node.stakedToken);
        if (tokenPrice == 0) revert("Invalid token price");
        uint256 addedStakeUSD = (amount * tokenPrice) / 1e18;

        uint256 newOperatorStakeUSD = operatorStats[msg.sender].totalStakedUSD + addedStakeUSD;
        uint256 newTotalStakedUSD = totalStakedUSD + addedStakeUSD;
        if (totalStakedUSD > 0) {
            uint256 ownershipBPS = (newOperatorStakeUSD * BPS_DENOMINATOR) / newTotalStakedUSD;
            if (ownershipBPS > maxNetworkOwnershipBPS) {
                revert NetworkOwnershipExceeded(ownershipBPS, maxNetworkOwnershipBPS);
            }
        }

        IERC20(node.stakedToken).safeTransferFrom(msg.sender, address(this), amount);

        node.stakedAmount += amount;
        node.stakedValueUSD += addedStakeUSD;
        operatorStats[msg.sender].totalStakedUSD += addedStakeUSD;
        tokenDistribution[node.stakedToken].totalStaked += amount;
        tokenDistribution[node.stakedToken].totalStakedUSD += addedStakeUSD;
        totalStakedUSD += addedStakeUSD;

        emit NodeStakeIncreased(nodeId, msg.sender, amount, node.stakedAmount);
    }

    function updateNodeConfig(bytes32 nodeId, string calldata rpcUrl, Region region) external whenNotPaused {
        NodeStake storage node = nodes[nodeId];

        if (node.operator == address(0)) revert NodeNotFound(nodeId);
        if (node.operator != msg.sender) revert Unauthorized();
        if (!node.isActive) revert NodeNotActive();
        if (node.isSlashed) revert NodeAlreadySlashed();
        if (bytes(rpcUrl).length == 0) revert InvalidRpcUrl();

        string memory previousRpcUrl = node.rpcUrl;
        Region previousRegion = node.geographicRegion;

        if (previousRegion != region) {
            nodesByRegion[previousRegion]--;
            nodesByRegion[region]++;
        }

        node.rpcUrl = rpcUrl;
        node.geographicRegion = region;

        emit NodeConfigUpdated(nodeId, msg.sender, rpcUrl, region, previousRpcUrl, previousRegion);
    }

    function updateNodeServices(bytes32 nodeId, bytes32 servicesHash) external whenNotPaused {
        NodeStake storage node = nodes[nodeId];

        if (node.operator == address(0)) revert NodeNotFound(nodeId);
        if (node.operator != msg.sender) revert Unauthorized();
        if (!node.isActive) revert NodeNotActive();
        if (node.isSlashed) revert NodeAlreadySlashed();

        nodeServicesHash[nodeId] = servicesHash;
        emit NodeServicesUpdated(nodeId, msg.sender, servicesHash);
    }

    function setNodeMetadataURI(bytes32 nodeId, string calldata metadataURI) external whenNotPaused {
        NodeStake storage node = nodes[nodeId];

        if (node.operator == address(0)) revert NodeNotFound(nodeId);
        if (node.operator != msg.sender) revert Unauthorized();
        if (!node.isActive) revert NodeNotActive();
        if (node.isSlashed) revert NodeAlreadySlashed();

        _nodeMetadataURI[nodeId] = metadataURI;
        emit NodeMetadataURIUpdated(nodeId, msg.sender, metadataURI);
    }

    function getNodeServicesHash(bytes32 nodeId) external view returns (bytes32) {
        return nodeServicesHash[nodeId];
    }

    function getNodeMetadataURI(bytes32 nodeId) external view returns (string memory) {
        return _nodeMetadataURI[nodeId];
    }
}
