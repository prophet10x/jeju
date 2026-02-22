// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/escrow/TradeEscrow.sol";

/**
 * @title DeployEscrow
 * @notice Deploys escrow contracts
 * @dev Deploys:
 *      - TradeEscrow (P2P trade escrow for tokens, NFTs, and multi-assets)
 *
 * Run: forge script script/DeployEscrow.s.sol:DeployEscrow --rpc-url jeju_testnet --broadcast --legacy -vvv
 */
contract DeployEscrow is Script {
    function run() external {
        address deployer = msg.sender;

        console.log("==================================================");
        console.log("Deploying Escrow Contracts");
        console.log("==================================================");
        console.log("Deployer:", deployer);
        console.log("");

        vm.startBroadcast();

        TradeEscrow tradeEscrow = new TradeEscrow(deployer);
        console.log("TradeEscrow:", address(tradeEscrow));

        vm.stopBroadcast();

        console.log("");
        console.log("==================================================");
        console.log("Escrow Deployment Complete");
        console.log("==================================================");
        console.log("  TradeEscrow:", address(tradeEscrow));
    }
}
