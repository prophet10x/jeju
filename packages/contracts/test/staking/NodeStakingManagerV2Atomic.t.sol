// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {INodeStakingManager} from "../../src/staking/INodeStakingManager.sol";
import {NodeStakingManagerV2Atomic} from "../../src/staking/NodeStakingManagerV2Atomic.sol";
import {IPaymasterFactory, ITokenRegistry} from "../../src/interfaces/IPaymaster.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {IIdentityRegistry} from "../../src/registry/interfaces/IIdentityRegistry.sol";

contract MockStakeTokenAtomic is ERC20 {
    constructor() ERC20("Stake Token", "STK") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockTokenRegistryAtomic is ITokenRegistry {
    mapping(address => bool) public supported;

    function setSupported(address token, bool isSupported_) external {
        supported[token] = isSupported_;
    }

    function isSupported(address token) external view returns (bool) {
        return supported[token];
    }
}

contract MockPaymasterFactoryAtomic is IPaymasterFactory {
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

contract MockPriceOracleAtomic is IPriceOracle {
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

contract MockAtomicIdentityRegistryForAtomic {
    error UnauthorizedRegistrar();
    error InvalidOwner();
    error InvalidAgent();

    mapping(uint256 => address) private _owners;
    mapping(uint256 => bool) private _exists;
    mapping(address => bool) private _authorizedRegistrars;
    uint256 private _nextAgentId = 1;

    function createAgent(address owner_) external returns (uint256 agentId) {
        if (owner_ == address(0)) revert InvalidOwner();
        agentId = _nextAgentId++;
        _owners[agentId] = owner_;
        _exists[agentId] = true;
    }

    function setRegistrarAuthorization(address registrar, bool authorized) external {
        _authorizedRegistrars[registrar] = authorized;
    }

    function registerFor(address owner_, string calldata, IIdentityRegistry.MetadataEntry[] calldata)
        external
        returns (uint256 agentId)
    {
        if (!_authorizedRegistrars[msg.sender]) revert UnauthorizedRegistrar();
        if (owner_ == address(0)) revert InvalidOwner();

        agentId = _nextAgentId++;
        _owners[agentId] = owner_;
        _exists[agentId] = true;
    }

    function agentExists(uint256 agentId) external view returns (bool) {
        return _exists[agentId];
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        if (!_exists[agentId]) revert InvalidAgent();
        return _owners[agentId];
    }
}

contract MockLegacyIdentityRegistryForAtomic {
    error InvalidOwner();
    error InvalidAgent();

    mapping(uint256 => address) private _owners;
    mapping(uint256 => bool) private _exists;
    uint256 private _nextAgentId = 1;

    function createAgent(address owner_) external returns (uint256 agentId) {
        if (owner_ == address(0)) revert InvalidOwner();
        agentId = _nextAgentId++;
        _owners[agentId] = owner_;
        _exists[agentId] = true;
    }

    function agentExists(uint256 agentId) external view returns (bool) {
        return _exists[agentId];
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        if (!_exists[agentId]) revert InvalidAgent();
        return _owners[agentId];
    }
}

contract NodeStakingManagerV2AtomicTest is Test {
    MockStakeTokenAtomic internal token;
    MockTokenRegistryAtomic internal tokenRegistry;
    MockPaymasterFactoryAtomic internal paymasterFactory;
    MockPriceOracleAtomic internal priceOracle;
    MockAtomicIdentityRegistryForAtomic internal identityRegistry;
    NodeStakingManagerV2Atomic internal manager;

    address internal constant PERFORMANCE_ORACLE = address(0x1234);
    address internal constant FAKE_PAYMASTER = address(0x5678);
    address internal alice = makeAddr("alice");
    uint256 internal aliceOperatorAgentId;

    uint256 internal constant STAKE_AMOUNT = 1000 ether;
    uint256 internal constant TOKEN_PRICE_USD = 1 ether;

    function setUp() public {
        token = new MockStakeTokenAtomic();
        tokenRegistry = new MockTokenRegistryAtomic();
        paymasterFactory = new MockPaymasterFactoryAtomic();
        priceOracle = new MockPriceOracleAtomic();

        tokenRegistry.setSupported(address(token), true);
        paymasterFactory.setDeployed(address(token), true, FAKE_PAYMASTER);
        priceOracle.setPrice(address(token), TOKEN_PRICE_USD);
        priceOracle.setPrice(address(0), 3000 ether);

        manager = new NodeStakingManagerV2Atomic(
            address(tokenRegistry), address(paymasterFactory), address(priceOracle), PERFORMANCE_ORACLE, address(this)
        );
        // Fund reward payouts so deregister/claim flows can execute in tests.
        IERC20(address(token)).transfer(address(manager), 1_000_000 ether);

        identityRegistry = new MockAtomicIdentityRegistryForAtomic();
        manager.setIdentityRegistry(address(identityRegistry));
        manager.setRequireAgentRegistration(true);
        identityRegistry.setRegistrarAuthorization(address(manager), true);
        aliceOperatorAgentId = identityRegistry.createAgent(alice);

        IERC20(address(token)).transfer(alice, 100_000 ether);

        vm.startPrank(alice);
        IERC20(address(token)).approve(address(manager), type(uint256).max);
        vm.stopPrank();
    }

    function test_RegisterNode_RevertsWhenAtomicOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(NodeStakingManagerV2Atomic.NonAtomicRegistrationDisabled.selector);
        manager.registerNode(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://atomic-only.jeju.test",
            INodeStakingManager.Region.NorthAmerica
        );
        vm.stopPrank();
    }

    function test_RegisterNodeWithAgent_RevertsWhenAtomicOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(NodeStakingManagerV2Atomic.NonAtomicRegistrationDisabled.selector);
        manager.registerNodeWithAgent(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://atomic-only.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            aliceOperatorAgentId
        );
        vm.stopPrank();
    }

    function test_RegisterNodeWithAgentAndIdentity_Succeeds() public {
        IIdentityRegistry.MetadataEntry[] memory metadata = new IIdentityRegistry.MetadataEntry[](1);
        metadata[0] = IIdentityRegistry.MetadataEntry({key: "operatorAgentId", value: bytes("1")});

        vm.startPrank(alice);
        (bytes32 nodeId, uint256 nodeIdentityAgentId) = manager.registerNodeWithAgentAndIdentity(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-atomic.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            aliceOperatorAgentId,
            "ipfs://node-atomic",
            metadata
        );
        vm.stopPrank();

        assertEq(manager.getNodeIdentityAgentId(nodeId), nodeIdentityAgentId);
        assertEq(manager.getNodeIdByIdentityAgent(nodeIdentityAgentId), nodeId);
        assertTrue(manager.supportsAtomicNodeIdentityRegistration());
    }

    function test_NonRegistrationOpsRemainUnchanged() public {
        IIdentityRegistry.MetadataEntry[] memory metadata = new IIdentityRegistry.MetadataEntry[](0);

        vm.startPrank(alice);
        (bytes32 nodeId,) = manager.registerNodeWithAgentAndIdentity(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://node-atomic.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            aliceOperatorAgentId,
            "ipfs://node-atomic",
            metadata
        );

        bytes32 servicesHash = keccak256("storage,rpc");
        manager.updateNodeServices(nodeId, servicesHash);
        manager.updateNodeConfig(nodeId, "https://node-atomic-updated.jeju.test", INodeStakingManager.Region.Europe);

        assertEq(manager.getNodeServicesHash(nodeId), servicesHash);

        vm.warp(block.timestamp + 7 days + 1);
        uint256 balanceBefore = token.balanceOf(alice);
        manager.deregisterNode(nodeId);
        uint256 balanceAfter = token.balanceOf(alice);
        vm.stopPrank();

        (INodeStakingManager.NodeStake memory node,,) = manager.getNodeInfo(nodeId);
        assertFalse(node.isActive);
        assertEq(node.stakedAmount, 0);
        assertGt(balanceAfter, balanceBefore);
    }

    function test_RegisterNodeWithAgentAndIdentity_FallsBackToOperatorIdentityWhenRegisterForUnavailable() public {
        NodeStakingManagerV2Atomic managerFallback = new NodeStakingManagerV2Atomic(
            address(tokenRegistry), address(paymasterFactory), address(priceOracle), PERFORMANCE_ORACLE, address(this)
        );
        IERC20(address(token)).transfer(address(managerFallback), 1_000_000 ether);

        MockLegacyIdentityRegistryForAtomic legacyIdentity = new MockLegacyIdentityRegistryForAtomic();
        managerFallback.setIdentityRegistry(address(legacyIdentity));
        managerFallback.setRequireAgentRegistration(true);

        uint256 legacyOperatorAgentId = legacyIdentity.createAgent(alice);

        vm.startPrank(alice);
        IERC20(address(token)).approve(address(managerFallback), type(uint256).max);

        IIdentityRegistry.MetadataEntry[] memory metadata = new IIdentityRegistry.MetadataEntry[](0);
        (bytes32 nodeId, uint256 nodeIdentityAgentId) = managerFallback.registerNodeWithAgentAndIdentity(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://legacy-id-registry.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            legacyOperatorAgentId,
            "ipfs://legacy-fallback",
            metadata
        );
        vm.stopPrank();

        assertEq(nodeIdentityAgentId, legacyOperatorAgentId);
        assertEq(managerFallback.getNodeIdentityAgentId(nodeId), legacyOperatorAgentId);
        assertEq(managerFallback.getNodeIdByIdentityAgent(legacyOperatorAgentId), nodeId);
    }
}
