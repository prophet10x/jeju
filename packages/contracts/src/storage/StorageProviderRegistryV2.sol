// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StorageProtocolTypes} from "./StorageProtocolTypes.sol";

contract StorageProviderRegistryV2 is AccessControl, ReentrancyGuard {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");
    bytes32 public constant SLASH_ORACLE_ROLE = keccak256("SLASH_ORACLE_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_SYSTEM_RESERVE_BPS = 5_000;
    uint16 public constant MAX_SLASH_COVERAGE_BPS = 5_000;

    address public immutable JEJU_TOKEN;

    mapping(address => StorageProtocolTypes.ProviderAccount) private _providers;
    address[] private _providerList;

    event ProviderRegistered(address indexed provider, uint256 stakeWei, uint256 declaredCapacityBytes);
    event ProviderQuoteUpdated(
        address indexed provider,
        uint256 priceUsdPerGiBDay,
        bool acceptsJeju,
        bool acceptsEth,
        uint16 systemReserveBps,
        uint16 slashCoverageBps
    );
    event ProviderMetadataURIUpdated(address indexed provider, string metadataURI);
    event ProviderCapacityUpdated(address indexed provider, uint256 declaredCapacityBytes);
    event ProviderStakeIncreased(address indexed provider, uint256 amountWei, uint256 newStakeWei);
    event ProviderActiveUpdated(address indexed provider, bool active);
    event ProviderCapacityLocked(
        address indexed provider, uint256 amountBytes, bool selfUse, uint256 reservedCapacityBytes
    );
    event ProviderCapacityUnlocked(
        address indexed provider, uint256 amountBytes, bool selfUse, uint256 reservedCapacityBytes
    );
    event ProviderSlashed(address indexed provider, uint256 slashAmountWei, uint256 slashCoverageIncreaseWei);

    error InvalidAddress();
    error InvalidCapacity();
    error InvalidQuote();
    error ProviderAlreadyRegistered();
    error ProviderNotRegistered();
    error ProviderInactive(address provider);
    error UnsupportedSettlementAsset(address provider, address asset);
    error InsufficientAvailableCapacity(address provider, uint256 requested, uint256 available);
    error InsufficientLockedSelfUseCredits(address provider, uint256 requested, uint256 available);
    error InsufficientStake(address provider, uint256 requested, uint256 available);

    constructor(address admin, address jejuTokenAddress) {
        if (admin == address(0) || jejuTokenAddress == address(0)) revert InvalidAddress();
        JEJU_TOKEN = jejuTokenAddress;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        _grantRole(SLASH_ORACLE_ROLE, admin);
    }

    function registerProvider(
        uint256 declaredCapacityBytes,
        uint256 priceUsdPerGiBDay,
        bool acceptsJeju,
        bool acceptsEth,
        uint16 systemReserveBps,
        uint16 slashCoverageBps,
        string calldata metadataURI
    ) external payable nonReentrant {
        if (_providers[msg.sender].owner != address(0)) revert ProviderAlreadyRegistered();
        if (declaredCapacityBytes == 0) revert InvalidCapacity();
        _validateQuote(priceUsdPerGiBDay, acceptsJeju, acceptsEth, systemReserveBps, slashCoverageBps);

        _providers[msg.sender] = StorageProtocolTypes.ProviderAccount({
            owner: msg.sender,
            stakeWei: msg.value,
            declaredCapacityBytes: declaredCapacityBytes,
            reservedCapacityBytes: 0,
            selfUseCreditsLockedBytes: 0,
            slashCoverageBalanceWei: 0,
            metadataURI: metadataURI,
            quote: StorageProtocolTypes.ProviderQuote({
                priceUsdPerGiBDay: priceUsdPerGiBDay,
                acceptsJeju: acceptsJeju,
                acceptsEth: acceptsEth,
                systemReserveBps: systemReserveBps,
                slashCoverageBps: slashCoverageBps
            }),
            active: true
        });

        _providerList.push(msg.sender);
        emit ProviderRegistered(msg.sender, msg.value, declaredCapacityBytes);
        emit ProviderQuoteUpdated(msg.sender, priceUsdPerGiBDay, acceptsJeju, acceptsEth, systemReserveBps, slashCoverageBps);
        if (bytes(metadataURI).length > 0) {
            emit ProviderMetadataURIUpdated(msg.sender, metadataURI);
        }
    }

    function updateQuote(
        uint256 priceUsdPerGiBDay,
        bool acceptsJeju,
        bool acceptsEth,
        uint16 systemReserveBps,
        uint16 slashCoverageBps
    ) external {
        StorageProtocolTypes.ProviderAccount storage provider = _getProvider(msg.sender);
        _validateQuote(priceUsdPerGiBDay, acceptsJeju, acceptsEth, systemReserveBps, slashCoverageBps);

        provider.quote = StorageProtocolTypes.ProviderQuote({
            priceUsdPerGiBDay: priceUsdPerGiBDay,
            acceptsJeju: acceptsJeju,
            acceptsEth: acceptsEth,
            systemReserveBps: systemReserveBps,
            slashCoverageBps: slashCoverageBps
        });

        emit ProviderQuoteUpdated(msg.sender, priceUsdPerGiBDay, acceptsJeju, acceptsEth, systemReserveBps, slashCoverageBps);
    }

    function updateDeclaredCapacity(uint256 declaredCapacityBytes) external {
        StorageProtocolTypes.ProviderAccount storage provider = _getProvider(msg.sender);
        if (declaredCapacityBytes == 0 || declaredCapacityBytes < provider.reservedCapacityBytes) revert InvalidCapacity();
        provider.declaredCapacityBytes = declaredCapacityBytes;
        emit ProviderCapacityUpdated(msg.sender, declaredCapacityBytes);
    }

    function updateMetadataURI(string calldata metadataURI) external {
        StorageProtocolTypes.ProviderAccount storage provider = _getProvider(msg.sender);
        provider.metadataURI = metadataURI;
        emit ProviderMetadataURIUpdated(msg.sender, metadataURI);
    }

    function increaseStake() external payable nonReentrant {
        StorageProtocolTypes.ProviderAccount storage provider = _getProvider(msg.sender);
        provider.stakeWei += msg.value;
        emit ProviderStakeIncreased(msg.sender, msg.value, provider.stakeWei);
    }

    function setProviderActive(address provider, bool active) external onlyRole(GOVERNANCE_ROLE) {
        StorageProtocolTypes.ProviderAccount storage account = _getProvider(provider);
        account.active = active;
        emit ProviderActiveUpdated(provider, active);
    }

    function lockCapacity(address provider, uint256 amountBytes, bool selfUse) external onlyRole(REGISTRY_ROLE) {
        StorageProtocolTypes.ProviderAccount storage account = _getProvider(provider);
        if (!account.active) revert ProviderInactive(provider);
        uint256 available = availableCapacityBytes(provider);
        if (available < amountBytes) revert InsufficientAvailableCapacity(provider, amountBytes, available);

        account.reservedCapacityBytes += amountBytes;
        if (selfUse) {
            account.selfUseCreditsLockedBytes += amountBytes;
        }

        emit ProviderCapacityLocked(provider, amountBytes, selfUse, account.reservedCapacityBytes);
    }

    function unlockCapacity(address provider, uint256 amountBytes, bool selfUse) external onlyRole(REGISTRY_ROLE) {
        StorageProtocolTypes.ProviderAccount storage account = _getProvider(provider);
        if (amountBytes > account.reservedCapacityBytes) {
            amountBytes = account.reservedCapacityBytes;
        }
        account.reservedCapacityBytes -= amountBytes;

        if (selfUse) {
            uint256 locked = account.selfUseCreditsLockedBytes;
            if (amountBytes > locked) revert InsufficientLockedSelfUseCredits(provider, amountBytes, locked);
            account.selfUseCreditsLockedBytes = locked - amountBytes;
        }

        emit ProviderCapacityUnlocked(provider, amountBytes, selfUse, account.reservedCapacityBytes);
    }

    function slashProvider(address provider, uint256 slashAmountWei) external onlyRole(SLASH_ORACLE_ROLE) {
        StorageProtocolTypes.ProviderAccount storage account = _getProvider(provider);
        if (slashAmountWei > account.stakeWei) revert InsufficientStake(provider, slashAmountWei, account.stakeWei);

        account.stakeWei -= slashAmountWei;
        uint256 coverageIncrease = (slashAmountWei * account.quote.slashCoverageBps) / BPS_DENOMINATOR;
        account.slashCoverageBalanceWei += coverageIncrease;

        emit ProviderSlashed(provider, slashAmountWei, coverageIncrease);
    }

    function getProvider(address provider) external view returns (StorageProtocolTypes.ProviderAccount memory) {
        return _getProvider(provider);
    }

    function listProviders() external view returns (address[] memory) {
        return _providerList;
    }

    function isActive(address provider) external view returns (bool) {
        return _getProvider(provider).active;
    }

    function supportsSettlementAsset(address provider, address asset) public view returns (bool) {
        StorageProtocolTypes.ProviderAccount storage account = _providers[provider];
        if (account.owner == address(0)) return false;
        if (asset == address(0)) return account.quote.acceptsEth;
        if (asset == JEJU_TOKEN) return account.quote.acceptsJeju;
        return false;
    }

    function assertSettlementAssetSupported(address provider, address asset) external view {
        if (!supportsSettlementAsset(provider, asset)) revert UnsupportedSettlementAsset(provider, asset);
    }

    function availableCapacityBytes(address provider) public view returns (uint256) {
        StorageProtocolTypes.ProviderAccount storage account = _providers[provider];
        if (account.owner == address(0)) return 0;
        return account.declaredCapacityBytes - account.reservedCapacityBytes;
    }

    function _getProvider(address provider) internal view returns (StorageProtocolTypes.ProviderAccount storage account) {
        account = _providers[provider];
        if (account.owner == address(0)) revert ProviderNotRegistered();
    }

    function _validateQuote(
        uint256 priceUsdPerGiBDay,
        bool acceptsJeju,
        bool acceptsEth,
        uint16 systemReserveBps,
        uint16 slashCoverageBps
    ) internal pure {
        if (priceUsdPerGiBDay == 0 || (!acceptsJeju && !acceptsEth)) revert InvalidQuote();
        if (systemReserveBps > MAX_SYSTEM_RESERVE_BPS || slashCoverageBps > MAX_SLASH_COVERAGE_BPS) {
            revert InvalidQuote();
        }
    }
}
