// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/containers/ContainerRegistry.sol";

/**
 * @title DeployContainers
 * @notice Deploys container registry contracts
 * @dev Deploys:
 *      - ContainerRegistry (OCI container image registry on-chain)
 *
 * Run: forge script script/DeployContainers.s.sol:DeployContainers --rpc-url jeju_testnet --broadcast --legacy -vvv
 */
contract DeployContainers is Script {
    function run() external {
        address deployer = msg.sender;
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY_ADDRESS", deployer);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        console.log("==================================================");
        console.log("Deploying Container Registry");
        console.log("==================================================");
        console.log("Deployer:", deployer);
        console.log("Identity Registry:", identityRegistry);
        console.log("Treasury:", treasury);
        console.log("");

        vm.startBroadcast();

        ContainerRegistry containerRegistry = new ContainerRegistry(
            identityRegistry,
            treasury,
            deployer
        );
        console.log("ContainerRegistry:", address(containerRegistry));

        vm.stopBroadcast();

        console.log("");
        console.log("==================================================");
        console.log("Container Registry Deployment Complete");
        console.log("==================================================");
        console.log("  ContainerRegistry:", address(containerRegistry));
    }
}
