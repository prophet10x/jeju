// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {INodeMigrationHandler} from "../interfaces/INodeMigrationHandler.sol";
import {INodeStateRegistry} from "../interfaces/INodeStateRegistry.sol";
import {NodeStateTypes} from "../libraries/NodeStateTypes.sol";

contract NodeMigrationHandlerV3 is AccessControl, INodeMigrationHandler {
    bytes32 public constant HANDLER_ADMIN_ROLE = keccak256("HANDLER_ADMIN_ROLE");

    INodeStateRegistry public immutable registry;
    uint16 public constant TARGET_VERSION = 3;

    mapping(bytes32 => uint256) private _stepCountByNode;
    mapping(bytes32 => mapping(uint256 => bool)) private _hasPatchByNodeAndStep;
    mapping(bytes32 => mapping(uint256 => NodeStateTypes.MigrationPatch)) private _patchByNodeAndStep;

    event NodeMigrationConfigured(bytes32 indexed nodeId, uint256 stepCount);
    event NodeMigrationPatchConfigured(bytes32 indexed nodeId, uint256 indexed stepIndex);

    error InvalidAddress();
    error InvalidVersion(uint16 fromVersion, uint16 targetVersion);
    error InvalidStepCount();
    error NotRegistryCaller();

    constructor(address registryAddress, address admin) {
        if (registryAddress == address(0) || admin == address(0)) revert InvalidAddress();
        registry = INodeStateRegistry(registryAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(HANDLER_ADMIN_ROLE, admin);
    }

    function configureNodeMigration(bytes32 nodeId, uint256 stepCount) external onlyRole(HANDLER_ADMIN_ROLE) {
        if (stepCount == 0) revert InvalidStepCount();
        _stepCountByNode[nodeId] = stepCount;
        emit NodeMigrationConfigured(nodeId, stepCount);
    }

    function configureNodeMigrationPatch(
        bytes32 nodeId,
        uint256 stepIndex,
        NodeStateTypes.MigrationPatch calldata patch
    ) external onlyRole(HANDLER_ADMIN_ROLE) {
        _patchByNodeAndStep[nodeId][stepIndex] = patch;
        _hasPatchByNodeAndStep[nodeId][stepIndex] = true;
        emit NodeMigrationPatchConfigured(nodeId, stepIndex);
    }

    function getStepCount(bytes32 nodeId, uint16 fromVersion, uint16 targetVersion) external view returns (uint256) {
        if (targetVersion != TARGET_VERSION || fromVersion >= targetVersion) {
            revert InvalidVersion(fromVersion, targetVersion);
        }
        uint256 configured = _stepCountByNode[nodeId];
        return configured == 0 ? 1 : configured;
    }

    function runStep(bytes32 nodeId, uint16 fromVersion, uint16 targetVersion, uint256 stepIndex) external {
        if (msg.sender != address(registry)) revert NotRegistryCaller();
        if (targetVersion != TARGET_VERSION || fromVersion >= targetVersion) {
            revert InvalidVersion(fromVersion, targetVersion);
        }

        if (_hasPatchByNodeAndStep[nodeId][stepIndex]) {
            NodeStateTypes.MigrationPatch storage patch = _patchByNodeAndStep[nodeId][stepIndex];
            registry.applyMigrationPatch(nodeId, patch);
        }
    }
}
