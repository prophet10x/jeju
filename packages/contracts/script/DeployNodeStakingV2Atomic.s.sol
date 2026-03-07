// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";
import {NodeStakingManagerV2Atomic} from "../src/staking/NodeStakingManagerV2Atomic.sol";
import {NodeRewardVault} from "../src/staking/NodeRewardVault.sol";

interface INodeStakingSource {
    function owner() external view returns (address);
    function tokenRegistry() external view returns (address);
    function paymasterFactory() external view returns (address);
    function priceOracle() external view returns (address);
    function performanceOracles(uint256 index) external view returns (address);
    function identityRegistry() external view returns (address);
    function slashAuthority() external view returns (address);
    function minStakeUSD() external view returns (uint256);
    function paymasterRewardCutBPS() external view returns (uint256);
    function paymasterStakeCutBPS() external view returns (uint256);
    function geographicBonusBPS() external view returns (uint256);
    function tokenDiversityBonusBPS() external view returns (uint256);
    function volumeBonusPerThousandRequests() external view returns (uint256);
    function tokenDiversityBonusEnabled() external view returns (bool);
}

/**
 * @title DeployNodeStakingV2Atomic
 * @notice Deploys atomic-only node staking manager and optionally clones runtime config from current manager.
 *
 * Required env:
 *   - PRIVATE_KEY
 *   - OLD_NODE_STAKING_MANAGER_ADDRESS
 *
 * Optional env:
 *   - NODE_STAKING_OWNER_ADDRESS (default old manager owner)
 *   - TOKEN_REGISTRY_ADDRESS (default old manager tokenRegistry)
 *   - PAYMASTER_FACTORY_ADDRESS (default old manager paymasterFactory)
 *   - PRICE_ORACLE_ADDRESS (default old manager priceOracle)
 *   - PERFORMANCE_ORACLE_ADDRESS (default old manager performanceOracles(0))
 *   - IDENTITY_REGISTRY_ADDRESS (default old manager identityRegistry)
 *   - SLASH_AUTHORITY_ADDRESS (default old manager slashAuthority)
 *   - REWARD_VAULT_ADDRESS (default unset)
 *   - REWARD_PARAMETERS_ADDRESS (default unset)
 *   - REQUIRE_AGENT_REGISTRATION (default true)
 *   - COPY_RUNTIME_PARAMS (default true)
 *
 * Run example:
 *   forge script script/DeployNodeStakingV2Atomic.s.sol:DeployNodeStakingV2Atomic --rpc-url jeju_testnet --broadcast
 */
contract DeployNodeStakingV2Atomic is Script {
    function run() external returns (address deployed) {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address oldManagerAddress = vm.envAddress("OLD_NODE_STAKING_MANAGER_ADDRESS");
        INodeStakingSource oldManager = INodeStakingSource(oldManagerAddress);

        address ownerAddr = vm.envOr("NODE_STAKING_OWNER_ADDRESS", oldManager.owner());
        address tokenRegistry = vm.envOr("TOKEN_REGISTRY_ADDRESS", oldManager.tokenRegistry());
        address paymasterFactory = vm.envOr("PAYMASTER_FACTORY_ADDRESS", oldManager.paymasterFactory());
        address priceOracle = vm.envOr("PRICE_ORACLE_ADDRESS", oldManager.priceOracle());
        address performanceOracle = vm.envOr("PERFORMANCE_ORACLE_ADDRESS", oldManager.performanceOracles(0));
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY_ADDRESS", oldManager.identityRegistry());
        address slashAuthority = vm.envOr("SLASH_AUTHORITY_ADDRESS", oldManager.slashAuthority());
        address rewardVault = vm.envOr("REWARD_VAULT_ADDRESS", address(0));
        address rewardParameters = vm.envOr("REWARD_PARAMETERS_ADDRESS", address(0));
        bool requireAgentRegistration = vm.envOr("REQUIRE_AGENT_REGISTRATION", true);
        bool copyRuntimeParams = vm.envOr("COPY_RUNTIME_PARAMS", true);

        console.log("==================================================");
        console.log("Deploy NodeStakingManagerV2Atomic");
        console.log("==================================================");
        console.log("Chain ID:", block.chainid);
        console.log("Deployer:", deployer);
        console.log("Old manager:", oldManagerAddress);
        console.log("Owner:", ownerAddr);
        console.log("TokenRegistry:", tokenRegistry);
        console.log("PaymasterFactory:", paymasterFactory);
        console.log("PriceOracle:", priceOracle);
        console.log("PerformanceOracle:", performanceOracle);
        console.log("IdentityRegistry:", identityRegistry);
        console.log("SlashAuthority:", slashAuthority);
        console.log("RewardVault:", rewardVault);
        console.log("RewardParameters:", rewardParameters);
        console.log("RequireAgentRegistration:", requireAgentRegistration);
        console.log("CopyRuntimeParams:", copyRuntimeParams);
        console.log("");

        vm.startBroadcast(privateKey);

        NodeStakingManagerV2Atomic manager =
            new NodeStakingManagerV2Atomic(tokenRegistry, paymasterFactory, priceOracle, performanceOracle, ownerAddr);
        deployed = address(manager);

        if (ownerAddr == deployer) {
            if (identityRegistry != address(0)) {
                manager.setIdentityRegistry(identityRegistry);
            }
            manager.setRequireAgentRegistration(requireAgentRegistration);
            if (slashAuthority != address(0)) {
                manager.setSlashAuthority(slashAuthority);
            }
            if (rewardVault != address(0)) {
                manager.setRewardVault(rewardVault);
                try NodeRewardVault(rewardVault).setAuthorizedManager(address(manager), true) {} catch {
                    console.log("NOTICE: reward vault manager authorization skipped.");
                }
            }
            if (rewardParameters != address(0)) {
                manager.setRewardParameters(rewardParameters);
            }

            if (copyRuntimeParams) {
                manager.setMinStakeUSD(oldManager.minStakeUSD());
                if (rewardParameters == address(0)) {
                    manager.setPaymasterFees(oldManager.paymasterRewardCutBPS(), oldManager.paymasterStakeCutBPS());
                } else {
                    console.log("NOTICE: reward parameters attached; skipping direct paymaster fee copy.");
                }
                manager.setGeographicBonus(oldManager.geographicBonusBPS());
                manager.setTokenDiversityBonus(oldManager.tokenDiversityBonusBPS());
                manager.setVolumeBonus(oldManager.volumeBonusPerThousandRequests());
                manager.enableTokenDiversityBonus(oldManager.tokenDiversityBonusEnabled());
            }
        } else {
            console.log("NOTICE: owner is not deployer; post-deploy owner calls were skipped.");
        }

        vm.stopBroadcast();

        console.log("");
        console.log("NodeStakingManagerV2Atomic:", deployed);
        console.log("==================================================");
        console.log("Atomic manager deployment complete");
        console.log("==================================================");
    }
}
