// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {IdentityRegistry} from "../../src/registry/IdentityRegistry.sol";

contract IdentityRegistryTest is Test {
    IdentityRegistry public registry;

    address public owner = makeAddr("owner");
    address public newOwner = makeAddr("newOwner");
    address public delegatedWallet = makeAddr("delegatedWallet");

    uint256 public agentId;

    function setUp() public {
        registry = new IdentityRegistry();

        vm.prank(owner);
        agentId = registry.register("ipfs://test-agent");
    }

    function testSetGetUnsetAgentWallet() public {
        vm.prank(owner);
        registry.setAgentWallet(agentId, delegatedWallet);

        assertEq(registry.getAgentWallet(agentId), delegatedWallet);

        vm.prank(owner);
        registry.unsetAgentWallet(agentId);

        assertEq(registry.getAgentWallet(agentId), address(0));
    }

    function testDelegatedWalletCanHeartbeat() public {
        vm.prank(owner);
        registry.setAgentWallet(agentId, delegatedWallet);

        IdentityRegistry.AgentRegistration memory beforeHeartbeat = registry.getAgent(agentId);

        vm.warp(block.timestamp + 1);
        vm.prank(delegatedWallet);
        registry.heartbeat(agentId);

        IdentityRegistry.AgentRegistration memory afterHeartbeat = registry.getAgent(agentId);
        assertGt(afterHeartbeat.lastActivityAt, beforeHeartbeat.lastActivityAt);
    }

    function testTransferClearsAgentWalletAndUpdatesCachedOwner() public {
        vm.prank(owner);
        registry.setAgentWallet(agentId, delegatedWallet);

        vm.prank(owner);
        registry.transferFrom(owner, newOwner, agentId);

        assertEq(registry.ownerOf(agentId), newOwner);
        assertEq(registry.getAgent(agentId).owner, newOwner);
        assertEq(registry.getAgentWallet(agentId), address(0));

        vm.prank(delegatedWallet);
        vm.expectRevert("Only agent owner or delegated wallet can send heartbeat");
        registry.heartbeat(agentId);
    }

    function testOnlyOwnerCanSetAgentWallet() public {
        vm.prank(newOwner);
        vm.expectRevert("Not authorized");
        registry.setAgentWallet(agentId, delegatedWallet);
    }
}
