// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/staking/NodeStakingManagerV2.sol";
import "../src/staking/AutoSlasher.sol";
import "../src/staking/ServiceStaking.sol";

/**
 * @title DeployStaking
 * @notice Deploys staking infrastructure contracts
 * @dev Deploys:
 *      - NodeStakingManagerV2 (node operator staking with editable node ops)
 *      - AutoSlasher (automated slashing)
 *      - ServiceStaking (per-service staking)
 *
 * Run: forge script script/DeployStaking.s.sol:DeployStaking --rpc-url jeju_testnet --broadcast --legacy -vvv
 */
contract DeployStaking is Script {
    function run() external {
        address deployer = msg.sender;

        // Dependencies from env or defaults
        address tokenRegistry = vm.envOr("TOKEN_REGISTRY_ADDRESS", deployer);
        address paymasterFactory = vm.envOr("PAYMASTER_FACTORY_ADDRESS", deployer);
        address priceOracle = vm.envOr("PRICE_ORACLE_ADDRESS", deployer);
        address performanceOracle = vm.envOr("PERFORMANCE_ORACLE_ADDRESS", deployer);
        address jejuToken = vm.envOr("JEJU_TOKEN_ADDRESS", deployer);

        console.log("==================================================");
        console.log("Deploying Staking Infrastructure");
        console.log("==================================================");
        console.log("Deployer:", deployer);
        console.log("Token Registry:", tokenRegistry);
        console.log("Paymaster Factory:", paymasterFactory);
        console.log("Price Oracle:", priceOracle);
        console.log("Performance Oracle:", performanceOracle);
        console.log("JEJU Token:", jejuToken);
        console.log("");

        vm.startBroadcast();

        // NodeStakingManagerV2
        NodeStakingManagerV2 stakingManager =
            new NodeStakingManagerV2(tokenRegistry, paymasterFactory, priceOracle, performanceOracle, deployer);
        console.log("NodeStakingManagerV2:", address(stakingManager));

        // AutoSlasher
        AutoSlasher autoSlasher = new AutoSlasher(address(stakingManager), deployer);
        console.log("AutoSlasher:", address(autoSlasher));

        // ServiceStaking
        ServiceStaking serviceStaking = new ServiceStaking(jejuToken, deployer);
        console.log("ServiceStaking:", address(serviceStaking));

        vm.stopBroadcast();

        console.log("");
        console.log("==================================================");
        console.log("Staking Deployment Complete");
        console.log("==================================================");
        console.log("  NodeStakingManagerV2:", address(stakingManager));
        console.log("  AutoSlasher:", address(autoSlasher));
        console.log("  ServiceStaking:", address(serviceStaking));
    }
}
