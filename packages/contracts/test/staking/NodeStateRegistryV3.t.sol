// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {INodeManagerModule} from "../../src/staking/interfaces/INodeManagerModule.sol";
import {INodeMigrationHandler} from "../../src/staking/interfaces/INodeMigrationHandler.sol";
import {ITokenRegistry} from "../../src/interfaces/IPaymaster.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {NodeManagerRouter} from "../../src/staking/NodeManagerRouter.sol";
import {NodeStakeVault} from "../../src/staking/NodeStakeVault.sol";
import {NodeStateRegistry} from "../../src/staking/NodeStateRegistry.sol";
import {NodeStateTypes} from "../../src/staking/libraries/NodeStateTypes.sol";
import {NodeManagerV3} from "../../src/staking/modules/NodeManagerV3.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {
        _mint(msg.sender, 10_000_000 ether);
    }
}

contract MockTokenRegistry is ITokenRegistry {
    mapping(address => bool) public supported;

    function setSupported(address token, bool isSupported) external {
        supported[token] = isSupported;
    }

    function isSupported(address token) external view returns (bool) {
        return supported[token];
    }
}

contract MockPriceOracle is IPriceOracle {
    mapping(address => uint256) public prices;

    function setPrice(address token, uint256 price) external {
        prices[token] = price;
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
        require(fromPrice > 0 && toPrice > 0, "missing price");
        return (amount * fromPrice) / toPrice;
    }
}

contract MockModuleV4 is INodeManagerModule {
    function version() external pure returns (uint16) {
        return 4;
    }

    function registerNode(address, address, uint256, address, string calldata, uint8) external pure returns (bytes32) {
        revert("unused");
    }

    function registerNodeWithAgent(address, address, uint256, address, string calldata, uint8, uint256)
        external
        pure
        returns (bytes32)
    {
        revert("unused");
    }

    function increaseStake(address, bytes32, uint256) external pure {}

    function updateNodeConfig(address, bytes32, string calldata, uint8) external pure {}

    function updateNodeServices(address, bytes32, bytes32) external pure {}

    function setNodeMetadataURI(address, bytes32, string calldata) external pure {}

    function claimRewards(address, bytes32) external pure returns (uint256 rewardsUSD) {
        return 0;
    }

    function deregisterNode(address, bytes32) external pure returns (uint256 unstakedAmount) {
        return 0;
    }
}

contract MockMigrationHandlerV4 is INodeMigrationHandler {
    NodeStateRegistry public immutable registry;

    constructor(address registryAddress) {
        registry = NodeStateRegistry(registryAddress);
    }

    function getStepCount(bytes32, uint16 fromVersion, uint16 targetVersion) external pure returns (uint256) {
        require(fromVersion == 3 && targetVersion == 4, "bad versions");
        return 3;
    }

    function runStep(bytes32 nodeId, uint16 fromVersion, uint16 targetVersion, uint256 stepIndex) external {
        require(msg.sender == address(registry), "registry only");
        require(fromVersion == 3 && targetVersion == 4, "bad versions");

        NodeStateTypes.MigrationPatch memory patch;
        if (stepIndex == 0) {
            patch.updateServicesHash = true;
            patch.servicesHash = keccak256("v4-services");
        } else if (stepIndex == 1) {
            patch.updateMetadataURI = true;
            patch.metadataURI = "ipfs://node-v4-metadata";
        } else if (stepIndex == 2) {
            patch.updateRegion = true;
            patch.region = 2; // Europe
        }

        registry.applyMigrationPatch(nodeId, patch);
    }
}

contract NodeStateRegistryV3Test is Test {
    MockToken internal token;
    MockTokenRegistry internal tokenRegistry;
    MockPriceOracle internal priceOracle;
    NodeStakeVault internal vault;
    NodeStateRegistry internal registry;
    NodeManagerRouter internal router;
    NodeManagerV3 internal moduleV3;
    MockModuleV4 internal moduleV4;
    MockMigrationHandlerV4 internal migrationV4;

    address internal alice = makeAddr("alice");

    function setUp() public {
        token = new MockToken();
        tokenRegistry = new MockTokenRegistry();
        priceOracle = new MockPriceOracle();
        tokenRegistry.setSupported(address(token), true);
        priceOracle.setPrice(address(token), 1 ether);

        vault = new NodeStakeVault(address(this), address(this));
        registry = new NodeStateRegistry(address(this), address(vault));
        router = new NodeManagerRouter(address(registry), 3, address(this));
        moduleV3 = new NodeManagerV3(
            address(router), address(this), address(registry), address(tokenRegistry), address(priceOracle)
        );

        vault.grantRole(vault.REGISTRY_ROLE(), address(registry));
        vault.revokeRole(vault.REGISTRY_ROLE(), address(this));
        registry.registerModule(3, address(moduleV3), address(0), true);

        moduleV4 = new MockModuleV4();
        migrationV4 = new MockMigrationHandlerV4(address(registry));
        registry.registerModule(4, address(moduleV4), address(migrationV4), true);

        token.transfer(alice, 100_000 ether);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
    }

    function test_registerNodeRoutesThroughRegistryAndVault() public {
        vm.prank(alice);
        bytes32 nodeId =
            router.registerNode(address(token), 20_000 ether, address(token), "https://node-a.jeju.test", 0);

        NodeStateTypes.NodeState memory state = registry.getNodeState(nodeId);
        assertEq(state.operator, alice);
        assertEq(state.stakedAmount, 20_000 ether);
        assertEq(state.stakedValueUSD, 20_000 ether);
        assertEq(state.stateVersion, 3);
        assertEq(state.region, 0);
        assertEq(token.balanceOf(address(vault)), 20_000 ether);

        bytes32[] memory operatorNodes = registry.getOperatorNodes(alice);
        assertEq(operatorNodes.length, 1);
        assertEq(operatorNodes[0], nodeId);
    }

    function test_upgradeNodeVersionIsResumable() public {
        vm.prank(alice);
        bytes32 nodeId = router.registerNode(address(token), 1_000 ether, address(token), "https://node-b.jeju.test", 0);

        vm.prank(alice);
        registry.upgradeNodeVersion(nodeId, 4, 1);

        NodeStateTypes.MigrationCursor memory cursorAfterOneStep = registry.getMigrationCursor(nodeId);
        assertTrue(cursorAfterOneStep.active);
        assertEq(cursorAfterOneStep.fromVersion, 3);
        assertEq(cursorAfterOneStep.targetVersion, 4);
        assertEq(cursorAfterOneStep.nextStep, 1);

        vm.prank(alice);
        registry.upgradeNodeVersion(nodeId, 4, 0);

        NodeStateTypes.NodeState memory upgraded = registry.getNodeState(nodeId);
        NodeStateTypes.MigrationCursor memory cursorFinal = registry.getMigrationCursor(nodeId);
        assertEq(upgraded.stateVersion, 4);
        assertFalse(upgraded.upgradeLocked);
        assertEq(upgraded.servicesHash, keccak256("v4-services"));
        assertEq(upgraded.metadataURI, "ipfs://node-v4-metadata");
        assertEq(upgraded.region, 2);
        assertFalse(cursorFinal.active);
    }
}
