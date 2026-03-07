// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IIdentityRegistry} from "../registry/interfaces/IIdentityRegistry.sol";
import {INodeStakingManagerV2} from "./INodeStakingManagerV2.sol";
import {INodeStakingManagerV2Strict} from "./INodeStakingManagerV2Strict.sol";
import {NodeStakingManagerV2Atomic} from "./NodeStakingManagerV2Atomic.sol";
import {NodeStakingManagerV2} from "./NodeStakingManagerV2.sol";

/**
 * @title NodeStakingManagerV2Strict
 * @notice Strict atomic node registration with deterministic node IDs and mandatory IPFS metadata.
 * @dev Removes all fallback identity behavior. Registrations either mint a real node identity or revert.
 */
contract NodeStakingManagerV2Strict is NodeStakingManagerV2Atomic, INodeStakingManagerV2Strict {
    mapping(address => uint256) private _nextOperatorNonces;

    error StrictProfileRegistrationRequired();
    error InvalidMetadataURI(string metadataURI);
    error InvalidServicesHash();
    error RegistrationNonceMismatch(uint256 expected, uint256 provided);
    error OperatorAgentNotStaked(uint256 operatorAgentId);
    error OperatorAgentIneligible(uint256 operatorAgentId);

    constructor(
        address _tokenRegistry,
        address _paymasterFactory,
        address _priceOracle,
        address _performanceOracle,
        address initialOwner
    ) NodeStakingManagerV2Atomic(_tokenRegistry, _paymasterFactory, _priceOracle, _performanceOracle, initialOwner) {}

    function registerNodeWithAgentAndIdentity(
        address,
        uint256,
        address,
        string calldata,
        Region,
        uint256,
        string calldata,
        IIdentityRegistry.MetadataEntry[] calldata
    ) external pure override(INodeStakingManagerV2, NodeStakingManagerV2) returns (bytes32, uint256) {
        revert StrictProfileRegistrationRequired();
    }

    function previewNextNodeId(address operator, uint256 operatorAgentId, string calldata rpcUrl)
        external
        view
        returns (bytes32 nodeId)
    {
        return _deriveDeterministicNodeId(operator, operatorAgentId, rpcUrl, _nextOperatorNonces[operator]);
    }

    function getNextOperatorNonce(address operator) external view returns (uint256 nonce) {
        return _nextOperatorNonces[operator];
    }

    function registerNodeWithAgentIdentityAndProfile(
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        Region region,
        uint256 operatorAgentId,
        uint256 nonce,
        bytes32 servicesHash,
        string calldata metadataURI,
        string calldata nodeIdentityTokenURI,
        IIdentityRegistry.MetadataEntry[] calldata nodeIdentityMetadata
    ) external whenNotPaused returns (bytes32 nodeId, uint256 nodeIdentityAgentId) {
        if (address(identityRegistry) == address(0)) revert InvalidAddress();
        if (bytes(rpcUrl).length == 0) revert InvalidRpcUrl();
        if (servicesHash == bytes32(0)) revert InvalidServicesHash();
        if (!_isIpfsUri(metadataURI)) revert InvalidMetadataURI(metadataURI);

        _validateOperatorAgent(operatorAgentId);

        uint256 expectedNonce = _nextOperatorNonces[msg.sender];
        if (nonce != expectedNonce) {
            revert RegistrationNonceMismatch(expectedNonce, nonce);
        }

        nodeId = _deriveDeterministicNodeId(msg.sender, operatorAgentId, rpcUrl, nonce);
        nodeIdentityAgentId = identityRegistry.registerFor(msg.sender, nodeIdentityTokenURI, nodeIdentityMetadata);

        if (_nodeIdsByIdentityAgent[nodeIdentityAgentId] != bytes32(0)) {
            revert IdentityAgentAlreadyLinked(nodeIdentityAgentId);
        }

        _registerNodeInternalWithResolvedNodeId(
            nodeId, msg.sender, stakingToken, stakeAmount, rewardToken, rpcUrl, region, operatorAgentId
        );

        _nextOperatorNonces[msg.sender] = expectedNonce + 1;
        agentNodes[operatorAgentId].push(nodeId);
        _nodeIdentityAgentIds[nodeId] = nodeIdentityAgentId;
        _nodeIdsByIdentityAgent[nodeIdentityAgentId] = nodeId;
        nodeServicesHash[nodeId] = servicesHash;
        _nodeMetadataURI[nodeId] = metadataURI;

        emit NodeIdentityLinked(nodeId, nodeIdentityAgentId, operatorAgentId, msg.sender);
        emit NodeServicesUpdated(nodeId, msg.sender, servicesHash);
        emit NodeMetadataURIUpdated(nodeId, msg.sender, metadataURI);
        emit NodeRegistrationNonceConsumed(msg.sender, operatorAgentId, nonce, nodeId);
    }

    function supportsStrictAtomicProfileRegistration() external pure returns (bool) {
        return true;
    }

    function _validateOperatorAgent(uint256 operatorAgentId) internal view {
        if (!identityRegistry.agentExists(operatorAgentId)) revert InvalidAgentId();
        if (identityRegistry.ownerOf(operatorAgentId) != msg.sender) revert NotAgentOwner();

        (bool ok, bytes memory data) =
            address(identityRegistry).staticcall(abi.encodeWithSignature("agents(uint256)", operatorAgentId));
        if (!ok || data.length == 0) revert OperatorAgentIneligible(operatorAgentId);

        (
            uint256 storedAgentId,
            address owner,
            uint8 tier,
            address stakedToken,
            uint256 stakedAmount,
            uint256 registeredAt,
            uint256 lastActivityAt,
            bool isBanned,
            bool isSlashed
        ) = abi.decode(data, (uint256, address, uint8, address, uint256, uint256, uint256, bool, bool));
        storedAgentId;
        stakedToken;
        registeredAt;
        lastActivityAt;
        if (owner != msg.sender) revert NotAgentOwner();
        if (tier == 0 || stakedAmount == 0) {
            revert OperatorAgentNotStaked(operatorAgentId);
        }
        if (isBanned || isSlashed) {
            revert OperatorAgentIneligible(operatorAgentId);
        }
    }

    function _deriveDeterministicNodeId(address operator, uint256 operatorAgentId, string calldata rpcUrl, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), operator, operatorAgentId, rpcUrl, nonce));
    }

    function _isIpfsUri(string calldata metadataURI) internal pure returns (bool) {
        bytes memory uriBytes = bytes(metadataURI);
        if (uriBytes.length <= 7) return false;

        bytes memory expectedPrefix = bytes("ipfs://");
        for (uint256 i = 0; i < expectedPrefix.length; i++) {
            if (uriBytes[i] != expectedPrefix[i]) {
                return false;
            }
        }

        return true;
    }
}
