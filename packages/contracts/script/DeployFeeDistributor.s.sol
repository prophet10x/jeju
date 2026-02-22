// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/distributor/FeeDistributor.sol";
import "../src/distributor/AirdropManager.sol";

/**
 * @title DeployFeeDistributor
 * @notice Deploys fee distribution infrastructure
 * @dev Deploys:
 *      - FeeDistributor (protocol fee distribution)
 *      - AirdropManager (token airdrops via fee distributor)
 *
 * Run: forge script script/DeployFeeDistributor.s.sol:DeployFeeDistributor --rpc-url jeju_testnet --broadcast --legacy -vvv
 */
contract DeployFeeDistributor is Script {
    function run() external {
        address deployer = msg.sender;
        address jejuToken = vm.envOr("JEJU_TOKEN_ADDRESS", deployer);
        address liquidityVault = vm.envOr("LIQUIDITY_VAULT_ADDRESS", deployer);
        address feeConfig = vm.envOr("FEE_CONFIG_ADDRESS", deployer);

        console.log("==================================================");
        console.log("Deploying Fee Distribution Infrastructure");
        console.log("==================================================");
        console.log("Deployer:", deployer);
        console.log("Reward Token (JEJU):", jejuToken);
        console.log("Liquidity Vault:", liquidityVault);
        console.log("Fee Config:", feeConfig);
        console.log("");

        vm.startBroadcast();

        // FeeDistributor
        FeeDistributor feeDistributor = new FeeDistributor(
            jejuToken,
            liquidityVault,
            feeConfig,
            deployer
        );
        console.log("FeeDistributor:", address(feeDistributor));

        // AirdropManager
        AirdropManager airdropManager = new AirdropManager(
            address(feeDistributor),
            deployer
        );
        console.log("AirdropManager:", address(airdropManager));

        vm.stopBroadcast();

        console.log("");
        console.log("==================================================");
        console.log("Fee Distribution Deployment Complete");
        console.log("==================================================");
        console.log("  FeeDistributor:", address(feeDistributor));
        console.log("  AirdropManager:", address(airdropManager));
    }
}
