// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";
import {NodeRewardVault} from "../src/staking/NodeRewardVault.sol";
import {NodeStakingManagerV2Strict} from "../src/staking/NodeStakingManagerV2Strict.sol";

interface INodeStakingSourceStrict {
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

contract DeployNodeStakingV2Strict is Script {
    function run() external returns (address deployed) {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address sourceManagerAddress = vm.envAddress("OLD_NODE_STAKING_MANAGER_ADDRESS");
        INodeStakingSourceStrict sourceManager = INodeStakingSourceStrict(sourceManagerAddress);

        address ownerAddr = vm.envOr("NODE_STAKING_OWNER_ADDRESS", sourceManager.owner());
        address tokenRegistry = vm.envOr("TOKEN_REGISTRY_ADDRESS", sourceManager.tokenRegistry());
        address paymasterFactory = vm.envOr("PAYMASTER_FACTORY_ADDRESS", sourceManager.paymasterFactory());
        address priceOracle = vm.envOr("PRICE_ORACLE_ADDRESS", sourceManager.priceOracle());
        address performanceOracle = vm.envOr("PERFORMANCE_ORACLE_ADDRESS", sourceManager.performanceOracles(0));
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY_ADDRESS", sourceManager.identityRegistry());
        address slashAuthority = vm.envOr("SLASH_AUTHORITY_ADDRESS", sourceManager.slashAuthority());
        address rewardVault = vm.envOr("REWARD_VAULT_ADDRESS", address(0));
        address rewardParameters = vm.envOr("REWARD_PARAMETERS_ADDRESS", address(0));
        bool requireAgentRegistration = vm.envOr("REQUIRE_AGENT_REGISTRATION", true);
        bool copyRuntimeParams = vm.envOr("COPY_RUNTIME_PARAMS", true);
        uint256 minStakingPeriodSeconds = vm.envOr("MIN_STAKING_PERIOD_SECONDS", uint256(7 days));

        console.log("==================================================");
        console.log("Deploy NodeStakingManagerV2Strict");
        console.log("==================================================");
        console.log("Chain ID:", block.chainid);
        console.log("Deployer:", deployer);
        console.log("Source manager:", sourceManagerAddress);
        console.log("Owner:", ownerAddr);
        console.log("IdentityRegistry:", identityRegistry);
        console.log("RewardVault:", rewardVault);
        console.log("RewardParameters:", rewardParameters);
        console.log("RequireAgentRegistration:", requireAgentRegistration);
        console.log("CopyRuntimeParams:", copyRuntimeParams);

        vm.startBroadcast(privateKey);

        NodeStakingManagerV2Strict manager =
            new NodeStakingManagerV2Strict(tokenRegistry, paymasterFactory, priceOracle, performanceOracle, ownerAddr);
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
                manager.setMinStakeUSD(sourceManager.minStakeUSD());
                if (rewardParameters == address(0)) {
                    manager.setMinStakingPeriod(minStakingPeriodSeconds);
                    manager.setPaymasterFees(
                        sourceManager.paymasterRewardCutBPS(), sourceManager.paymasterStakeCutBPS()
                    );
                } else {
                    console.log("NOTICE: reward parameters attached; skipping direct paymaster fee copy.");
                }
                manager.setGeographicBonus(sourceManager.geographicBonusBPS());
                manager.setTokenDiversityBonus(sourceManager.tokenDiversityBonusBPS());
                manager.setVolumeBonus(sourceManager.volumeBonusPerThousandRequests());
                manager.enableTokenDiversityBonus(sourceManager.tokenDiversityBonusEnabled());
            }
        } else {
            console.log("NOTICE: owner is not deployer; post-deploy owner calls were skipped.");
        }

        vm.stopBroadcast();

        console.log("");
        console.log("NodeStakingManagerV2Strict:", deployed);
        console.log("==================================================");
    }
}
