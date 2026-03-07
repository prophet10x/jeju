// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {INodeStakingManager} from "../../src/staking/INodeStakingManager.sol";
import {NodeStakingManager} from "../../src/staking/NodeStakingManager.sol";
import {NodeRewardVault} from "../../src/staking/NodeRewardVault.sol";
import {NodeStakingRewardParameters} from "../../src/staking/NodeStakingRewardParameters.sol";
import {IPaymasterFactory, ITokenRegistry} from "../../src/interfaces/IPaymaster.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

contract MockStakeTokenRewards is ERC20 {
    constructor() ERC20("Stake Token", "STK") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockTokenRegistryRewards is ITokenRegistry {
    mapping(address => bool) public supported;

    function setSupported(address token, bool isSupported_) external {
        supported[token] = isSupported_;
    }

    function isSupported(address token) external view returns (bool) {
        return supported[token];
    }
}

contract MockPaymasterFactoryRewards is IPaymasterFactory {
    mapping(address => bool) public deployed;
    mapping(address => address) public paymasters;

    function setDeployed(address token, bool isDeployed_, address paymaster) external {
        deployed[token] = isDeployed_;
        paymasters[token] = paymaster;
    }

    function isDeployed(address token) external view returns (bool) {
        return deployed[token];
    }

    function getPaymaster(address token) external view returns (address) {
        return paymasters[token];
    }
}

contract MockPriceOracleRewards is IPriceOracle {
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

contract NodeStakingRewardControlsTest is Test {
    MockStakeTokenRewards internal token;
    MockTokenRegistryRewards internal tokenRegistry;
    MockPaymasterFactoryRewards internal paymasterFactory;
    MockPriceOracleRewards internal priceOracle;
    NodeStakingManager internal manager;
    NodeRewardVault internal rewardVault;
    NodeStakingRewardParameters internal rewardParameters;

    address internal constant PERFORMANCE_ORACLE = address(0x1234);
    address internal constant FAKE_PAYMASTER = address(0x5678);
    address internal alice = makeAddr("alice");
    address internal governance = makeAddr("governance");

    uint256 internal constant STAKE_AMOUNT = 1000 ether;
    uint256 internal constant TOKEN_PRICE_USD = 1 ether;
    uint256 internal constant VAULT_FUNDING = 10_000 ether;

    function setUp() public {
        token = new MockStakeTokenRewards();
        tokenRegistry = new MockTokenRegistryRewards();
        paymasterFactory = new MockPaymasterFactoryRewards();
        priceOracle = new MockPriceOracleRewards();

        tokenRegistry.setSupported(address(token), true);
        paymasterFactory.setDeployed(address(token), true, FAKE_PAYMASTER);
        priceOracle.setPrice(address(token), TOKEN_PRICE_USD);
        priceOracle.setPrice(address(0), 3000 ether);

        manager = new NodeStakingManager(
            address(tokenRegistry), address(paymasterFactory), address(priceOracle), PERFORMANCE_ORACLE, address(this)
        );
        rewardVault = new NodeRewardVault(address(this));
        rewardVault.setAuthorizedManager(address(manager), true);
        manager.setRewardVault(address(rewardVault));

        rewardParameters = new NodeStakingRewardParameters(governance);

        token.approve(address(rewardVault), type(uint256).max);
        rewardVault.deposit(address(token), VAULT_FUNDING);

        IERC20(address(token)).transfer(alice, 100_000 ether);

        vm.startPrank(alice);
        IERC20(address(token)).approve(address(manager), type(uint256).max);
        vm.stopPrank();

        vm.deal(address(manager), 10 ether);
    }

    function test_ClaimRewards_PaysFromVaultNotStakedPrincipal() public {
        bytes32 nodeId = _registerNode();

        uint256 managerBalanceBefore = token.balanceOf(address(manager));
        uint256 vaultBalanceBefore = token.balanceOf(address(rewardVault));
        uint256 aliceBalanceBefore = token.balanceOf(alice);

        vm.warp(block.timestamp + 30 days);

        uint256 pendingRewards = manager.calculatePendingRewards(nodeId);
        assertEq(pendingRewards, 200 ether);

        vm.prank(alice);
        manager.claimRewards(nodeId);

        assertEq(token.balanceOf(address(manager)), managerBalanceBefore);
        assertEq(token.balanceOf(address(rewardVault)), vaultBalanceBefore - pendingRewards);
        assertEq(token.balanceOf(alice), aliceBalanceBefore + pendingRewards);
    }

    function test_RewardPayoutBPS_CanBeGovernedByParameterContract() public {
        manager.setRewardParameters(address(rewardParameters));
        bytes32 nodeId = _registerNode();

        vm.warp(block.timestamp + 30 days);
        assertEq(manager.calculatePendingRewards(nodeId), 200 ether);

        vm.prank(governance);
        rewardParameters.setParameter(keccak256("node.rewardPayoutBps"), abi.encode(uint256(5000)));

        assertEq(manager.calculatePendingRewards(nodeId), 100 ether);
    }

    function test_OwnerFeeSettersRevertWhenRewardParametersConfigured() public {
        manager.setRewardParameters(address(rewardParameters));

        vm.expectRevert(NodeStakingManager.GovernedByRewardParameters.selector);
        manager.setPaymasterFees(100, 100);

        vm.expectRevert(NodeStakingManager.GovernedByRewardParameters.selector);
        manager.setRewardPayoutBPS(9000);
    }

    function test_ClaimRewards_RevertsWhenVaultLiquidityIsInsufficient() public {
        NodeStakingManager localManager = new NodeStakingManager(
            address(tokenRegistry), address(paymasterFactory), address(priceOracle), PERFORMANCE_ORACLE, address(this)
        );
        NodeRewardVault emptyVault = new NodeRewardVault(address(this));
        emptyVault.setAuthorizedManager(address(localManager), true);
        localManager.setRewardVault(address(emptyVault));

        IERC20(address(token)).transfer(alice, 10_000 ether);
        vm.prank(alice);
        IERC20(address(token)).approve(address(localManager), type(uint256).max);
        vm.deal(address(localManager), 10 ether);

        vm.prank(alice);
        bytes32 nodeId = localManager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-empty-vault.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );

        token.approve(address(emptyVault), type(uint256).max);
        emptyVault.deposit(address(token), 50 ether);

        vm.warp(block.timestamp + 30 days);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NodeStakingManager.InsufficientRewardLiquidity.selector, 50 ether, 200 ether));
        localManager.claimRewards(nodeId);
    }

    function _registerNode() internal returns (bytes32 nodeId) {
        vm.prank(alice);
        nodeId = manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-rewards.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );
    }
}
