// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

contract StorageEscrowV2 is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");

    address public immutable JEJU_TOKEN;
    IPriceOracle public immutable PRICE_ORACLE;

    struct PaymentReservation {
        bytes32 contentId;
        address payer;
        address asset;
        uint256 assetAmount;
        uint256 usdQuote;
        uint256 usdValueLocked;
        bool settled;
    }

    mapping(bytes32 => PaymentReservation) private _reservations;

    event ReservationLocked(
        bytes32 indexed contentId,
        address indexed payer,
        address indexed asset,
        uint256 assetAmount,
        uint256 usdQuote,
        uint256 usdValueLocked
    );
    event ReservationReleased(
        bytes32 indexed contentId, address indexed provider, uint256 providerAmount, address treasury, uint256 feeAmount
    );
    event ReservationRefunded(bytes32 indexed contentId, address indexed recipient, uint256 amount);

    error InvalidAddress();
    error ReservationAlreadyExists(bytes32 contentId);
    error ReservationMissing(bytes32 contentId);
    error ReservationAlreadySettled(bytes32 contentId);
    error InvalidPaymentAmount();
    error InsufficientUsdValue(uint256 required, uint256 provided);
    error UnsupportedAsset(address asset);

    constructor(address admin, address jejuTokenAddress, address priceOracleAddress) {
        if (admin == address(0) || jejuTokenAddress == address(0) || priceOracleAddress == address(0)) {
            revert InvalidAddress();
        }

        JEJU_TOKEN = jejuTokenAddress;
        PRICE_ORACLE = IPriceOracle(priceOracleAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    function lockReservationPayment(
        bytes32 contentId,
        address payer,
        address asset,
        uint256 assetAmount,
        uint256 usdQuote
    ) external payable onlyRole(REGISTRY_ROLE) nonReentrant {
        if (payer == address(0)) revert InvalidAddress();
        if (_reservations[contentId].payer != address(0)) revert ReservationAlreadyExists(contentId);
        if (assetAmount == 0 || usdQuote == 0) revert InvalidPaymentAmount();

        uint256 usdValueLocked = _collectFunds(payer, asset, assetAmount);
        if (usdValueLocked < usdQuote) revert InsufficientUsdValue(usdQuote, usdValueLocked);

        _reservations[contentId] = PaymentReservation({
            contentId: contentId,
            payer: payer,
            asset: asset,
            assetAmount: assetAmount,
            usdQuote: usdQuote,
            usdValueLocked: usdValueLocked,
            settled: false
        });

        emit ReservationLocked(contentId, payer, asset, assetAmount, usdQuote, usdValueLocked);
    }

    function releaseToProvider(
        bytes32 contentId,
        address payable provider,
        uint256 providerAmount,
        address payable treasury,
        uint256 feeAmount
    ) external onlyRole(REGISTRY_ROLE) nonReentrant {
        PaymentReservation storage reservation = _getReservation(contentId);
        if (provider == address(0)) revert InvalidAddress();
        if (providerAmount + feeAmount > reservation.assetAmount) revert InvalidPaymentAmount();

        reservation.settled = true;

        _payout(reservation.asset, provider, providerAmount);
        if (feeAmount > 0 && treasury != address(0)) {
            _payout(reservation.asset, treasury, feeAmount);
        }

        emit ReservationReleased(contentId, provider, providerAmount, treasury, feeAmount);
    }

    function refundReservation(bytes32 contentId, address payable recipient) external onlyRole(REGISTRY_ROLE) nonReentrant {
        PaymentReservation storage reservation = _getReservation(contentId);
        if (recipient == address(0)) revert InvalidAddress();
        reservation.settled = true;
        _payout(reservation.asset, recipient, reservation.assetAmount);
        emit ReservationRefunded(contentId, recipient, reservation.assetAmount);
    }

    function getReservation(bytes32 contentId) external view returns (PaymentReservation memory) {
        return _getReservation(contentId);
    }

    function quoteUsdValue(address asset, uint256 assetAmount) public view returns (uint256) {
        if (asset != address(0) && asset != JEJU_TOKEN) revert UnsupportedAsset(asset);
        (uint256 price, uint256 priceDecimals) = PRICE_ORACLE.getPrice(asset);
        if (price == 0) revert UnsupportedAsset(asset);
        return (assetAmount * price) / (10 ** priceDecimals);
    }

    function _collectFunds(address payer, address asset, uint256 assetAmount) internal returns (uint256 usdValueLocked) {
        if (asset == address(0)) {
            if (msg.value != assetAmount) revert InvalidPaymentAmount();
        } else {
            if (msg.value != 0) revert InvalidPaymentAmount();
            IERC20(asset).safeTransferFrom(payer, address(this), assetAmount);
        }

        usdValueLocked = quoteUsdValue(asset, assetAmount);
    }

    function _payout(address asset, address payable recipient, uint256 amount) internal {
        if (amount == 0) {
            return;
        }

        if (asset == address(0)) {
            (bool success,) = recipient.call{value: amount}("");
            require(success, "ETH_TRANSFER_FAILED");
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
    }

    function _getReservation(bytes32 contentId) internal view returns (PaymentReservation storage reservation) {
        reservation = _reservations[contentId];
        if (reservation.payer == address(0)) revert ReservationMissing(contentId);
        if (reservation.settled) revert ReservationAlreadySettled(contentId);
    }
}
