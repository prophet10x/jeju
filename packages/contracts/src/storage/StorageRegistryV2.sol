// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StorageEscrowV2} from "./StorageEscrowV2.sol";
import {StorageProtocolTypes} from "./StorageProtocolTypes.sol";
import {StorageProviderRegistryV2} from "./StorageProviderRegistryV2.sol";

contract StorageRegistryV2 is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant REPLICA_SETTER_ROLE = keccak256("REPLICA_SETTER_ROLE");
    bytes32 public constant RECOVERY_MANAGER_ROLE = keccak256("RECOVERY_MANAGER_ROLE");

    uint16 public constant MIN_REPLICA_FLOOR = 4;
    uint16 public constant MAX_REPLICA_CEILING = 10;
    uint32 public constant DEFAULT_AUDIT_CHUNK_SIZE = 1024 * 1024;

    StorageProviderRegistryV2 public providerRegistry;
    StorageEscrowV2 public escrow;

    mapping(bytes32 => StorageProtocolTypes.StorageRecord) private _records;
    mapping(bytes32 => address[]) private _replicaProviders;
    mapping(address => bytes32[]) private _ownerContentIds;
    bytes32[] private _allContentIds;

    uint256 private _nonce;

    event StorageReserved(
        bytes32 indexed contentId,
        address indexed owner,
        StorageProtocolTypes.ReservationKind reservationKind,
        StorageProtocolTypes.StorageAccessClass accessClass,
        uint256 sizeBytes,
        uint16 minReplicas,
        uint16 targetReplicas
    );
    event StorageActivated(bytes32 indexed contentId, bytes32 indexed replicaSetHash);
    event ReplicaProvidersUpdated(bytes32 indexed contentId, bytes32 indexed replicaSetHash, uint256 providerCount);
    event StorageRepairRequired(bytes32 indexed contentId, uint64 repairDeadline, uint256 repairBountyUsd);
    event StorageRepairApplied(bytes32 indexed contentId, bytes32 indexed replicaSetHash, uint32 keyEpoch);
    event StorageDeleted(bytes32 indexed contentId);
    event ProviderRegistryUpdated(address indexed previousRegistry, address indexed newRegistry);
    event EscrowUpdated(address indexed previousEscrow, address indexed newEscrow);

    error InvalidAddress();
    error InvalidOwner();
    error InvalidSize();
    error InvalidReplicaPolicy(uint16 minReplicas, uint16 targetReplicas);
    error InvalidState(bytes32 contentId, StorageProtocolTypes.StorageRecordState expected, StorageProtocolTypes.StorageRecordState actual);
    error RecordNotFound(bytes32 contentId);
    error ReplicaProvidersMissing();
    error PaymentRequired();
    error SelfUseProviderRequired();

    constructor(address admin, address providerRegistryAddress, address escrowAddress) {
        if (admin == address(0) || providerRegistryAddress == address(0) || escrowAddress == address(0)) {
            revert InvalidAddress();
        }

        providerRegistry = StorageProviderRegistryV2(providerRegistryAddress);
        escrow = StorageEscrowV2(escrowAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        _grantRole(REPLICA_SETTER_ROLE, admin);
        _grantRole(RECOVERY_MANAGER_ROLE, admin);
    }

    function setProviderRegistry(address newProviderRegistry) external onlyRole(GOVERNANCE_ROLE) {
        if (newProviderRegistry == address(0)) revert InvalidAddress();
        address previous = address(providerRegistry);
        providerRegistry = StorageProviderRegistryV2(newProviderRegistry);
        emit ProviderRegistryUpdated(previous, newProviderRegistry);
    }

    function setEscrow(address newEscrow) external onlyRole(GOVERNANCE_ROLE) {
        if (newEscrow == address(0)) revert InvalidAddress();
        address previous = address(escrow);
        escrow = StorageEscrowV2(newEscrow);
        emit EscrowUpdated(previous, newEscrow);
    }

    function reservePaidStorage(
        StorageProtocolTypes.StorageRegistrationInput calldata input,
        address[] calldata replicaProviders,
        address paymentAsset,
        uint256 paymentAmount
    ) external payable onlyRole(REGISTRAR_ROLE) whenNotPaused nonReentrant returns (bytes32 contentId) {
        _validateRegistrationInput(input, replicaProviders);
        if (paymentAmount == 0 || input.paymentUsdQuote == 0) revert PaymentRequired();

        contentId = _createStorageRecord(input, StorageProtocolTypes.ReservationKind.PAID, paymentAsset, paymentAmount, address(0));
        _setReplicaProviders(contentId, replicaProviders);
        _lockReplicaProviderCapacity(replicaProviders, input.sizeBytes);
        _assertSettlementAssets(replicaProviders, paymentAsset);
        escrow.lockReservationPayment{value: paymentAsset == address(0) ? msg.value : 0}(
            contentId, input.owner, paymentAsset, paymentAmount, input.paymentUsdQuote
        );
    }

    function reserveProviderSelfUse(
        StorageProtocolTypes.StorageRegistrationInput calldata input,
        address[] calldata replicaProviders,
        address selfUseCreditProvider
    ) external onlyRole(REGISTRAR_ROLE) whenNotPaused nonReentrant returns (bytes32 contentId) {
        _validateRegistrationInput(input, replicaProviders);
        if (selfUseCreditProvider == address(0)) revert SelfUseProviderRequired();

        contentId = _createStorageRecord(
            input, StorageProtocolTypes.ReservationKind.PROVIDER_SELF_USE, address(0), 0, selfUseCreditProvider
        );
        _setReplicaProviders(contentId, replicaProviders);
        _lockReplicaProviderCapacity(replicaProviders, input.sizeBytes);
        providerRegistry.lockCapacity(selfUseCreditProvider, input.sizeBytes * uint256(input.targetReplicas), true);
    }

    function activateReservedContent(bytes32 contentId, bytes32 replicaSetHash)
        external
        onlyRole(REPLICA_SETTER_ROLE)
        whenNotPaused
    {
        StorageProtocolTypes.StorageRecord storage record = _getRecord(contentId);
        if (record.state != StorageProtocolTypes.StorageRecordState.RESERVED) {
            revert InvalidState(contentId, StorageProtocolTypes.StorageRecordState.RESERVED, record.state);
        }

        record.state = StorageProtocolTypes.StorageRecordState.ACTIVE;
        record.replicaSetHash = replicaSetHash;
        record.lastReplicaRefreshAt = uint64(block.timestamp);
        record.updatedAt = uint64(block.timestamp);

        emit StorageActivated(contentId, replicaSetHash);
    }

    function updateReplicaProviders(bytes32 contentId, address[] calldata replicaProviders, bytes32 replicaSetHash)
        external
        onlyRole(REPLICA_SETTER_ROLE)
        whenNotPaused
    {
        StorageProtocolTypes.StorageRecord storage record = _getRecord(contentId);
        if (
            record.state != StorageProtocolTypes.StorageRecordState.RESERVED
                && record.state != StorageProtocolTypes.StorageRecordState.ACTIVE
                && record.state != StorageProtocolTypes.StorageRecordState.REPAIR_REQUIRED
        ) {
            revert InvalidState(contentId, StorageProtocolTypes.StorageRecordState.ACTIVE, record.state);
        }

        _setReplicaProviders(contentId, replicaProviders);
        record.replicaSetHash = replicaSetHash;
        record.lastReplicaRefreshAt = uint64(block.timestamp);
        record.updatedAt = uint64(block.timestamp);

        emit ReplicaProvidersUpdated(contentId, replicaSetHash, replicaProviders.length);
    }

    function markRepairRequired(bytes32 contentId, uint64 repairDeadline, uint256 repairBountyUsd)
        external
        onlyRole(RECOVERY_MANAGER_ROLE)
        whenNotPaused
    {
        StorageProtocolTypes.StorageRecord storage record = _getRecord(contentId);
        record.state = StorageProtocolTypes.StorageRecordState.REPAIR_REQUIRED;
        record.repairDeadline = repairDeadline;
        record.repairBountyUsd = repairBountyUsd;
        record.updatedAt = uint64(block.timestamp);

        emit StorageRepairRequired(contentId, repairDeadline, repairBountyUsd);
    }

    function applyRepair(
        bytes32 contentId,
        bytes32 nextManifestHash,
        bytes32 nextPlaintextRoot,
        string calldata nextCiphertextManifestUri,
        address[] calldata nextReplicaProviders,
        bytes32 nextReplicaSetHash,
        bool rotateKeyEpoch
    ) external onlyRole(RECOVERY_MANAGER_ROLE) whenNotPaused {
        StorageProtocolTypes.StorageRecord storage record = _getRecord(contentId);
        if (record.state != StorageProtocolTypes.StorageRecordState.REPAIR_REQUIRED) {
            revert InvalidState(contentId, StorageProtocolTypes.StorageRecordState.REPAIR_REQUIRED, record.state);
        }

        record.manifestHash = nextManifestHash;
        record.plaintextRoot = nextPlaintextRoot;
        record.ciphertextManifestUri = nextCiphertextManifestUri;
        record.replicaSetHash = nextReplicaSetHash;
        record.state = StorageProtocolTypes.StorageRecordState.ACTIVE;
        record.lastReplicaRefreshAt = uint64(block.timestamp);
        record.updatedAt = uint64(block.timestamp);
        record.repairDeadline = 0;
        if (rotateKeyEpoch) {
            record.keyEpoch += 1;
        }

        _setReplicaProviders(contentId, nextReplicaProviders);
        emit StorageRepairApplied(contentId, nextReplicaSetHash, record.keyEpoch);
    }

    function deleteContent(bytes32 contentId) external onlyRole(REGISTRAR_ROLE) nonReentrant {
        StorageProtocolTypes.StorageRecord storage record = _getRecord(contentId);
        if (record.state == StorageProtocolTypes.StorageRecordState.DELETED) {
            revert InvalidState(contentId, StorageProtocolTypes.StorageRecordState.ACTIVE, record.state);
        }

        address[] storage providers = _replicaProviders[contentId];
        for (uint256 i = 0; i < providers.length; i++) {
            providerRegistry.unlockCapacity(providers[i], record.sizeBytes, false);
        }

        if (record.reservationKind == StorageProtocolTypes.ReservationKind.PROVIDER_SELF_USE) {
            providerRegistry.unlockCapacity(
                record.selfUseCreditProvider, record.sizeBytes * uint256(record.targetReplicas), true
            );
        }

        record.state = StorageProtocolTypes.StorageRecordState.DELETED;
        record.updatedAt = uint64(block.timestamp);
        emit StorageDeleted(contentId);
    }

    function getRecord(bytes32 contentId) external view returns (StorageProtocolTypes.StorageRecord memory) {
        return _getRecord(contentId);
    }

    function getReplicaProviders(bytes32 contentId) external view returns (address[] memory) {
        return _replicaProviders[contentId];
    }

    function listOwnerContent(address owner) external view returns (bytes32[] memory) {
        return _ownerContentIds[owner];
    }

    function listContentIds() external view returns (bytes32[] memory) {
        return _allContentIds;
    }

    function _createStorageRecord(
        StorageProtocolTypes.StorageRegistrationInput calldata input,
        StorageProtocolTypes.ReservationKind reservationKind,
        address paymentAsset,
        uint256 paymentAmount,
        address selfUseCreditProvider
    ) internal returns (bytes32 contentId) {
        contentId = keccak256(
            abi.encodePacked(input.owner, input.manifestHash, input.plaintextRoot, input.ciphertextManifestUri, _nonce++)
        );

        _records[contentId] = StorageProtocolTypes.StorageRecord({
            contentId: contentId,
            accessClass: input.accessClass,
            reservationKind: reservationKind,
            state: StorageProtocolTypes.StorageRecordState.RESERVED,
            owner: input.owner,
            paymentAsset: paymentAsset,
            selfUseCreditProvider: selfUseCreditProvider,
            manifestHash: input.manifestHash,
            plaintextRoot: input.plaintextRoot,
            replicaSetHash: bytes32(0),
            ciphertextManifestUri: input.ciphertextManifestUri,
            minReplicas: input.minReplicas,
            targetReplicas: input.targetReplicas,
            keyEpoch: 1,
            auditChunkSize: input.auditChunkSize == 0 ? DEFAULT_AUDIT_CHUNK_SIZE : input.auditChunkSize,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            lastReplicaRefreshAt: 0,
            repairDeadline: 0,
            sizeBytes: input.sizeBytes,
            paymentUsdQuote: input.paymentUsdQuote,
            paymentAssetAmount: paymentAmount,
            repairBountyUsd: input.repairBountyUsd,
            slashCoverageReservedUsd: 0
        });

        _ownerContentIds[input.owner].push(contentId);
        _allContentIds.push(contentId);

        emit StorageReserved(
            contentId, input.owner, reservationKind, input.accessClass, input.sizeBytes, input.minReplicas, input.targetReplicas
        );
    }

    function _validateRegistrationInput(
        StorageProtocolTypes.StorageRegistrationInput calldata input,
        address[] calldata replicaProviders
    ) internal pure {
        if (input.owner == address(0)) revert InvalidOwner();
        if (input.sizeBytes == 0) revert InvalidSize();
        if (
            input.minReplicas < MIN_REPLICA_FLOOR || input.targetReplicas < input.minReplicas
                || input.targetReplicas > MAX_REPLICA_CEILING
        ) {
            revert InvalidReplicaPolicy(input.minReplicas, input.targetReplicas);
        }
        if (replicaProviders.length < input.minReplicas) revert ReplicaProvidersMissing();
    }

    function _setReplicaProviders(bytes32 contentId, address[] calldata replicaProviders) internal {
        if (replicaProviders.length == 0) revert ReplicaProvidersMissing();
        delete _replicaProviders[contentId];
        for (uint256 i = 0; i < replicaProviders.length; i++) {
            _replicaProviders[contentId].push(replicaProviders[i]);
        }
    }

    function _lockReplicaProviderCapacity(address[] calldata replicaProviders, uint256 sizeBytes) internal {
        for (uint256 i = 0; i < replicaProviders.length; i++) {
            providerRegistry.lockCapacity(replicaProviders[i], sizeBytes, false);
        }
    }

    function _assertSettlementAssets(address[] calldata replicaProviders, address paymentAsset) internal view {
        for (uint256 i = 0; i < replicaProviders.length; i++) {
            providerRegistry.assertSettlementAssetSupported(replicaProviders[i], paymentAsset);
        }
    }

    function _getRecord(bytes32 contentId) internal view returns (StorageProtocolTypes.StorageRecord storage record) {
        record = _records[contentId];
        if (record.owner == address(0)) revert RecordNotFound(contentId);
    }
}
