// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INodeStakingManager} from "../../src/staking/INodeStakingManager.sol";
import {NodeStakingManager} from "../../src/staking/NodeStakingManager.sol";
import {IPaymasterFactory, ITokenRegistry} from "../../src/interfaces/IPaymaster.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

contract MockStakeTokenForSlashDispute is ERC20 {
    constructor() ERC20("Stake Token", "STK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockTokenRegistryForSlashDispute is ITokenRegistry {
    mapping(address => bool) public supported;

    function setSupported(address token, bool isSupported_) external {
        supported[token] = isSupported_;
    }

    function isSupported(address token) external view returns (bool) {
        return supported[token];
    }
}

contract MockPaymasterFactoryForSlashDispute is IPaymasterFactory {
    mapping(address => bool) public deployed;
    mapping(address => address) public paymasters;

    function setDeployed(address token, bool isDeployed, address paymaster) external {
        deployed[token] = isDeployed;
        paymasters[token] = paymaster;
    }

    function isDeployed(address token) external view returns (bool) {
        return deployed[token];
    }

    function getPaymaster(address token) external view returns (address) {
        return paymasters[token];
    }
}

contract MockPriceOracleForSlashDispute is IPriceOracle {
    mapping(address => uint256) public prices;

    function setPrice(address token, uint256 priceUsd) external {
        prices[token] = priceUsd;
    }

    function getPrice(address token) external view returns (uint256 priceUSD, uint256 decimals) {
        return (prices[token], 18);
    }

    function isPriceFresh(address) external pure returns (bool fresh) {
        return true;
    }

    function convertAmount(address fromToken, address toToken, uint256 amount)
        external
        view
        returns (uint256 convertedAmount)
    {
        uint256 fromPrice = prices[fromToken];
        uint256 toPrice = prices[toToken];
        require(fromPrice > 0 && toPrice > 0, "price missing");
        return (amount * fromPrice) / toPrice;
    }
}

contract NodeStakingManagerSlashDisputeTest is Test {
    bytes32 internal constant SLASH_PROPOSED_EVENT =
        keccak256("SlashProposed(bytes32,bytes32,uint256,string)");

    MockStakeTokenForSlashDispute internal token;
    MockTokenRegistryForSlashDispute internal tokenRegistry;
    MockPaymasterFactoryForSlashDispute internal paymasterFactory;
    MockPriceOracleForSlashDispute internal priceOracle;
    NodeStakingManager internal manager;

    address internal operator = makeAddr("operator");
    address internal performanceOracle = makeAddr("perf-oracle");

    bytes32 internal nodeId;

    function setUp() public {
        token = new MockStakeTokenForSlashDispute();
        tokenRegistry = new MockTokenRegistryForSlashDispute();
        paymasterFactory = new MockPaymasterFactoryForSlashDispute();
        priceOracle = new MockPriceOracleForSlashDispute();

        tokenRegistry.setSupported(address(token), true);
        paymasterFactory.setDeployed(address(token), true, makeAddr("paymaster"));
        priceOracle.setPrice(address(token), 1 ether);
        priceOracle.setPrice(address(0), 3_000 ether);

        manager = new NodeStakingManager(
            address(tokenRegistry), address(paymasterFactory), address(priceOracle), performanceOracle, address(this)
        );

        token.mint(operator, 100_000 ether);
        vm.prank(operator);
        IERC20(address(token)).approve(address(manager), type(uint256).max);

        vm.prank(operator);
        nodeId = manager.registerNode(
            address(token),
            1_000 ether,
            address(token),
            "https://node.aws.jeju",
            INodeStakingManager.Region.NorthAmerica
        );
    }

    function test_DisputedSlash_CannotExecuteAfterDisputeWindow() public {
        bytes32 slashId = _proposeSlash(9_000, "META_PROPOSER_TIMEOUT");

        vm.prank(operator);
        manager.disputeSlash(slashId);

        vm.warp(block.timestamp + 24 hours + 1);
        vm.expectRevert(NodeStakingManager.SlashDisputePending.selector);
        manager.executeSlash(slashId);
    }

    function test_UndisputedSlash_ExecutesAfter24Hours() public {
        bytes32 slashId = _proposeSlash(9_000, "ATTESTATION_FAILURE");

        vm.expectRevert(NodeStakingManager.SlashDisputePending.selector);
        manager.executeSlash(slashId);

        vm.warp(block.timestamp + 24 hours + 1);
        manager.executeSlash(slashId);

        (INodeStakingManager.NodeStake memory node,,) = manager.getNodeInfo(nodeId);
        assertTrue(node.isSlashed);
        assertFalse(node.isActive);
    }

    function _proposeSlash(uint256 slashBps, string memory reason) internal returns (bytes32 slashId) {
        vm.recordLogs();
        manager.slashNode(nodeId, slashBps, reason);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics.length > 1 && entries[i].topics[0] == SLASH_PROPOSED_EVENT) {
                return entries[i].topics[1];
            }
        }

        revert("slash id not found");
    }
}
