// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INodeStakingManagerV2} from "./INodeStakingManagerV2.sol";
import {NodeStakingManager} from "./NodeStakingManager.sol";
import {IIdentityRegistry} from "../registry/interfaces/IIdentityRegistry.sol";

/**
 * @title NodeStakingManagerV2
 * @notice Successor to NodeStakingManager with editable node operations.
 * @dev Keeps V1 registration/reward semantics and adds explicit node update methods.
 */
contract NodeStakingManagerV2 is NodeStakingManager, INodeStakingManagerV2 {
    using SafeERC20 for IERC20;

    mapping(bytes32 => bytes32) public nodeServicesHash;
    mapping(bytes32 => string) private _nodeMetadataURI;
    mapping(bytes32 => uint256) private _nodeIdentityAgentIds;
    mapping(uint256 => bytes32) private _nodeIdsByIdentityAgent;
    bool public bootstrapOwnershipCapExemptionEnabled = true;
    uint256 public bootstrapOwnershipCapExemptionNodeThreshold = 20;

    error InvalidRpcUrl();
    error IdentityAgentAlreadyLinked(uint256 nodeIdentityAgentId);
    event NodeIdentityFallbackUsed(bytes32 indexed nodeId, uint256 indexed operatorAgentId, address owner);

    constructor(
        address _tokenRegistry,
        address _paymasterFactory,
        address _priceOracle,
        address _performanceOracle,
        address initialOwner
    ) NodeStakingManager(_tokenRegistry, _paymasterFactory, _priceOracle, _performanceOracle, initialOwner) {}

    function registerNodeWithAgentAndIdentity(
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        Region region,
        uint256 operatorAgentId,
        string calldata nodeIdentityTokenURI,
        IIdentityRegistry.MetadataEntry[] calldata nodeIdentityMetadata
    ) external whenNotPaused returns (bytes32 nodeId, uint256 nodeIdentityAgentId) {
        if (address(identityRegistry) == address(0)) revert InvalidAddress();
        if (!identityRegistry.agentExists(operatorAgentId)) revert InvalidAgentId();
        if (identityRegistry.ownerOf(operatorAgentId) != msg.sender) revert NotAgentOwner();

        bool usedOperatorAgentFallback;
        (nodeIdentityAgentId, usedOperatorAgentFallback) =
            _registerNodeIdentityWithFallback(operatorAgentId, nodeIdentityTokenURI, nodeIdentityMetadata);

        if (_nodeIdsByIdentityAgent[nodeIdentityAgentId] != bytes32(0)) {
            revert IdentityAgentAlreadyLinked(nodeIdentityAgentId);
        }

        nodeId = _registerNodeInternal(stakingToken, stakeAmount, rewardToken, rpcUrl, region, operatorAgentId);

        agentNodes[operatorAgentId].push(nodeId);
        _nodeIdentityAgentIds[nodeId] = nodeIdentityAgentId;
        _nodeIdsByIdentityAgent[nodeIdentityAgentId] = nodeId;

        emit NodeIdentityLinked(nodeId, nodeIdentityAgentId, operatorAgentId, msg.sender);
        if (usedOperatorAgentFallback) {
            emit NodeIdentityFallbackUsed(nodeId, operatorAgentId, msg.sender);
        }
    }

    function increaseStake(bytes32 nodeId, uint256 amount) external whenNotPaused nonReentrant {
        NodeStake storage node = nodes[nodeId];

        if (node.operator == address(0)) revert NodeNotFound(nodeId);
        if (node.operator != msg.sender) revert Unauthorized();
        if (!node.isActive) revert NodeNotActive();
        if (node.isSlashed) revert NodeAlreadySlashed();
        if (amount == 0) revert ZeroStake();
        if (!tokenRegistry.isSupported(node.stakedToken)) revert TokenNotRegistered(node.stakedToken);
        if (!paymasterFactory.isDeployed(node.stakedToken)) revert NoPaymasterForToken(node.stakedToken);

        uint256 addedStakeUSD = _calculateStakeValueUSD(node.stakedToken, amount);

        _enforceOwnershipCap(msg.sender, addedStakeUSD);

        IERC20(node.stakedToken).safeTransferFrom(msg.sender, address(this), amount);

        node.stakedAmount += amount;
        node.stakedValueUSD += addedStakeUSD;
        operatorStats[msg.sender].totalStakedUSD += addedStakeUSD;
        tokenDistribution[node.stakedToken].totalStaked += amount;
        tokenDistribution[node.stakedToken].totalStakedUSD += addedStakeUSD;
        totalStakedUSD += addedStakeUSD;

        emit NodeStakeIncreased(nodeId, msg.sender, amount, node.stakedAmount);
    }

    function revalueNode(bytes32 nodeId)
        external
        whenNotPaused
        returns (uint256 previousStakedValueUSD, uint256 newStakedValueUSD)
    {
        NodeStake storage node = nodes[nodeId];

        if (node.operator == address(0)) revert NodeNotFound(nodeId);
        if (!node.isActive) revert NodeNotActive();
        if (node.isSlashed) revert NodeAlreadySlashed();

        return _revalueActiveNode(nodeId);
    }

    function revalueNodes(bytes32[] calldata nodeIds) external whenNotPaused returns (uint256 updatedCount) {
        uint256 length = nodeIds.length;
        for (uint256 i = 0; i < length; i++) {
            bytes32 nodeId = nodeIds[i];
            NodeStake storage node = nodes[nodeId];

            if (node.operator == address(0) || !node.isActive || node.isSlashed) {
                continue;
            }

            _revalueActiveNode(nodeId);
            updatedCount++;
        }
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

    function setBootstrapOwnershipCapConfig(bool enabled, uint256 nodeThreshold) external onlyOwner {
        bootstrapOwnershipCapExemptionEnabled = enabled;
        bootstrapOwnershipCapExemptionNodeThreshold = nodeThreshold;

        emit BootstrapOwnershipCapConfigUpdated(enabled, nodeThreshold);
    }

    function getNodeServicesHash(bytes32 nodeId) external view returns (bytes32) {
        return nodeServicesHash[nodeId];
    }

    function getNodeMetadataURI(bytes32 nodeId) external view returns (string memory) {
        return _nodeMetadataURI[nodeId];
    }

    function getNodeIdentityAgentId(bytes32 nodeId) external view returns (uint256 nodeIdentityAgentId) {
        return _nodeIdentityAgentIds[nodeId];
    }

    function getNodeIdByIdentityAgent(uint256 nodeIdentityAgentId) external view returns (bytes32 nodeId) {
        return _nodeIdsByIdentityAgent[nodeIdentityAgentId];
    }

    function getCurrentStakeValueUSD(bytes32 nodeId) external view returns (uint256 currentStakeValueUSD) {
        NodeStake storage node = nodes[nodeId];

        if (node.operator == address(0)) revert NodeNotFound(nodeId);
        return _calculateStakeValueUSD(node.stakedToken, node.stakedAmount);
    }

    function _enforceOwnershipCap(address operator, uint256 additionalStakeUSD) internal view override {
        if (bootstrapOwnershipCapExemptionEnabled && allNodeIds.length < bootstrapOwnershipCapExemptionNodeThreshold) {
            return;
        }

        super._enforceOwnershipCap(operator, additionalStakeUSD);
    }

    function _revalueActiveNode(bytes32 nodeId)
        internal
        returns (uint256 previousStakedValueUSD, uint256 newStakedValueUSD)
    {
        NodeStake storage node = nodes[nodeId];

        previousStakedValueUSD = node.stakedValueUSD;
        newStakedValueUSD = _calculateStakeValueUSD(node.stakedToken, node.stakedAmount);

        if (newStakedValueUSD > previousStakedValueUSD) {
            uint256 increase = newStakedValueUSD - previousStakedValueUSD;
            operatorStats[node.operator].totalStakedUSD += increase;
            tokenDistribution[node.stakedToken].totalStakedUSD += increase;
            totalStakedUSD += increase;
        } else if (previousStakedValueUSD > newStakedValueUSD) {
            uint256 decrease = previousStakedValueUSD - newStakedValueUSD;
            operatorStats[node.operator].totalStakedUSD -= decrease;
            tokenDistribution[node.stakedToken].totalStakedUSD -= decrease;
            totalStakedUSD -= decrease;
        }

        node.stakedValueUSD = newStakedValueUSD;

        emit NodeStakeRevalued(nodeId, node.operator, node.stakedToken, previousStakedValueUSD, newStakedValueUSD);
    }

    function _calculateStakeValueUSD(address stakingToken, uint256 stakeAmount) internal view returns (uint256) {
        (uint256 tokenPrice,) = priceOracle.getPrice(stakingToken);
        if (tokenPrice == 0) revert("Invalid token price");
        return (stakeAmount * tokenPrice) / 1e18;
    }

    function _registerNodeIdentityWithFallback(
        uint256 operatorAgentId,
        string calldata nodeIdentityTokenURI,
        IIdentityRegistry.MetadataEntry[] calldata nodeIdentityMetadata
    ) internal returns (uint256 nodeIdentityAgentId, bool usedOperatorAgentFallback) {
        // Compatibility path for legacy IdentityRegistry deployments that do not support registerFor(...).
        (bool success, bytes memory returnData) = address(identityRegistry).call(
            abi.encodeWithSelector(
                IIdentityRegistry.registerFor.selector, msg.sender, nodeIdentityTokenURI, nodeIdentityMetadata
            )
        );

        if (success && returnData.length >= 32) {
            nodeIdentityAgentId = abi.decode(returnData, (uint256));
            return (nodeIdentityAgentId, false);
        }

        return (operatorAgentId, true);
    }

    function supportsAtomicNodeIdentityRegistration() external pure returns (bool) {
        return true;
    }
}
