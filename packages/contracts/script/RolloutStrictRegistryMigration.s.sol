// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";

interface IStrictIdentityRegistryRollout {
    function setRegistrarAuthorization(address registrar, bool authorized) external;
    function setMetadataReporter(address reporter, bool authorized) external;
}

interface IStrictNodeStakingManagerRollout {
    function setIdentityRegistry(address identityRegistry) external;
    function setRequireAgentRegistration(bool required) external;
    function setSlashAuthority(address slashAuthority) external;
    function setRewardVault(address rewardVault) external;
    function setRewardParameters(address rewardParameters) external;
}

interface INodeStakingFreezeRollout {
    function setMinStakeUSD(uint256 newMinimum) external;
}

/**
 * @title RolloutStrictRegistryMigration
 * @notice Wires the new IdentityRegistry + strict staking manager stack and
 *         optionally freezes the previously active manager for new registrations.
 *
 * Required env:
 *  - PRIVATE_KEY
 *  - STRICT_MANAGER_ADDRESS
 *  - IDENTITY_REGISTRY_ADDRESS
 *
 * Optional env:
 *  - QOS_METADATA_REPORTER_ADDRESS
 *  - SLASH_AUTHORITY_ADDRESS
 *  - REWARD_VAULT_ADDRESS
 *  - REWARD_PARAMETERS_ADDRESS
 *  - OLD_MANAGER_ADDRESS
 *  - AUTHORIZE_REGISTRAR (default true)
 *  - AUTHORIZE_METADATA_REPORTER (default true)
 *  - CONFIGURE_STRICT_MANAGER (default true)
 *  - FREEZE_OLD_MANAGER (default false)
 */
contract RolloutStrictRegistryMigration is Script {
    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address signer = vm.addr(privateKey);

        address strictManager = vm.envAddress("STRICT_MANAGER_ADDRESS");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY_ADDRESS");
        address reporter = vm.envOr("QOS_METADATA_REPORTER_ADDRESS", address(0));
        address slashAuthority = vm.envOr("SLASH_AUTHORITY_ADDRESS", address(0));
        address rewardVault = vm.envOr("REWARD_VAULT_ADDRESS", address(0));
        address rewardParameters = vm.envOr("REWARD_PARAMETERS_ADDRESS", address(0));
        address oldManager = vm.envOr("OLD_MANAGER_ADDRESS", address(0));
        bool authorizeRegistrar = vm.envOr("AUTHORIZE_REGISTRAR", true);
        bool authorizeMetadataReporter = vm.envOr("AUTHORIZE_METADATA_REPORTER", true);
        bool configureStrictManager = vm.envOr("CONFIGURE_STRICT_MANAGER", true);
        bool freezeOldManager = vm.envOr("FREEZE_OLD_MANAGER", false);

        console.log("==================================================");
        console.log("Strict Registry Migration Rollout");
        console.log("==================================================");
        console.log("Chain ID:", block.chainid);
        console.log("Signer:", signer);
        console.log("Strict manager:", strictManager);
        console.log("Identity registry:", identityRegistry);
        console.log("QoS metadata reporter:", reporter);
        console.log("Configure strict manager:", configureStrictManager);
        console.log("Authorize registrar:", authorizeRegistrar);
        console.log("Authorize metadata reporter:", authorizeMetadataReporter);
        console.log("Freeze old manager:", freezeOldManager);
        console.log("Old manager:", oldManager);

        vm.startBroadcast(privateKey);

        if (configureStrictManager) {
            IStrictNodeStakingManagerRollout manager = IStrictNodeStakingManagerRollout(strictManager);
            manager.setIdentityRegistry(identityRegistry);
            manager.setRequireAgentRegistration(true);

            if (slashAuthority != address(0)) {
                manager.setSlashAuthority(slashAuthority);
            }
            if (rewardVault != address(0)) {
                manager.setRewardVault(rewardVault);
            }
            if (rewardParameters != address(0)) {
                manager.setRewardParameters(rewardParameters);
            }
        }

        IStrictIdentityRegistryRollout registry = IStrictIdentityRegistryRollout(identityRegistry);
        if (authorizeRegistrar) {
            registry.setRegistrarAuthorization(strictManager, true);
        }
        if (authorizeMetadataReporter && reporter != address(0)) {
            registry.setMetadataReporter(reporter, true);
        }

        if (freezeOldManager && oldManager != address(0)) {
            INodeStakingFreezeRollout(oldManager).setMinStakeUSD(type(uint256).max);
        }

        vm.stopBroadcast();

        console.log("Strict registry rollout steps executed.");
        console.log("==================================================");
    }
}
