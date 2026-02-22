// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/marketplace/Marketplace.sol";

/**
 * @title DeployMarketplace
 * @notice Deploys marketplace contracts
 * @dev Deploys:
 *      - Marketplace (general-purpose marketplace with JEJU + USDC support)
 *
 * Run: forge script script/DeployMarketplace.s.sol:DeployMarketplace --rpc-url jeju_testnet --broadcast --legacy -vvv
 */
contract DeployMarketplace is Script {
    function run() external {
        address deployer = msg.sender;
        address jejuToken = vm.envOr("JEJU_TOKEN_ADDRESS", deployer);
        address usdcToken = vm.envOr("USDC_TOKEN_ADDRESS", deployer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT_ADDRESS", deployer);

        console.log("==================================================");
        console.log("Deploying Marketplace");
        console.log("==================================================");
        console.log("Deployer:", deployer);
        console.log("JEJU Token:", jejuToken);
        console.log("USDC Token:", usdcToken);
        console.log("Fee Recipient:", feeRecipient);
        console.log("");

        vm.startBroadcast();

        Marketplace marketplace = new Marketplace(
            deployer,
            jejuToken,
            usdcToken,
            feeRecipient
        );
        console.log("Marketplace:", address(marketplace));

        vm.stopBroadcast();

        console.log("");
        console.log("==================================================");
        console.log("Marketplace Deployment Complete");
        console.log("==================================================");
        console.log("  Marketplace:", address(marketplace));
    }
}
