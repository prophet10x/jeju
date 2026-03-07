// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {INodeStakingManagerV2} from "./INodeStakingManagerV2.sol";
import {IIdentityRegistry} from "../registry/interfaces/IIdentityRegistry.sol";

interface INodeStakingManagerV2Strict is INodeStakingManagerV2 {
    event NodeRegistrationNonceConsumed(
        address indexed operator, uint256 indexed operatorAgentId, uint256 indexed nonce, bytes32 nodeId
    );

    function previewNextNodeId(address operator, uint256 operatorAgentId, string calldata rpcUrl)
        external
        view
        returns (bytes32 nodeId);

    function getNextOperatorNonce(address operator) external view returns (uint256 nonce);

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
    ) external returns (bytes32 nodeId, uint256 nodeIdentityAgentId);

    function supportsStrictAtomicProfileRegistration() external pure returns (bool);
}
