// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {StorageProviderRegistryV2} from "../src/storage/StorageProviderRegistryV2.sol";
import {StorageEscrowV2} from "../src/storage/StorageEscrowV2.sol";
import {StorageRegistryV2} from "../src/storage/StorageRegistryV2.sol";
import {StorageRecoveryManagerV2} from "../src/storage/StorageRecoveryManagerV2.sol";

contract DeployStorageV2 is Script {
    function run() external {
        address deployer = vm.envOr("DEPLOYER_ADDRESS", address(0));
        if (deployer == address(0)) {
            deployer = vm.addr(vm.envUint("PRIVATE_KEY"));
        }

        address governanceAdmin = vm.envOr("GOVERNANCE_ADMIN_ADDRESS", deployer);
        address operationsMultisig = vm.envOr("OPERATIONS_MULTISIG_ADDRESS", governanceAdmin);
        address treasury = vm.envOr("TREASURY_ADDRESS", governanceAdmin);
        address jejuToken = vm.envAddress("JEJU_TOKEN_ADDRESS");
        address priceOracle = vm.envAddress("PRICE_ORACLE_ADDRESS");

        console.log("==================================================");
        console.log("Deploying Storage V2 Protocol");
        console.log("==================================================");
        console.log("deployer", deployer);
        console.log("governanceAdmin", governanceAdmin);
        console.log("operationsMultisig", operationsMultisig);
        console.log("treasury", treasury);
        console.log("jejuToken", jejuToken);
        console.log("priceOracle", priceOracle);

        vm.startBroadcast();

        StorageProviderRegistryV2 providerRegistry = new StorageProviderRegistryV2(governanceAdmin, jejuToken);
        StorageEscrowV2 escrow = new StorageEscrowV2(governanceAdmin, jejuToken, priceOracle);
        StorageRegistryV2 registry = new StorageRegistryV2(governanceAdmin, address(providerRegistry), address(escrow));
        StorageRecoveryManagerV2 recoveryManager = new StorageRecoveryManagerV2(governanceAdmin, address(registry));

        providerRegistry.grantRole(providerRegistry.REGISTRY_ROLE(), address(registry));
        escrow.grantRole(escrow.REGISTRY_ROLE(), address(registry));
        registry.grantRole(registry.RECOVERY_MANAGER_ROLE(), address(recoveryManager));
        registry.grantRole(registry.REGISTRAR_ROLE(), operationsMultisig);
        registry.grantRole(registry.REPLICA_SETTER_ROLE(), operationsMultisig);
        recoveryManager.grantRole(recoveryManager.REPAIR_COORDINATOR_ROLE(), operationsMultisig);

        vm.stopBroadcast();

        console.log("");
        console.log("StorageProviderRegistryV2:", address(providerRegistry));
        console.log("StorageEscrowV2:", address(escrow));
        console.log("StorageRegistryV2:", address(registry));
        console.log("StorageRecoveryManagerV2:", address(recoveryManager));
        console.log("Suggested config patch:");
        console.log("  storageProviderRegistryV2");
        console.log(vm.toString(address(providerRegistry)));
        console.log("  storageRegistryV2");
        console.log(vm.toString(address(registry)));
        console.log("  storageEscrowV2");
        console.log(vm.toString(address(escrow)));
        console.log("  storageRecoveryManagerV2");
        console.log(vm.toString(address(recoveryManager)));
        console.log("==================================================");
        console.log("Storage V2 Deployment Complete");
        console.log("==================================================");
    }
}
