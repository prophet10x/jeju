// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {StorageEscrowV2} from "../../src/storage/StorageEscrowV2.sol";
import {StorageProtocolTypes} from "../../src/storage/StorageProtocolTypes.sol";
import {StorageProviderRegistryV2} from "../../src/storage/StorageProviderRegistryV2.sol";
import {StorageRecoveryManagerV2} from "../../src/storage/StorageRecoveryManagerV2.sol";
import {StorageRegistryV2} from "../../src/storage/StorageRegistryV2.sol";

contract MockStoragePriceOracle is IPriceOracle {
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

contract StorageProtocolV2Test is Test {
    uint256 internal constant GIB = 1024 * 1024 * 1024;

    MockERC20 internal jeju;
    MockStoragePriceOracle internal oracle;
    StorageProviderRegistryV2 internal providerRegistry;
    StorageEscrowV2 internal escrow;
    StorageRegistryV2 internal registry;
    StorageRecoveryManagerV2 internal recoveryManager;

    address internal admin = makeAddr("admin");
    address internal registrar = makeAddr("registrar");
    address internal replicaSetter = makeAddr("replicaSetter");
    address internal repairCoordinator = makeAddr("repairCoordinator");
    address payable internal treasury = payable(makeAddr("treasury"));
    address payable internal paidProvider = payable(makeAddr("paidProvider"));
    address internal payer = makeAddr("payer");
    address internal providerOne = makeAddr("providerOne");
    address internal providerTwo = makeAddr("providerTwo");
    address internal providerThree = makeAddr("providerThree");
    address internal providerFour = makeAddr("providerFour");

    function setUp() public {
        vm.startPrank(admin);

        jeju = new MockERC20("Jeju", "JEJU", 18, 10_000_000 ether);
        oracle = new MockStoragePriceOracle();
        oracle.setPrice(address(jeju), 1 ether);
        oracle.setPrice(address(0), 3_000 ether);

        providerRegistry = new StorageProviderRegistryV2(admin, address(jeju));
        escrow = new StorageEscrowV2(admin, address(jeju), address(oracle));
        registry = new StorageRegistryV2(admin, address(providerRegistry), address(escrow));
        recoveryManager = new StorageRecoveryManagerV2(admin, address(registry));

        providerRegistry.grantRole(providerRegistry.REGISTRY_ROLE(), address(registry));
        escrow.grantRole(escrow.REGISTRY_ROLE(), address(registry));
        escrow.grantRole(escrow.REGISTRY_ROLE(), admin);
        registry.grantRole(registry.REGISTRAR_ROLE(), registrar);
        registry.grantRole(registry.REPLICA_SETTER_ROLE(), replicaSetter);
        registry.grantRole(registry.RECOVERY_MANAGER_ROLE(), address(recoveryManager));
        recoveryManager.grantRole(recoveryManager.REPAIR_COORDINATOR_ROLE(), repairCoordinator);

        vm.stopPrank();

        _registerProvider(providerOne);
        _registerProvider(providerTwo);
        _registerProvider(providerThree);
        _registerProvider(providerFour);
        _registerProvider(paidProvider);

        vm.prank(admin);
        jeju.transfer(payer, 1_000_000 ether);
        vm.prank(payer);
        jeju.approve(address(escrow), type(uint256).max);
    }

    function test_ReservePaidStorageLocksPaymentAndProviderCapacity() public {
        StorageProtocolTypes.StorageRegistrationInput memory input = _input(
            StorageProtocolTypes.StorageAccessClass.PRIVATE_OWNER,
            payer,
            2 * GIB,
            125 ether
        );

        address[] memory replicas = _replicas();

        vm.prank(registrar);
        bytes32 contentId = registry.reservePaidStorage(input, replicas, address(jeju), 125 ether);

        StorageProtocolTypes.StorageRecord memory record = registry.getRecord(contentId);
        assertEq(uint8(record.accessClass), uint8(StorageProtocolTypes.StorageAccessClass.PRIVATE_OWNER));
        assertEq(record.owner, payer);
        assertEq(record.paymentAsset, address(jeju));
        assertEq(record.paymentAssetAmount, 125 ether);
        assertEq(record.auditChunkSize, 1024 * 1024);
        assertEq(record.minReplicas, 4);
        assertEq(record.targetReplicas, 4);

        StorageEscrowV2.PaymentReservation memory reservation = escrow.getReservation(contentId);
        assertEq(reservation.payer, payer);
        assertEq(reservation.asset, address(jeju));
        assertEq(reservation.assetAmount, 125 ether);
        assertEq(reservation.usdValueLocked, 125 ether);

        assertEq(providerRegistry.getProvider(providerOne).reservedCapacityBytes, 2 * GIB);
        assertEq(providerRegistry.getProvider(providerTwo).reservedCapacityBytes, 2 * GIB);
    }

    function test_ReserveProviderSelfUseLocksAndUnlocksCreditsOnDelete() public {
        StorageProtocolTypes.StorageRegistrationInput memory input = _input(
            StorageProtocolTypes.StorageAccessClass.SYSTEM_PUBLIC,
            providerOne,
            1 * GIB,
            0
        );

        address[] memory replicas = _replicas();

        vm.prank(registrar);
        bytes32 contentId = registry.reserveProviderSelfUse(input, replicas, providerOne);

        StorageProtocolTypes.ProviderAccount memory providerBeforeDelete = providerRegistry.getProvider(providerOne);
        assertEq(providerBeforeDelete.selfUseCreditsLockedBytes, 4 * GIB);
        assertEq(providerBeforeDelete.reservedCapacityBytes, 5 * GIB);

        vm.prank(registrar);
        registry.deleteContent(contentId);

        StorageProtocolTypes.ProviderAccount memory providerAfterDelete = providerRegistry.getProvider(providerOne);
        assertEq(providerAfterDelete.selfUseCreditsLockedBytes, 0);
        assertEq(providerAfterDelete.reservedCapacityBytes, 0);
    }

    function test_ReleaseReservationPaysProviderAndTreasury() public {
        bytes32 contentId = keccak256("settlement-content");

        vm.prank(payer);
        jeju.approve(address(escrow), 200 ether);

        vm.prank(admin);
        escrow.lockReservationPayment(contentId, payer, address(jeju), 200 ether, 150 ether);

        uint256 providerBalanceBefore = jeju.balanceOf(paidProvider);
        uint256 treasuryBalanceBefore = jeju.balanceOf(treasury);

        vm.prank(admin);
        escrow.releaseToProvider(contentId, paidProvider, 180 ether, treasury, 20 ether);

        assertEq(jeju.balanceOf(paidProvider) - providerBalanceBefore, 180 ether);
        assertEq(jeju.balanceOf(treasury) - treasuryBalanceBefore, 20 ether);
    }

    function test_RepairFlowRotatesKeyEpochAndUpdatesManifest() public {
        StorageProtocolTypes.StorageRegistrationInput memory input = _input(
            StorageProtocolTypes.StorageAccessClass.MANAGED_EXECUTION,
            payer,
            3 * GIB,
            300 ether
        );

        address[] memory replicas = _replicas();

        vm.prank(registrar);
        bytes32 contentId = registry.reservePaidStorage(input, replicas, address(jeju), 300 ether);

        vm.prank(replicaSetter);
        registry.activateReservedContent(contentId, keccak256("replica-set-v1"));

        vm.prank(repairCoordinator);
        recoveryManager.openRepair(contentId, uint64(block.timestamp + 1 days), 25 ether, makeAddr("repairer"));

        vm.prank(repairCoordinator);
        recoveryManager.updateRepairPlan(
            contentId,
            keccak256("manifest-v2"),
            keccak256("plaintext-v2"),
            "ipfs://manifest-v2",
            keccak256("replica-set-v2"),
            true
        );

        vm.prank(repairCoordinator);
        recoveryManager.submitRepair(contentId, replicas);

        StorageProtocolTypes.StorageRecord memory record = registry.getRecord(contentId);
        assertEq(uint8(record.state), uint8(StorageProtocolTypes.StorageRecordState.ACTIVE));
        assertEq(record.keyEpoch, 2);
        assertEq(record.manifestHash, keccak256("manifest-v2"));
        assertEq(record.plaintextRoot, keccak256("plaintext-v2"));
        assertEq(record.replicaSetHash, keccak256("replica-set-v2"));
        assertEq(record.ciphertextManifestUri, "ipfs://manifest-v2");

        StorageProtocolTypes.RepairTicket memory ticket = recoveryManager.getRepairTicket(contentId);
        assertFalse(ticket.active);
        assertEq(ticket.rekeyNonce, 1);
    }

    function _registerProvider(address provider) internal {
        vm.deal(provider, 100 ether);
        vm.prank(provider);
        providerRegistry.registerProvider{value: 5 ether}(
            100 * GIB,
            1 ether,
            true,
            true,
            1000,
            3300,
            string.concat("ipfs://provider-", vm.toString(provider))
        );
    }

    function _replicas() internal view returns (address[] memory replicas) {
        replicas = new address[](4);
        replicas[0] = providerOne;
        replicas[1] = providerTwo;
        replicas[2] = providerThree;
        replicas[3] = providerFour;
    }

    function _input(
        StorageProtocolTypes.StorageAccessClass accessClass,
        address owner,
        uint256 sizeBytes,
        uint256 paymentUsdQuote
    ) internal pure returns (StorageProtocolTypes.StorageRegistrationInput memory) {
        return StorageProtocolTypes.StorageRegistrationInput({
            accessClass: accessClass,
            owner: owner,
            manifestHash: keccak256("manifest-v1"),
            plaintextRoot: keccak256("plaintext-v1"),
            ciphertextManifestUri: "ipfs://manifest-v1",
            minReplicas: 4,
            targetReplicas: 4,
            auditChunkSize: 0,
            sizeBytes: sizeBytes,
            paymentUsdQuote: paymentUsdQuote,
            repairBountyUsd: 25 ether
        });
    }
}
