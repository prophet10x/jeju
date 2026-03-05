// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {INodeStakingManager} from "../../src/staking/INodeStakingManager.sol";
import {NodeStakingManager} from "../../src/staking/NodeStakingManager.sol";
import {NodeStakingManagerV2} from "../../src/staking/NodeStakingManagerV2.sol";
import {IPaymasterFactory, ITokenRegistry} from "../../src/interfaces/IPaymaster.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

contract MockStakeToken is ERC20 {
    constructor() ERC20("Stake Token", "STK") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockTokenRegistry is ITokenRegistry {
    mapping(address => bool) public supported;

    function setSupported(address token, bool isSupported_) external {
        supported[token] = isSupported_;
    }

    function isSupported(address token) external view returns (bool) {
        return supported[token];
    }
}

contract MockPaymasterFactory is IPaymasterFactory {
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

contract MockPriceOracle is IPriceOracle {
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

contract NodeStakingManagerV2BootstrapTest is Test {
    MockStakeToken internal token;
    MockTokenRegistry internal tokenRegistry;
    MockPaymasterFactory internal paymasterFactory;
    MockPriceOracle internal priceOracle;
    NodeStakingManagerV2 internal manager;

    address internal constant PERFORMANCE_ORACLE = address(0x1234);
    address internal constant FAKE_PAYMASTER = address(0x5678);
    address internal alice = makeAddr("alice");

    uint256 internal constant STAKE_AMOUNT = 1000 ether;
    uint256 internal constant TOKEN_PRICE_USD = 1 ether;

    function setUp() public {
        token = new MockStakeToken();
        tokenRegistry = new MockTokenRegistry();
        paymasterFactory = new MockPaymasterFactory();
        priceOracle = new MockPriceOracle();

        tokenRegistry.setSupported(address(token), true);
        paymasterFactory.setDeployed(address(token), true, FAKE_PAYMASTER);
        priceOracle.setPrice(address(token), TOKEN_PRICE_USD);
        priceOracle.setPrice(address(0), 3000 ether);

        manager = new NodeStakingManagerV2(
            address(tokenRegistry), address(paymasterFactory), address(priceOracle), PERFORMANCE_ORACLE, address(this)
        );

        IERC20(address(token)).transfer(alice, 100_000 ether);

        vm.startPrank(alice);
        IERC20(address(token)).approve(address(manager), type(uint256).max);
        vm.stopPrank();
    }

    function test_DefaultBootstrapExemption_AllowsSecondNodeUnderThreshold() public {
        vm.startPrank(alice);
        manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-1.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );
        manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-2.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );
        vm.stopPrank();

        INodeStakingManager.OperatorStats memory stats = manager.getOperatorStats(alice);
        assertEq(stats.totalNodesActive, 2);
        assertEq(manager.bootstrapOwnershipCapExemptionEnabled(), true);
        assertEq(manager.bootstrapOwnershipCapExemptionNodeThreshold(), 20);
    }

    function test_DisablingBootstrapExemption_RestoresOwnershipCap() public {
        vm.prank(alice);
        manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-1.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );

        manager.setBootstrapOwnershipCapConfig(false, 20);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NodeStakingManager.NetworkOwnershipExceeded.selector, 10_000, 2_000));
        manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-2.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );
    }

    function test_BootstrapThresholdBoundary_EnforcesCapAtThreshold() public {
        manager.setBootstrapOwnershipCapConfig(true, 2);

        vm.startPrank(alice);
        manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-1.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );
        manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-2.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );

        vm.expectRevert(abi.encodeWithSelector(NodeStakingManager.NetworkOwnershipExceeded.selector, 10_000, 2_000));
        manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-3.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );
        vm.stopPrank();
    }

    function test_IncreaseStake_UsesBootstrapExemptionRule() public {
        vm.startPrank(alice);
        bytes32 nodeId = manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-1.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );
        manager.increaseStake(nodeId, STAKE_AMOUNT);
        vm.stopPrank();

        (INodeStakingManager.NodeStake memory node,,) = manager.getNodeInfo(nodeId);
        assertEq(node.stakedAmount, STAKE_AMOUNT * 2);
    }

    function test_IncreaseStake_EnforcesCapOnceBootstrapWindowClosed() public {
        manager.setBootstrapOwnershipCapConfig(true, 1);

        vm.startPrank(alice);
        bytes32 nodeId = manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-1.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );

        vm.expectRevert(abi.encodeWithSelector(NodeStakingManager.NetworkOwnershipExceeded.selector, 10_000, 2_000));
        manager.increaseStake(nodeId, STAKE_AMOUNT);
        vm.stopPrank();
    }
}

