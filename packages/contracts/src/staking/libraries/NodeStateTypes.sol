// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

library NodeStateTypes {
    struct NodeState {
        bytes32 nodeId;
        address operator;
        address stakedToken;
        uint256 stakedAmount;
        uint256 stakedValueUSD;
        address rewardToken;
        string rpcUrl;
        uint8 region;
        uint256 registrationTime;
        uint256 lastClaimTime;
        uint256 totalRewardsClaimedUSD;
        uint256 operatorAgentId;
        bool isActive;
        bool isSlashed;
        bool upgradeLocked;
        uint16 stateVersion;
        bytes32 servicesHash;
        string metadataURI;
    }

    struct NodeStateInput {
        address operator;
        address stakedToken;
        uint256 stakedAmount;
        uint256 stakedValueUSD;
        address rewardToken;
        string rpcUrl;
        uint8 region;
        uint256 operatorAgentId;
        uint16 stateVersion;
        bytes32 servicesHash;
        string metadataURI;
    }

    struct OperatorStats {
        uint256 totalNodesActive;
        uint256 totalStakedUSD;
        uint256 lifetimeRewardsUSD;
    }

    struct TokenDistribution {
        uint256 totalStaked;
        uint256 totalStakedUSD;
        uint256 nodeCount;
    }

    struct MigrationCursor {
        uint16 fromVersion;
        uint16 targetVersion;
        uint256 nextStep;
        bool active;
        bytes32 contextHash;
    }

    struct MigrationPatch {
        bool updateRpcUrl;
        string rpcUrl;
        bool updateRegion;
        uint8 region;
        bool updateServicesHash;
        bytes32 servicesHash;
        bool updateMetadataURI;
        string metadataURI;
        bool updateStakedValueUSD;
        uint256 stakedValueUSD;
    }
}
