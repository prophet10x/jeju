// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";

interface INodeStakingAdminRollout {
    function minStakeUSD() external view returns (uint256);
    function setMinStakeUSD(uint256 newMinimum) external;
}

interface INodeStakingV2AtomicAdminRollout is INodeStakingAdminRollout {
    function setIdentityRegistry(address identityRegistry) external;
    function setRequireAgentRegistration(bool required) external;
    function setSlashAuthority(address slashAuthority) external;
    function setRewardVault(address rewardVault) external;
    function setRewardParameters(address rewardParameters) external;
}

interface INodeManagerRouterAdminRollout {
    function getAllNodes() external view returns (bytes32[] memory nodeIds);
    function pause() external;
}

/**
 * @title RolloutAtomicNodeRegistration
 * @notice Applies atomic-only rollout controls:
 *         1) configure atomic manager
 *         2) freeze legacy/non-atomic managers (minStakeUSD = max uint)
 *         3) pause router after confirming no active nodes (optional precondition)
 *
 * Required env:
 *  - PRIVATE_KEY
 *  - ATOMIC_MANAGER_ADDRESS
 *
 * Optional env:
 *  - OLD_NODE_STAKING_MANAGER_ADDRESS
 *  - OLD_NODE_STAKING_MANAGERV2_ADDRESS
 *  - NODE_MANAGER_ROUTER_ADDRESS
 *  - IDENTITY_REGISTRY_ADDRESS
 *  - SLASH_AUTHORITY_ADDRESS
 *  - REWARD_VAULT_ADDRESS
 *  - REWARD_PARAMETERS_ADDRESS
 *  - CONFIGURE_ATOMIC_MANAGER (default true)
 *  - FREEZE_LEGACY_MANAGERS (default true)
 *  - PAUSE_ROUTER (default true)
 *  - ENFORCE_ROUTER_EMPTY (default true)
 */
contract RolloutAtomicNodeRegistration is Script {
    error RouterHasActiveNodes(uint256 nodeCount);

    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);

        address atomicManager = vm.envAddress("ATOMIC_MANAGER_ADDRESS");
        address oldManager = vm.envOr("OLD_NODE_STAKING_MANAGER_ADDRESS", address(0));
        address oldManagerV2 = vm.envOr("OLD_NODE_STAKING_MANAGERV2_ADDRESS", address(0));
        address router = vm.envOr("NODE_MANAGER_ROUTER_ADDRESS", address(0));
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY_ADDRESS", address(0));
        address slashAuthority = vm.envOr("SLASH_AUTHORITY_ADDRESS", address(0));
        address rewardVault = vm.envOr("REWARD_VAULT_ADDRESS", address(0));
        address rewardParameters = vm.envOr("REWARD_PARAMETERS_ADDRESS", address(0));
        bool configureAtomicManager = vm.envOr("CONFIGURE_ATOMIC_MANAGER", true);
        bool freezeLegacyManagers = vm.envOr("FREEZE_LEGACY_MANAGERS", true);
        bool pauseRouter = vm.envOr("PAUSE_ROUTER", true);
        bool enforceRouterEmpty = vm.envOr("ENFORCE_ROUTER_EMPTY", true);

        console.log("==================================================");
        console.log("Atomic Node Registration Rollout");
        console.log("==================================================");
        console.log("Chain ID:", block.chainid);
        console.log("Signer:", deployer);
        console.log("Atomic manager:", atomicManager);
        console.log("Legacy manager:", oldManager);
        console.log("Legacy manager V2:", oldManagerV2);
        console.log("Router:", router);
        console.log("Configure atomic manager:", configureAtomicManager);
        console.log("Freeze legacy managers:", freezeLegacyManagers);
        console.log("Pause router:", pauseRouter);
        console.log("Enforce router empty:", enforceRouterEmpty);

        vm.startBroadcast(privateKey);

        if (configureAtomicManager) {
            INodeStakingV2AtomicAdminRollout atomic = INodeStakingV2AtomicAdminRollout(atomicManager);

            if (identityRegistry != address(0)) {
                atomic.setIdentityRegistry(identityRegistry);
            }

            atomic.setRequireAgentRegistration(true);

            if (slashAuthority != address(0)) {
                atomic.setSlashAuthority(slashAuthority);
            }
            if (rewardVault != address(0)) {
                atomic.setRewardVault(rewardVault);
            }
            if (rewardParameters != address(0)) {
                atomic.setRewardParameters(rewardParameters);
            }
        }

        if (freezeLegacyManagers) {
            if (oldManager != address(0)) {
                INodeStakingAdminRollout old = INodeStakingAdminRollout(oldManager);
                old.setMinStakeUSD(type(uint256).max);
            }

            if (oldManagerV2 != address(0)) {
                INodeStakingAdminRollout oldV2 = INodeStakingAdminRollout(oldManagerV2);
                oldV2.setMinStakeUSD(type(uint256).max);
            }
        }

        if (pauseRouter && router != address(0)) {
            INodeManagerRouterAdminRollout routerContract = INodeManagerRouterAdminRollout(router);
            bytes32[] memory nodeIds = routerContract.getAllNodes();
            if (enforceRouterEmpty && nodeIds.length != 0) {
                revert RouterHasActiveNodes(nodeIds.length);
            }

            routerContract.pause();
        }

        vm.stopBroadcast();

        console.log("Rollout steps executed.");
        console.log("==================================================");
    }
}
