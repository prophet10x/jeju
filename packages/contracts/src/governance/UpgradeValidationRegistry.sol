// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OraclePowerRegistry} from "../staking/OraclePowerRegistry.sol";

/**
 * @title UpgradeValidationRegistry
 * @notice Stake-weighted QoSV attestation gate for protocol upgrades
 * @dev A change passes when support reaches both:
 *      1) minimum distinct reporters (m-of-n), and
 *      2) support weight >= supportThresholdBps of snapshot total weight.
 */
contract UpgradeValidationRegistry is Ownable {
    struct Validation {
        uint256 createdAt;
        uint256 expiresAt;
        uint256 snapshotTotalWeight;
        uint256 supportWeight;
        uint256 rejectWeight;
        uint256 supportCount;
        uint256 rejectCount;
        uint256 minimumReporterCount;
        uint256 supportThresholdBps;
        bool finalized;
        bool passed;
        string metadataURI;
    }

    OraclePowerRegistry public oracleRegistry;

    uint256 public minValidationDuration;
    uint256 public maxValidationDuration;
    uint256 public defaultMinimumReporterCount;
    uint256 public defaultSupportThresholdBps;

    mapping(bytes32 => Validation) private _validations;
    mapping(bytes32 => mapping(address => bool)) public hasAttested;
    mapping(bytes32 => mapping(address => bool)) public attestedSupport;
    mapping(bytes32 => mapping(address => bytes32)) public attestationDigest;

    event OracleRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ValidationConfigUpdated(
        uint256 oldMinDuration,
        uint256 newMinDuration,
        uint256 oldMaxDuration,
        uint256 newMaxDuration,
        uint256 oldMinReporterCount,
        uint256 newMinReporterCount,
        uint256 oldSupportThresholdBps,
        uint256 newSupportThresholdBps
    );
    event ValidationStarted(
        bytes32 indexed changeId,
        uint256 expiresAt,
        uint256 snapshotTotalWeight,
        uint256 minimumReporterCount,
        uint256 supportThresholdBps,
        string metadataURI
    );
    event ValidationAttested(
        bytes32 indexed changeId,
        address indexed reporter,
        bool support,
        uint256 reporterWeight,
        bytes32 digest
    );
    event ValidationFinalized(bytes32 indexed changeId, bool passed, bool earlyFinalized);

    error InvalidAddress();
    error InvalidConfig();
    error ValidationAlreadyExists();
    error ValidationNotFound();
    error ValidationAlreadyFinalized();
    error ValidationExpired();
    error ValidationStillActive();
    error StakeWeightedModeRequired();
    error NotEligibleReporter();
    error AlreadyAttested();
    error ValidationNotPassed();

    constructor(
        address _oracleRegistry,
        address initialOwner,
        uint256 _minValidationDuration,
        uint256 _maxValidationDuration,
        uint256 _defaultMinimumReporterCount,
        uint256 _defaultSupportThresholdBps
    ) Ownable(initialOwner) {
        if (_oracleRegistry == address(0)) revert InvalidAddress();
        if (
            _minValidationDuration == 0 || _maxValidationDuration < _minValidationDuration
                || _defaultMinimumReporterCount == 0 || _defaultSupportThresholdBps <= 5000
                || _defaultSupportThresholdBps > 10_000
        ) revert InvalidConfig();

        oracleRegistry = OraclePowerRegistry(_oracleRegistry);
        minValidationDuration = _minValidationDuration;
        maxValidationDuration = _maxValidationDuration;
        defaultMinimumReporterCount = _defaultMinimumReporterCount;
        defaultSupportThresholdBps = _defaultSupportThresholdBps;
    }

    function setOracleRegistry(address newOracleRegistry) external onlyOwner {
        if (newOracleRegistry == address(0)) revert InvalidAddress();
        address oldRegistry = address(oracleRegistry);
        oracleRegistry = OraclePowerRegistry(newOracleRegistry);
        emit OracleRegistryUpdated(oldRegistry, newOracleRegistry);
    }

    function setValidationConfig(
        uint256 newMinValidationDuration,
        uint256 newMaxValidationDuration,
        uint256 newDefaultMinimumReporterCount,
        uint256 newDefaultSupportThresholdBps
    ) external onlyOwner {
        if (
            newMinValidationDuration == 0 || newMaxValidationDuration < newMinValidationDuration
                || newDefaultMinimumReporterCount == 0 || newDefaultSupportThresholdBps <= 5000
                || newDefaultSupportThresholdBps > 10_000
        ) revert InvalidConfig();

        emit ValidationConfigUpdated(
            minValidationDuration,
            newMinValidationDuration,
            maxValidationDuration,
            newMaxValidationDuration,
            defaultMinimumReporterCount,
            newDefaultMinimumReporterCount,
            defaultSupportThresholdBps,
            newDefaultSupportThresholdBps
        );

        minValidationDuration = newMinValidationDuration;
        maxValidationDuration = newMaxValidationDuration;
        defaultMinimumReporterCount = newDefaultMinimumReporterCount;
        defaultSupportThresholdBps = newDefaultSupportThresholdBps;
    }

    function startValidation(bytes32 changeId, uint256 durationSeconds, string calldata metadataURI) external onlyOwner {
        _startValidation(
            changeId, durationSeconds, defaultMinimumReporterCount, defaultSupportThresholdBps, metadataURI
        );
    }

    function startValidationWithConfig(
        bytes32 changeId,
        uint256 durationSeconds,
        uint256 minimumReporterCount,
        uint256 supportThresholdBps,
        string calldata metadataURI
    ) external onlyOwner {
        _startValidation(changeId, durationSeconds, minimumReporterCount, supportThresholdBps, metadataURI);
    }

    function attest(bytes32 changeId, bool support, bytes32 digest) external {
        Validation storage validation = _validations[changeId];
        if (validation.createdAt == 0) revert ValidationNotFound();
        if (validation.finalized) revert ValidationAlreadyFinalized();
        if (block.timestamp > validation.expiresAt) revert ValidationExpired();
        if (hasAttested[changeId][msg.sender]) revert AlreadyAttested();

        uint256 reporterWeight = _requireEligibleReporter(msg.sender);

        hasAttested[changeId][msg.sender] = true;
        attestedSupport[changeId][msg.sender] = support;
        attestationDigest[changeId][msg.sender] = digest;

        if (support) {
            validation.supportWeight += reporterWeight;
            validation.supportCount += 1;
        } else {
            validation.rejectWeight += reporterWeight;
            validation.rejectCount += 1;
        }

        emit ValidationAttested(changeId, msg.sender, support, reporterWeight, digest);

        if (_meetsPassThreshold(validation)) {
            _finalize(changeId, true, true);
        }
    }

    function finalize(bytes32 changeId) external returns (bool passed) {
        Validation storage validation = _validations[changeId];
        if (validation.createdAt == 0) revert ValidationNotFound();
        if (validation.finalized) revert ValidationAlreadyFinalized();

        if (block.timestamp <= validation.expiresAt && !_meetsPassThreshold(validation)) {
            revert ValidationStillActive();
        }

        passed = _meetsPassThreshold(validation);
        _finalize(changeId, passed, block.timestamp <= validation.expiresAt);
    }

    function isValidationPassed(bytes32 changeId) external view returns (bool) {
        Validation storage validation = _validations[changeId];
        return validation.finalized && validation.passed;
    }

    function getValidation(bytes32 changeId)
        external
        view
        returns (
            uint256 createdAt,
            uint256 expiresAt,
            uint256 snapshotTotalWeight,
            uint256 supportWeight,
            uint256 rejectWeight,
            uint256 supportCount,
            uint256 rejectCount,
            uint256 minimumReporterCount,
            uint256 supportThresholdBps,
            bool finalized,
            bool passed,
            string memory metadataURI
        )
    {
        Validation storage validation = _validations[changeId];
        if (validation.createdAt == 0) revert ValidationNotFound();

        return (
            validation.createdAt,
            validation.expiresAt,
            validation.snapshotTotalWeight,
            validation.supportWeight,
            validation.rejectWeight,
            validation.supportCount,
            validation.rejectCount,
            validation.minimumReporterCount,
            validation.supportThresholdBps,
            validation.finalized,
            validation.passed,
            validation.metadataURI
        );
    }

    function requireValidationPassed(bytes32 changeId) external view {
        Validation storage validation = _validations[changeId];
        if (!validation.finalized || !validation.passed) revert ValidationNotPassed();
    }

    function _startValidation(
        bytes32 changeId,
        uint256 durationSeconds,
        uint256 minimumReporterCount,
        uint256 supportThresholdBps,
        string calldata metadataURI
    ) internal {
        if (changeId == bytes32(0)) revert InvalidConfig();
        if (_validations[changeId].createdAt != 0) revert ValidationAlreadyExists();
        if (durationSeconds < minValidationDuration || durationSeconds > maxValidationDuration) revert InvalidConfig();
        if (minimumReporterCount == 0 || supportThresholdBps <= 5000 || supportThresholdBps > 10_000) {
            revert InvalidConfig();
        }

        oracleRegistry.maybeActivateAdvancedMode();
        if (!oracleRegistry.currentModeUsesStakeWeight()) revert StakeWeightedModeRequired();

        uint256 totalWeight = oracleRegistry.totalConsensusWeight();
        if (totalWeight == 0) revert InvalidConfig();

        _validations[changeId] = Validation({
            createdAt: block.timestamp,
            expiresAt: block.timestamp + durationSeconds,
            snapshotTotalWeight: totalWeight,
            supportWeight: 0,
            rejectWeight: 0,
            supportCount: 0,
            rejectCount: 0,
            minimumReporterCount: minimumReporterCount,
            supportThresholdBps: supportThresholdBps,
            finalized: false,
            passed: false,
            metadataURI: metadataURI
        });

        emit ValidationStarted(
            changeId,
            block.timestamp + durationSeconds,
            totalWeight,
            minimumReporterCount,
            supportThresholdBps,
            metadataURI
        );
    }

    function _finalize(bytes32 changeId, bool passed, bool earlyFinalized) internal {
        Validation storage validation = _validations[changeId];
        validation.finalized = true;
        validation.passed = passed;
        emit ValidationFinalized(changeId, passed, earlyFinalized);
    }

    function _requireEligibleReporter(address reporter) internal returns (uint256 weight) {
        oracleRegistry.maybeActivateAdvancedMode();
        if (!oracleRegistry.currentModeUsesStakeWeight()) revert StakeWeightedModeRequired();
        if (!oracleRegistry.isEligibleOracle(reporter)) revert NotEligibleReporter();

        weight = oracleRegistry.getOracleWeight(reporter);
        if (weight == 0) revert NotEligibleReporter();
    }

    function _meetsPassThreshold(Validation storage validation) internal view returns (bool) {
        if (validation.supportCount < validation.minimumReporterCount) return false;
        if (validation.snapshotTotalWeight == 0) return false;
        return validation.supportWeight * 10_000 >= validation.snapshotTotalWeight * validation.supportThresholdBps;
    }
}
