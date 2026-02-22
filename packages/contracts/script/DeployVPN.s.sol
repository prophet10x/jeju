// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/vpn/VPNRegistry.sol";

/**
 * @title DeployVPN
 * @notice Deploys VPN infrastructure contracts
 * @dev Deploys:
 *      - VPNRegistry (VPN node registration and management)
 *
 * Run: forge script script/DeployVPN.s.sol:DeployVPN --rpc-url jeju_testnet --broadcast --legacy -vvv
 */
contract DeployVPN is Script {
    function run() external {
        address deployer = msg.sender;
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        console.log("==================================================");
        console.log("Deploying VPN Infrastructure");
        console.log("==================================================");
        console.log("Deployer:", deployer);
        console.log("Treasury:", treasury);
        console.log("");

        vm.startBroadcast();

        VPNRegistry vpnRegistry = new VPNRegistry(deployer, treasury);
        console.log("VPNRegistry:", address(vpnRegistry));

        vm.stopBroadcast();

        console.log("");
        console.log("==================================================");
        console.log("VPN Deployment Complete");
        console.log("==================================================");
        console.log("  VPNRegistry:", address(vpnRegistry));
    }
}
