// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {NodeStakeVault} from "../src/staking/NodeStakeVault.sol";
import {NodeStateRegistry} from "../src/staking/NodeStateRegistry.sol";
import {NodeManagerRouter} from "../src/staking/NodeManagerRouter.sol";
import {NodeManagerV3} from "../src/staking/modules/NodeManagerV3.sol";
import {NodeMigrationHandlerV3} from "../src/staking/modules/NodeMigrationHandlerV3.sol";

contract DeployNodeStakingV3 is Script {
    function run() external {
        address deployer = vm.envOr("DEPLOYER_ADDRESS", address(0));
        if (deployer == address(0)) {
            deployer = vm.addr(vm.envUint("PRIVATE_KEY"));
        }
        address governanceAdmin = vm.envOr("GOVERNANCE_ADMIN_ADDRESS", deployer);
        address moduleAdmin = vm.envOr("TIMELOCK_ADMIN_ADDRESS", governanceAdmin);
        address operationsMultisig = vm.envOr("OPERATIONS_MULTISIG_ADDRESS", governanceAdmin);
        address tokenRegistry = vm.envAddress("TOKEN_REGISTRY_ADDRESS");
        address priceOracle = vm.envAddress("PRICE_ORACLE_ADDRESS");

        console.log("==================================================");
        console.log("Deploying Node Staking V3 Foundation");
        console.log("==================================================");
        console.log("deployer", deployer);
        console.log("governanceAdmin", governanceAdmin);
        console.log("moduleAdmin", moduleAdmin);
        console.log("operationsMultisig", operationsMultisig);
        console.log("tokenRegistry", tokenRegistry);
        console.log("priceOracle", priceOracle);

        vm.startBroadcast();

        // Bootstrap vault with deployer as initial registry-role holder; registry is granted immediately after deploy.
        NodeStakeVault vault = new NodeStakeVault(governanceAdmin, governanceAdmin);
        NodeStateRegistry registry = new NodeStateRegistry(governanceAdmin, address(vault));
        NodeMigrationHandlerV3 migrationHandler = new NodeMigrationHandlerV3(address(registry), governanceAdmin);
        NodeManagerRouter router = new NodeManagerRouter(address(registry), 3, governanceAdmin);
        NodeManagerV3 managerV3 =
            new NodeManagerV3(address(router), governanceAdmin, address(registry), tokenRegistry, priceOracle);

        // Vault permissions
        vault.grantRole(vault.REGISTRY_ROLE(), address(registry));
        vault.revokeRole(vault.REGISTRY_ROLE(), governanceAdmin);

        // Registry permissions
        registry.registerModule(3, address(managerV3), address(migrationHandler), true);
        registry.grantRole(registry.MODULE_ADMIN_ROLE(), moduleAdmin);
        registry.grantRole(registry.EMERGENCY_ROLE(), operationsMultisig);
        registry.renounceRole(registry.MODULE_ADMIN_ROLE(), governanceAdmin);

        // Router permissions
        router.grantRole(router.MODULE_ADMIN_ROLE(), moduleAdmin);
        router.grantRole(router.EMERGENCY_ROLE(), operationsMultisig);
        router.grantRole(router.PERFORMANCE_ORACLE_ROLE(), operationsMultisig);
        router.renounceRole(router.MODULE_ADMIN_ROLE(), governanceAdmin);

        vm.stopBroadcast();

        console.log("");
        console.log("NodeStakeVault:", address(vault));
        console.log("NodeStateRegistry:", address(registry));
        console.log("NodeMigrationHandlerV3:", address(migrationHandler));
        console.log("NodeManagerRouter:", address(router));
        console.log("NodeManagerV3:", address(managerV3));
        console.log("==================================================");
        console.log("Node Staking V3 Foundation Deployment Complete");
        console.log("==================================================");
    }
}
