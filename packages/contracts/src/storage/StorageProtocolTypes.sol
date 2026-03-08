// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

library StorageProtocolTypes {
    enum StorageAccessClass {
        SYSTEM_PUBLIC,
        PRIVATE_OWNER,
        MANAGED_EXECUTION
    }

    enum ReservationKind {
        NONE,
        PAID,
        PROVIDER_SELF_USE
    }

    enum StorageRecordState {
        NONE,
        RESERVED,
        ACTIVE,
        REPAIR_REQUIRED,
        DELETED
    }

    struct ProviderQuote {
        uint256 priceUsdPerGiBDay;
        bool acceptsJeju;
        bool acceptsEth;
        uint16 systemReserveBps;
        uint16 slashCoverageBps;
    }

    struct ProviderAccount {
        address owner;
        uint256 stakeWei;
        uint256 declaredCapacityBytes;
        uint256 reservedCapacityBytes;
        uint256 selfUseCreditsLockedBytes;
        uint256 slashCoverageBalanceWei;
        string metadataURI;
        ProviderQuote quote;
        bool active;
    }

    struct StorageRecord {
        bytes32 contentId;
        StorageAccessClass accessClass;
        ReservationKind reservationKind;
        StorageRecordState state;
        address owner;
        address paymentAsset;
        address selfUseCreditProvider;
        bytes32 manifestHash;
        bytes32 plaintextRoot;
        bytes32 replicaSetHash;
        string ciphertextManifestUri;
        uint16 minReplicas;
        uint16 targetReplicas;
        uint32 keyEpoch;
        uint32 auditChunkSize;
        uint64 createdAt;
        uint64 updatedAt;
        uint64 lastReplicaRefreshAt;
        uint64 repairDeadline;
        uint256 sizeBytes;
        uint256 paymentUsdQuote;
        uint256 paymentAssetAmount;
        uint256 repairBountyUsd;
        uint256 slashCoverageReservedUsd;
    }

    struct StorageRegistrationInput {
        StorageAccessClass accessClass;
        address owner;
        bytes32 manifestHash;
        bytes32 plaintextRoot;
        string ciphertextManifestUri;
        uint16 minReplicas;
        uint16 targetReplicas;
        uint32 auditChunkSize;
        uint256 sizeBytes;
        uint256 paymentUsdQuote;
        uint256 repairBountyUsd;
    }

    struct RepairTicket {
        bool active;
        bytes32 contentId;
        address repairer;
        bytes32 nextManifestHash;
        bytes32 nextPlaintextRoot;
        bytes32 nextReplicaSetHash;
        string nextCiphertextManifestUri;
        uint64 openedAt;
        uint64 deadline;
        uint64 lastUpdatedAt;
        uint256 requestedPayoutUsd;
        uint256 rekeyNonce;
        bool rotateKeyEpoch;
    }
}
