// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StorageProtocolTypes} from "./StorageProtocolTypes.sol";
import {StorageRegistryV2} from "./StorageRegistryV2.sol";

contract StorageRecoveryManagerV2 is AccessControl, ReentrancyGuard {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant REPAIR_COORDINATOR_ROLE = keccak256("REPAIR_COORDINATOR_ROLE");

    StorageRegistryV2 public registry;

    mapping(bytes32 => StorageProtocolTypes.RepairTicket) private _repairTickets;

    event RepairOpened(bytes32 indexed contentId, address indexed repairer, uint64 deadline, uint256 requestedPayoutUsd);
    event RepairUpdated(
        bytes32 indexed contentId, address indexed repairer, bytes32 nextReplicaSetHash, bool rotateKeyEpoch, uint256 rekeyNonce
    );
    event RepairSubmitted(bytes32 indexed contentId, address indexed repairer, bytes32 nextReplicaSetHash);
    event RepairCancelled(bytes32 indexed contentId);
    event RegistryUpdated(address indexed previousRegistry, address indexed newRegistry);

    error InvalidAddress();
    error RepairTicketMissing(bytes32 contentId);
    error RepairTicketActive(bytes32 contentId);
    error RepairTicketNotActive(bytes32 contentId);

    constructor(address admin, address registryAddress) {
        if (admin == address(0) || registryAddress == address(0)) revert InvalidAddress();

        registry = StorageRegistryV2(registryAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        _grantRole(REPAIR_COORDINATOR_ROLE, admin);
    }

    function setRegistry(address newRegistry) external onlyRole(GOVERNANCE_ROLE) {
        if (newRegistry == address(0)) revert InvalidAddress();
        address previous = address(registry);
        registry = StorageRegistryV2(newRegistry);
        emit RegistryUpdated(previous, newRegistry);
    }

    function openRepair(bytes32 contentId, uint64 deadline, uint256 requestedPayoutUsd, address repairer)
        external
        onlyRole(REPAIR_COORDINATOR_ROLE)
    {
        StorageProtocolTypes.RepairTicket storage ticket = _repairTickets[contentId];
        if (ticket.active) revert RepairTicketActive(contentId);

        _repairTickets[contentId] = StorageProtocolTypes.RepairTicket({
            active: true,
            contentId: contentId,
            repairer: repairer,
            nextManifestHash: bytes32(0),
            nextPlaintextRoot: bytes32(0),
            nextReplicaSetHash: bytes32(0),
            nextCiphertextManifestUri: "",
            openedAt: uint64(block.timestamp),
            deadline: deadline,
            lastUpdatedAt: uint64(block.timestamp),
            requestedPayoutUsd: requestedPayoutUsd,
            rekeyNonce: 0,
            rotateKeyEpoch: false
        });

        registry.markRepairRequired(contentId, deadline, requestedPayoutUsd);
        emit RepairOpened(contentId, repairer, deadline, requestedPayoutUsd);
    }

    function updateRepairPlan(
        bytes32 contentId,
        bytes32 nextManifestHash,
        bytes32 nextPlaintextRoot,
        string calldata nextCiphertextManifestUri,
        bytes32 nextReplicaSetHash,
        bool rotateKeyEpoch
    ) external onlyRole(REPAIR_COORDINATOR_ROLE) {
        StorageProtocolTypes.RepairTicket storage ticket = _getTicket(contentId);

        ticket.nextManifestHash = nextManifestHash;
        ticket.nextPlaintextRoot = nextPlaintextRoot;
        ticket.nextCiphertextManifestUri = nextCiphertextManifestUri;
        ticket.nextReplicaSetHash = nextReplicaSetHash;
        ticket.rotateKeyEpoch = rotateKeyEpoch;
        ticket.rekeyNonce += 1;
        ticket.lastUpdatedAt = uint64(block.timestamp);

        emit RepairUpdated(contentId, ticket.repairer, nextReplicaSetHash, rotateKeyEpoch, ticket.rekeyNonce);
    }

    function submitRepair(bytes32 contentId, address[] calldata replicaProviders)
        external
        onlyRole(REPAIR_COORDINATOR_ROLE)
        nonReentrant
    {
        StorageProtocolTypes.RepairTicket storage ticket = _getTicket(contentId);

        registry.applyRepair(
            contentId,
            ticket.nextManifestHash,
            ticket.nextPlaintextRoot,
            ticket.nextCiphertextManifestUri,
            replicaProviders,
            ticket.nextReplicaSetHash,
            ticket.rotateKeyEpoch
        );

        ticket.active = false;
        ticket.lastUpdatedAt = uint64(block.timestamp);
        emit RepairSubmitted(contentId, ticket.repairer, ticket.nextReplicaSetHash);
    }

    function cancelRepair(bytes32 contentId) external onlyRole(REPAIR_COORDINATOR_ROLE) {
        StorageProtocolTypes.RepairTicket storage ticket = _getTicket(contentId);
        ticket.active = false;
        ticket.lastUpdatedAt = uint64(block.timestamp);
        emit RepairCancelled(contentId);
    }

    function getRepairTicket(bytes32 contentId) external view returns (StorageProtocolTypes.RepairTicket memory) {
        return _repairTickets[contentId];
    }

    function _getTicket(bytes32 contentId) internal view returns (StorageProtocolTypes.RepairTicket storage ticket) {
        ticket = _repairTickets[contentId];
        if (ticket.contentId == bytes32(0)) revert RepairTicketMissing(contentId);
        if (!ticket.active) revert RepairTicketNotActive(contentId);
    }
}
