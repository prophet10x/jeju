// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";
import {NodeRewardVault} from "../src/staking/NodeRewardVault.sol";
import {NodeStakingRewardParameters} from "../src/staking/NodeStakingRewardParameters.sol";

/**
 * @title DeployNodeStakingRewardInfra
 * @notice Deploy isolated reward custody + governance parameter contracts for node staking.
 *
 * Required env:
 *   - PRIVATE_KEY
 *   - NODE_REWARD_GOVERNANCE
 *
 * Optional env:
 *   - NODE_REWARD_VAULT_OWNER (default deployer)
 *   - NODE_STAKING_MANAGER_ADDRESS (authorize as vault spender)
 */
contract DeployNodeStakingRewardInfra is Script {
    function run() external returns (address rewardVault, address rewardParameters) {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);

        address rewardGovernance = vm.envAddress("NODE_REWARD_GOVERNANCE");
        address rewardVaultOwner = vm.envOr("NODE_REWARD_VAULT_OWNER", deployer);
        address stakingManager = vm.envOr("NODE_STAKING_MANAGER_ADDRESS", address(0));

        console.log("==================================================");
        console.log("Deploy Node Staking Reward Infra");
        console.log("==================================================");
        console.log("Chain ID:", block.chainid);
        console.log("Deployer:", deployer);
        console.log("RewardGovernance:", rewardGovernance);
        console.log("RewardVaultOwner:", rewardVaultOwner);
        console.log("StakingManager:", stakingManager);

        vm.startBroadcast(privateKey);

        NodeRewardVault vault = new NodeRewardVault(rewardVaultOwner);
        NodeStakingRewardParameters parameters = new NodeStakingRewardParameters(rewardGovernance);

        rewardVault = address(vault);
        rewardParameters = address(parameters);

        if (stakingManager != address(0) && rewardVaultOwner == deployer) {
            vault.setAuthorizedManager(stakingManager, true);
        }

        vm.stopBroadcast();

        console.log("RewardVault:", rewardVault);
        console.log("RewardParameters:", rewardParameters);
        console.log("==================================================");
    }
}
