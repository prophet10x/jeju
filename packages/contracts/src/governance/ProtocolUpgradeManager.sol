// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IUpgradeValidationRegistry {
    function isValidationPassed(bytes32 changeId) external view returns (bool);
}

/**
 * @title ProtocolUpgradeManager
 * @notice DAO-owned mixed-mode upgrade executor for Jeju protocol contracts
 * @dev Supports:
 *      - UUPS proxy upgrades
 *      - Transparent proxy upgrades (via ProxyAdmin-like admin contract)
 *      - Direct governance calls
 *      - Redeploy-and-switch pointer updates
 *
 *      Designed to be owned by GovernanceTimelock.
 */
contract ProtocolUpgradeManager is Ownable {
    enum UpgradeKind {
        NONE,
        UUPS_PROXY,
        TRANSPARENT_PROXY,
        DIRECT_CALL,
        REDEPLOY_AND_SWITCH
    }

    struct ManagedContract {
        address target;
        address admin;
        UpgradeKind kind;
        bool active;
    }

    address public validationRegistry;
    bool public requireValidation;

    mapping(bytes32 => ManagedContract) public managedContracts;

    event ValidationRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ValidationRequirementUpdated(bool required);
    event ManagedContractConfigured(
        bytes32 indexed contractId, address indexed target, address indexed admin, UpgradeKind kind, bool active
    );
    event ManagedContractStatusUpdated(bytes32 indexed contractId, bool active);
    event UUPSUpgraded(bytes32 indexed changeId, bytes32 indexed contractId, address indexed newImplementation);
    event TransparentUpgraded(bytes32 indexed changeId, bytes32 indexed contractId, address indexed newImplementation);
    event GovernanceCallExecuted(bytes32 indexed changeId, bytes32 indexed contractId, uint256 value, bytes data);
    event ManagedAddressSwitched(
        bytes32 indexed changeId, bytes32 indexed contractId, address indexed oldTarget, address newTarget
    );

    error InvalidAddress();
    error InvalidConfig();
    error UnknownContract();
    error InactiveContract();
    error InvalidUpgradeKind();
    error ValidationNotPassed();
    error ExecutionFailed();

    constructor(address initialOwner, address initialValidationRegistry, bool initialRequireValidation)
        Ownable(initialOwner)
    {
        if (initialRequireValidation && initialValidationRegistry == address(0)) revert InvalidConfig();
        validationRegistry = initialValidationRegistry;
        requireValidation = initialRequireValidation;
    }

    function setValidationRegistry(address newValidationRegistry) external onlyOwner {
        if (requireValidation && newValidationRegistry == address(0)) revert InvalidAddress();
        address oldRegistry = validationRegistry;
        validationRegistry = newValidationRegistry;
        emit ValidationRegistryUpdated(oldRegistry, newValidationRegistry);
    }

    function setValidationRequirement(bool required) external onlyOwner {
        if (required && validationRegistry == address(0)) revert InvalidConfig();
        requireValidation = required;
        emit ValidationRequirementUpdated(required);
    }

    function configureManagedContract(
        bytes32 contractId,
        address target,
        UpgradeKind kind,
        address admin,
        bool active
    ) external onlyOwner {
        if (contractId == bytes32(0) || target == address(0) || kind == UpgradeKind.NONE) revert InvalidConfig();
        if (kind == UpgradeKind.TRANSPARENT_PROXY && admin == address(0)) revert InvalidAddress();
        if (kind != UpgradeKind.TRANSPARENT_PROXY && admin != address(0)) revert InvalidConfig();

        managedContracts[contractId] = ManagedContract({target: target, admin: admin, kind: kind, active: active});

        emit ManagedContractConfigured(contractId, target, admin, kind, active);
    }

    function setManagedContractStatus(bytes32 contractId, bool active) external onlyOwner {
        ManagedContract storage managed = managedContracts[contractId];
        if (managed.target == address(0)) revert UnknownContract();
        managed.active = active;
        emit ManagedContractStatusUpdated(contractId, active);
    }

    function upgradeUUPS(bytes32 changeId, bytes32 contractId, address newImplementation, bytes calldata data)
        external
        onlyOwner
    {
        if (newImplementation == address(0)) revert InvalidAddress();
        _requireValidation(changeId);

        ManagedContract memory managed = _requireManaged(contractId, UpgradeKind.UUPS_PROXY);

        bytes memory payload = data.length == 0
            ? abi.encodeWithSignature("upgradeTo(address)", newImplementation)
            : abi.encodeWithSignature("upgradeToAndCall(address,bytes)", newImplementation, data);

        _callOrRevert(managed.target, 0, payload);

        emit UUPSUpgraded(changeId, contractId, newImplementation);
    }

    function upgradeTransparent(bytes32 changeId, bytes32 contractId, address newImplementation, bytes calldata data)
        external
        onlyOwner
    {
        if (newImplementation == address(0)) revert InvalidAddress();
        _requireValidation(changeId);

        ManagedContract memory managed = _requireManaged(contractId, UpgradeKind.TRANSPARENT_PROXY);

        bytes memory payload =
            abi.encodeWithSignature("upgradeAndCall(address,address,bytes)", managed.target, newImplementation, data);

        _callOrRevert(managed.admin, 0, payload);

        emit TransparentUpgraded(changeId, contractId, newImplementation);
    }

    function executeGovernanceCall(bytes32 changeId, bytes32 contractId, uint256 value, bytes calldata data)
        external
        payable
        onlyOwner
    {
        _requireValidation(changeId);

        ManagedContract memory managed = _requireManaged(contractId, UpgradeKind.DIRECT_CALL);
        if (msg.value != value) revert InvalidConfig();

        _callOrRevert(managed.target, value, data);

        emit GovernanceCallExecuted(changeId, contractId, value, data);
    }

    function switchManagedAddress(bytes32 changeId, bytes32 contractId, address newTarget) external onlyOwner {
        if (newTarget == address(0)) revert InvalidAddress();
        _requireValidation(changeId);

        ManagedContract storage managed = managedContracts[contractId];
        if (managed.target == address(0)) revert UnknownContract();
        if (!managed.active) revert InactiveContract();
        if (managed.kind != UpgradeKind.REDEPLOY_AND_SWITCH) revert InvalidUpgradeKind();

        address oldTarget = managed.target;
        managed.target = newTarget;

        emit ManagedAddressSwitched(changeId, contractId, oldTarget, newTarget);
    }

    function _requireManaged(bytes32 contractId, UpgradeKind expectedKind) internal view returns (ManagedContract memory) {
        ManagedContract memory managed = managedContracts[contractId];
        if (managed.target == address(0)) revert UnknownContract();
        if (!managed.active) revert InactiveContract();
        if (managed.kind != expectedKind) revert InvalidUpgradeKind();
        return managed;
    }

    function _requireValidation(bytes32 changeId) internal view {
        if (!requireValidation) return;
        if (changeId == bytes32(0) || validationRegistry == address(0)) revert ValidationNotPassed();
        if (!IUpgradeValidationRegistry(validationRegistry).isValidationPassed(changeId)) revert ValidationNotPassed();
    }

    function _callOrRevert(address target, uint256 value, bytes memory data) internal {
        (bool success, bytes memory returnData) = target.call{value: value}(data);
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            revert ExecutionFailed();
        }
    }

    receive() external payable {}
}
