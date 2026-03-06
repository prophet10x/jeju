// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {NodeStakingManagerV2} from "./NodeStakingManagerV2.sol";
import {NodeStakingManager} from "./NodeStakingManager.sol";
import {INodeStakingManager} from "./INodeStakingManager.sol";

/**
 * @title NodeStakingManagerV2Atomic
 * @notice Atomic-only registration variant of NodeStakingManagerV2.
 * @dev New node registration is only allowed through registerNodeWithAgentAndIdentity.
 */
contract NodeStakingManagerV2Atomic is NodeStakingManagerV2 {
    error NonAtomicRegistrationDisabled();

    constructor(
        address _tokenRegistry,
        address _paymasterFactory,
        address _priceOracle,
        address _performanceOracle,
        address initialOwner
    ) NodeStakingManagerV2(_tokenRegistry, _paymasterFactory, _priceOracle, _performanceOracle, initialOwner) {}

    function registerNode(
        address,
        uint256,
        address,
        string calldata,
        Region
    ) external pure override(NodeStakingManager, INodeStakingManager) returns (bytes32) {
        revert NonAtomicRegistrationDisabled();
    }

    function registerNodeWithAgent(
        address,
        uint256,
        address,
        string calldata,
        Region,
        uint256
    ) external pure override(NodeStakingManager) returns (bytes32) {
        revert NonAtomicRegistrationDisabled();
    }
}
