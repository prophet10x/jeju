// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/registry/IdentityRegistry.sol";

contract DeployIdentityRegistry is Script {
    function run() external returns (address deployed) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address governance = vm.envOr("IDENTITY_REGISTRY_GOVERNANCE", vm.addr(deployerPrivateKey));
        address reputationOracle = vm.envOr("IDENTITY_REGISTRY_REPUTATION_ORACLE", address(0));
        address registrar = vm.envOr("IDENTITY_REGISTRY_REGISTRAR", address(0));
        address metadataReporter = vm.envOr("IDENTITY_REGISTRY_METADATA_REPORTER", address(0));

        console.log("==================================================");
        console.log("Deploy IdentityRegistry");
        console.log("==================================================");
        console.log("Chain ID:", block.chainid);
        console.log("Governance:", governance);
        console.log("ReputationOracle:", reputationOracle);
        console.log("Registrar:", registrar);
        console.log("MetadataReporter:", metadataReporter);

        vm.startBroadcast(deployerPrivateKey);

        IdentityRegistry registry = new IdentityRegistry();
        deployed = address(registry);

        if (reputationOracle != address(0)) {
            registry.setReputationOracle(reputationOracle);
        }
        if (registrar != address(0)) {
            registry.setRegistrarAuthorization(registrar, true);
        }
        if (metadataReporter != address(0)) {
            registry.setMetadataReporter(metadataReporter, true);
        }
        if (governance != vm.addr(deployerPrivateKey)) {
            registry.setGovernance(governance);
        }

        vm.stopBroadcast();

        console.log("IdentityRegistry deployed at:", deployed);
        console.log("==================================================");
    }
}
