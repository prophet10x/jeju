// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {INodeStakingManager} from "../../src/staking/INodeStakingManager.sol";
import {NodeStakingManagerV2Strict} from "../../src/staking/NodeStakingManagerV2Strict.sol";
import {IPaymasterFactory, ITokenRegistry} from "../../src/interfaces/IPaymaster.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {IIdentityRegistry} from "../../src/registry/interfaces/IIdentityRegistry.sol";

contract MockStakeTokenStrict is ERC20 {
    constructor() ERC20("Stake Token", "STK") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockTokenRegistryStrict is ITokenRegistry {
    mapping(address => bool) public supported;

    function setSupported(address token, bool isSupported_) external {
        supported[token] = isSupported_;
    }

    function isSupported(address token) external view returns (bool) {
        return supported[token];
    }
}

contract MockPaymasterFactoryStrict is IPaymasterFactory {
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

contract MockPriceOracleStrict is IPriceOracle {
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

contract MockStrictIdentityRegistry {
    error UnauthorizedRegistrar();
    error InvalidOwner();
    error InvalidAgent();

    struct AgentInfo {
        uint256 agentId;
        address owner;
        uint8 tier;
        address stakedToken;
        uint256 stakedAmount;
        uint256 registeredAt;
        uint256 lastActivityAt;
        bool isBanned;
        bool isSlashed;
    }

    mapping(uint256 => AgentInfo) public agents;
    mapping(address => bool) private _authorizedRegistrars;
    uint256 private _nextAgentId = 1;

    function createAgent(address owner_, uint8 tier_, uint256 stakedAmount_) external returns (uint256 agentId) {
        if (owner_ == address(0)) revert InvalidOwner();
        agentId = _nextAgentId++;
        agents[agentId] = AgentInfo({
            agentId: agentId,
            owner: owner_,
            tier: tier_,
            stakedToken: address(0xCAFE),
            stakedAmount: stakedAmount_,
            registeredAt: block.timestamp,
            lastActivityAt: block.timestamp,
            isBanned: false,
            isSlashed: false
        });
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
        agents[agentId] = AgentInfo({
            agentId: agentId,
            owner: owner_,
            tier: 0,
            stakedToken: address(0),
            stakedAmount: 0,
            registeredAt: block.timestamp,
            lastActivityAt: block.timestamp,
            isBanned: false,
            isSlashed: false
        });
    }

    function agentExists(uint256 agentId) external view returns (bool) {
        return agents[agentId].owner != address(0);
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = agents[agentId].owner;
        if (owner == address(0)) revert InvalidAgent();
        return owner;
    }

    function setBanned(uint256 agentId, bool value) external {
        agents[agentId].isBanned = value;
    }

    function setSlashed(uint256 agentId, bool value) external {
        agents[agentId].isSlashed = value;
    }
}

contract NodeStakingManagerV2StrictTest is Test {
    MockStakeTokenStrict internal token;
    MockTokenRegistryStrict internal tokenRegistry;
    MockPaymasterFactoryStrict internal paymasterFactory;
    MockPriceOracleStrict internal priceOracle;
    MockStrictIdentityRegistry internal identityRegistry;
    NodeStakingManagerV2Strict internal manager;

    address internal constant PERFORMANCE_ORACLE = address(0x1234);
    address internal constant FAKE_PAYMASTER = address(0x5678);
    address internal alice = makeAddr("alice");
    uint256 internal aliceOperatorAgentId;
    uint256 internal unstakedOperatorAgentId;

    uint256 internal constant STAKE_AMOUNT = 1000 ether;
    uint256 internal constant TOKEN_PRICE_USD = 1 ether;

    function setUp() public {
        token = new MockStakeTokenStrict();
        tokenRegistry = new MockTokenRegistryStrict();
        paymasterFactory = new MockPaymasterFactoryStrict();
        priceOracle = new MockPriceOracleStrict();

        tokenRegistry.setSupported(address(token), true);
        paymasterFactory.setDeployed(address(token), true, FAKE_PAYMASTER);
        priceOracle.setPrice(address(token), TOKEN_PRICE_USD);
        priceOracle.setPrice(address(0), 3000 ether);

        manager = new NodeStakingManagerV2Strict(
            address(tokenRegistry), address(paymasterFactory), address(priceOracle), PERFORMANCE_ORACLE, address(this)
        );

        identityRegistry = new MockStrictIdentityRegistry();
        manager.setIdentityRegistry(address(identityRegistry));
        manager.setRequireAgentRegistration(true);
        identityRegistry.setRegistrarAuthorization(address(manager), true);
        aliceOperatorAgentId = identityRegistry.createAgent(alice, 2, 10 ether);
        unstakedOperatorAgentId = identityRegistry.createAgent(alice, 0, 0);

        IERC20(address(token)).transfer(alice, 100_000 ether);

        vm.startPrank(alice);
        IERC20(address(token)).approve(address(manager), type(uint256).max);
        vm.stopPrank();
    }

    function test_RegisterNodeWithAgentAndIdentity_RevertsWhenStrictProfileRequired() public {
        vm.startPrank(alice);
        vm.expectRevert(NodeStakingManagerV2Strict.StrictProfileRegistrationRequired.selector);
        manager.registerNodeWithAgentAndIdentity(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://strict.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            aliceOperatorAgentId,
            "ipfs://node-token",
            _metadata("nodeId", "placeholder")
        );
        vm.stopPrank();
    }

    function test_PreviewNextNodeId_MatchesRegistration() public {
        bytes32 preview = manager.previewNextNodeId(alice, aliceOperatorAgentId, "https://strict.jeju.test");

        vm.startPrank(alice);
        (bytes32 nodeId, uint256 nodeIdentityAgentId) = manager.registerNodeWithAgentIdentityAndProfile(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://strict.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            aliceOperatorAgentId,
            0,
            keccak256(bytes("storage|rpc")),
            "ipfs://bafybeigdyrzt5nodeprofile",
            "ipfs://bafybeigdyrzt5identity",
            _metadata("nodeId", vm.toString(preview))
        );
        vm.stopPrank();

        assertEq(nodeId, preview);
        assertEq(manager.getNodeIdentityAgentId(nodeId), nodeIdentityAgentId);
        assertEq(manager.getNodeServicesHash(nodeId), keccak256(bytes("storage|rpc")));
        assertEq(manager.getNodeMetadataURI(nodeId), "ipfs://bafybeigdyrzt5nodeprofile");
        assertEq(manager.getNextOperatorNonce(alice), 1);
        assertTrue(manager.supportsAtomicNodeIdentityRegistration());
        assertTrue(manager.supportsStrictAtomicProfileRegistration());
    }

    function test_RegisterNodeWithAgentIdentityAndProfile_RevertsForUnstakedOperator() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(NodeStakingManagerV2Strict.OperatorAgentNotStaked.selector, unstakedOperatorAgentId));
        manager.registerNodeWithAgentIdentityAndProfile(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://strict.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            unstakedOperatorAgentId,
            0,
            keccak256(bytes("storage")),
            "ipfs://bafybeigdyrzt5nodeprofile",
            "ipfs://bafybeigdyrzt5identity",
            _metadata("nodeId", "placeholder")
        );
        vm.stopPrank();
    }

    function test_RegisterNodeWithAgentIdentityAndProfile_RevertsForInvalidMetadataUri() public {
        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                NodeStakingManagerV2Strict.InvalidMetadataURI.selector, "https://example.com/node-profile.json"
            )
        );
        manager.registerNodeWithAgentIdentityAndProfile(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://strict.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            aliceOperatorAgentId,
            0,
            keccak256(bytes("storage")),
            "https://example.com/node-profile.json",
            "ipfs://bafybeigdyrzt5identity",
            _metadata("nodeId", "placeholder")
        );
        vm.stopPrank();
    }

    function test_RegisterNodeWithAgentIdentityAndProfile_RevertsForNonceMismatch() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(NodeStakingManagerV2Strict.RegistrationNonceMismatch.selector, 0, 2));
        manager.registerNodeWithAgentIdentityAndProfile(
            address(token),
            STAKE_AMOUNT,
            address(token),
            "https://strict.jeju.test",
            INodeStakingManager.Region.NorthAmerica,
            aliceOperatorAgentId,
            2,
            keccak256(bytes("storage")),
            "ipfs://bafybeigdyrzt5nodeprofile",
            "ipfs://bafybeigdyrzt5identity",
            _metadata("nodeId", "placeholder")
        );
        vm.stopPrank();
    }

    function _metadata(string memory key, string memory value)
        internal
        pure
        returns (IIdentityRegistry.MetadataEntry[] memory metadata)
    {
        metadata = new IIdentityRegistry.MetadataEntry[](1);
        metadata[0] = IIdentityRegistry.MetadataEntry({key: key, value: bytes(value)});
    }
}
