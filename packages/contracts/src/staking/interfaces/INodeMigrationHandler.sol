// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

interface INodeMigrationHandler {
    function getStepCount(bytes32 nodeId, uint16 fromVersion, uint16 targetVersion) external view returns (uint256);

    function runStep(bytes32 nodeId, uint16 fromVersion, uint16 targetVersion, uint256 stepIndex) external;
}
