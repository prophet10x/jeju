// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {OraclePowerRegistry} from "../../src/staking/OraclePowerRegistry.sol";
import {UpgradeValidationRegistry} from "../../src/governance/UpgradeValidationRegistry.sol";
import {ProtocolUpgradeManager} from "../../src/governance/ProtocolUpgradeManager.sol";
import {GovernanceTimelock} from "../../src/governance/GovernanceTimelock.sol";

contract MockUUPSProxyTarget {
    address public implementation;
    bytes public lastData;

    function upgradeTo(address newImplementation) external {
        implementation = newImplementation;
        delete lastData;
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external {
        implementation = newImplementation;
        lastData = data;
    }
}

contract MockProxyAdmin {
    address public lastProxy;
    address public lastImplementation;
    bytes public lastData;

    function upgradeAndCall(address proxy, address implementation, bytes memory data) external {
        lastProxy = proxy;
        lastImplementation = implementation;
        lastData = data;

        (bool success,) = proxy.call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", implementation, data));
        require(success, "proxy upgrade failed");
    }
}

contract MockDirectTarget {
    uint256 public value;

    function setValue(uint256 newValue) external {
        value = newValue;
    }
}

contract ProtocolUpgradeManagerTest is Test {
    MockERC20 internal jejuToken;
    OraclePowerRegistry internal oracleRegistry;
    UpgradeValidationRegistry internal validationRegistry;
    ProtocolUpgradeManager internal manager;

    MockUUPSProxyTarget internal uupsProxy;
    MockProxyAdmin internal proxyAdmin;
    MockUUPSProxyTarget internal transparentProxy;
    MockDirectTarget internal directTarget;
    MockDirectTarget internal oldPointerTarget;
    MockDirectTarget internal newPointerTarget;

    address internal owner = address(0x100);
    address internal reporter1 = address(0x101);
    address internal reporter2 = address(0x102);
    address internal daoGovernance = address(0x103);
    address internal securityBoard = address(0x104);

    bytes32 internal constant UUPS_ID = keccak256("nodeStakingManager");
    bytes32 internal constant TRANSPARENT_ID = keccak256("crossChainPaymaster");
    bytes32 internal constant DIRECT_ID = keccak256("qosConsensusConfig");
    bytes32 internal constant POINTER_ID = keccak256("serviceRegistryPointer");

    function setUp() public {
        jejuToken = new MockERC20("Jeju", "JEJU", 18, 1_000_000 ether);

        vm.prank(owner);
        oracleRegistry = new OraclePowerRegistry(address(jejuToken), owner, 1, 1, 1);

        validationRegistry = new UpgradeValidationRegistry(address(oracleRegistry), owner, 60, 7 days, 2, 5500);
        manager = new ProtocolUpgradeManager(owner, address(validationRegistry), true);

        uupsProxy = new MockUUPSProxyTarget();
        proxyAdmin = new MockProxyAdmin();
        transparentProxy = new MockUUPSProxyTarget();
        directTarget = new MockDirectTarget();
        oldPointerTarget = new MockDirectTarget();
        newPointerTarget = new MockDirectTarget();

        vm.startPrank(owner);
        manager.configureManagedContract(UUPS_ID, address(uupsProxy), ProtocolUpgradeManager.UpgradeKind.UUPS_PROXY, address(0), true);
        manager.configureManagedContract(
            TRANSPARENT_ID,
            address(transparentProxy),
            ProtocolUpgradeManager.UpgradeKind.TRANSPARENT_PROXY,
            address(proxyAdmin),
            true
        );
        manager.configureManagedContract(
            DIRECT_ID, address(directTarget), ProtocolUpgradeManager.UpgradeKind.DIRECT_CALL, address(0), true
        );
        manager.configureManagedContract(
            POINTER_ID,
            address(oldPointerTarget),
            ProtocolUpgradeManager.UpgradeKind.REDEPLOY_AND_SWITCH,
            address(0),
            true
        );
        vm.stopPrank();

        _activateStakeWeightedModeAndFundReporters();
    }

    function test_UUPSUpgradeRequiresPassedValidation() public {
        vm.prank(owner);
        vm.expectRevert(ProtocolUpgradeManager.ValidationNotPassed.selector);
        manager.upgradeUUPS(bytes32(0), UUPS_ID, address(0xBEEF), bytes(""));

        bytes32 changeId = _approveChange("upgrade-uups");

        vm.prank(owner);
        manager.upgradeUUPS(changeId, UUPS_ID, address(0xBEEF), bytes("init-data"));

        assertEq(uupsProxy.implementation(), address(0xBEEF));
        assertEq(uupsProxy.lastData(), bytes("init-data"));
    }

    function test_TransparentUpgradeAfterValidation() public {
        bytes32 changeId = _approveChange("upgrade-transparent");

        vm.prank(owner);
        manager.upgradeTransparent(changeId, TRANSPARENT_ID, address(0xCAFE), abi.encode(uint256(123)));

        assertEq(proxyAdmin.lastProxy(), address(transparentProxy));
        assertEq(proxyAdmin.lastImplementation(), address(0xCAFE));
        assertEq(transparentProxy.implementation(), address(0xCAFE));
    }

    function test_DirectGovernanceCallAfterValidation() public {
        bytes32 changeId = _approveChange("direct-call");

        vm.prank(owner);
        manager.executeGovernanceCall(
            changeId, DIRECT_ID, 0, abi.encodeWithSelector(MockDirectTarget.setValue.selector, uint256(42))
        );

        assertEq(directTarget.value(), 42);
    }

    function test_RedeployAndSwitchAfterValidation() public {
        bytes32 changeId = _approveChange("switch-address");

        vm.prank(owner);
        manager.switchManagedAddress(changeId, POINTER_ID, address(newPointerTarget));

        (address target,,,) = manager.managedContracts(POINTER_ID);
        assertEq(target, address(newPointerTarget));
    }

    function test_TimelockGovernanceCanExecuteUpgradeManagerAction() public {
        uint256 delay = 1 hours;
        GovernanceTimelock timelock = new GovernanceTimelock(daoGovernance, securityBoard, owner, delay);

        vm.prank(owner);
        manager.transferOwnership(address(timelock));

        bytes32 changeId = _approveChange("timelock-upgrade");
        address newImplementation = address(0xABCD);

        bytes memory callData = abi.encodeWithSelector(
            manager.upgradeUUPS.selector, changeId, UUPS_ID, newImplementation, bytes("dao-init")
        );

        vm.prank(daoGovernance);
        bytes32 proposalId = timelock.proposeUpgrade(address(manager), callData, "Upgrade via manager");

        vm.warp(block.timestamp + delay + 1);
        timelock.execute(proposalId);

        assertEq(uupsProxy.implementation(), newImplementation);
        assertEq(uupsProxy.lastData(), bytes("dao-init"));
    }

    function _activateStakeWeightedModeAndFundReporters() internal {
        vm.prank(owner);
        oracleRegistry.approveBootstrapOracle(reporter1);
        vm.roll(block.number + 2);
        oracleRegistry.maybeActivateAdvancedMode();
        assertTrue(oracleRegistry.advancedMode());

        jejuToken.transfer(reporter1, 1_000 ether);
        jejuToken.transfer(reporter2, 1_000 ether);

        vm.prank(reporter1);
        jejuToken.approve(address(oracleRegistry), type(uint256).max);
        vm.prank(reporter2);
        jejuToken.approve(address(oracleRegistry), type(uint256).max);

        vm.prank(reporter1);
        oracleRegistry.stakeAsOracle(600 ether);
        vm.prank(reporter2);
        oracleRegistry.stakeAsOracle(400 ether);
    }

    function _approveChange(string memory label) internal returns (bytes32 changeId) {
        changeId = keccak256(abi.encodePacked(label, block.timestamp, block.number));

        vm.prank(owner);
        validationRegistry.startValidation(changeId, 600, string.concat("ipfs://", label));

        vm.prank(reporter1);
        validationRegistry.attest(changeId, true, keccak256("reporter1-ok"));
        vm.prank(reporter2);
        validationRegistry.attest(changeId, true, keccak256("reporter2-ok"));
    }
}
