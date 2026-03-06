// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OraclePowerRegistry} from "./OraclePowerRegistry.sol";

interface IQoSMetadataIdentityRegistry {
    function setMetadataByAuthorizedReporter(uint256 agentId, string calldata key, bytes calldata value) external;
}

/**
 * @title QoSMetadataReporterConsensus
 * @notice Stake-weighted reporter quorum for ERC-8004 QoS metadata updates
 * @dev Reporters are sourced from OraclePowerRegistry eligibility/weight.
 * Quorum requires both:
 * 1) minimum distinct reporters (m-of-n), and
 * 2) support weight >= supportThresholdBps of total consensus weight.
 */
contract QoSMetadataReporterConsensus is Ownable {
    struct MetadataProposal {
        uint256 agentId;
        bytes32 payloadHash;
        uint256 createdAt;
        uint256 expiresAt;
        uint256 supportWeight;
        uint256 supportCount;
        bool executed;
        string[] keys;
        bytes[] values;
    }

    OraclePowerRegistry public oracleRegistry;
    IQoSMetadataIdentityRegistry public identityRegistry;
    bool public deprecated;
    address public replacementConsensus;

    uint256 public minimumReporterCount;
    uint256 public supportThresholdBps;
    uint256 public minProposalDuration;
    uint256 public maxProposalDuration;
    uint256 public proposalNonce;

    mapping(bytes32 => MetadataProposal) private _proposals;
    mapping(bytes32 => mapping(address => bool)) public hasApproved;
    mapping(bytes32 => bytes32) public activeProposalByPayloadHash;

    event ProposalCreated(
        bytes32 indexed proposalId,
        uint256 indexed agentId,
        bytes32 indexed payloadHash,
        address proposer,
        uint256 expiresAt
    );
    event ProposalApproved(
        bytes32 indexed proposalId,
        address indexed reporter,
        uint256 reporterWeight,
        uint256 supportWeight,
        uint256 supportCount
    );
    event ProposalExecuted(bytes32 indexed proposalId, uint256 indexed agentId, uint256 keyCount);
    event OracleRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event IdentityRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event ConsensusDeprecated(address indexed replacementConsensus);
    event ConsensusConfigUpdated(
        uint256 oldMinimumReporterCount,
        uint256 newMinimumReporterCount,
        uint256 oldSupportThresholdBps,
        uint256 newSupportThresholdBps,
        uint256 oldMinProposalDuration,
        uint256 newMinProposalDuration,
        uint256 oldMaxProposalDuration,
        uint256 newMaxProposalDuration
    );

    error InvalidAddress();
    error InvalidConfig();
    error InvalidPayload();
    error InvalidDuration();
    error InvalidReplacement();
    error StakeWeightedModeRequired();
    error NotEligibleReporter();
    error ProposalNotFound();
    error ProposalInactive();
    error ProposalExpired();
    error ProposalAlreadyExecuted();
    error AlreadyApproved();
    error QuorumNotMet();
    error ContractDeprecated();

    modifier whenActive() {
        if (deprecated) revert ContractDeprecated();
        _;
    }

    constructor(
        address _oracleRegistry,
        address _identityRegistry,
        address initialOwner,
        uint256 _minimumReporterCount,
        uint256 _supportThresholdBps,
        uint256 _minProposalDuration,
        uint256 _maxProposalDuration
    ) Ownable(initialOwner) {
        if (_oracleRegistry == address(0) || _identityRegistry == address(0)) revert InvalidAddress();
        if (_minimumReporterCount == 0) revert InvalidConfig();
        if (_supportThresholdBps <= 5000 || _supportThresholdBps > 10_000) revert InvalidConfig();
        if (_minProposalDuration == 0 || _maxProposalDuration < _minProposalDuration) revert InvalidConfig();

        oracleRegistry = OraclePowerRegistry(_oracleRegistry);
        identityRegistry = IQoSMetadataIdentityRegistry(_identityRegistry);
        minimumReporterCount = _minimumReporterCount;
        supportThresholdBps = _supportThresholdBps;
        minProposalDuration = _minProposalDuration;
        maxProposalDuration = _maxProposalDuration;
    }

    function setOracleRegistry(address newOracleRegistry) external onlyOwner {
        if (newOracleRegistry == address(0)) revert InvalidAddress();
        address oldRegistry = address(oracleRegistry);
        oracleRegistry = OraclePowerRegistry(newOracleRegistry);
        emit OracleRegistryUpdated(oldRegistry, newOracleRegistry);
    }

    function setIdentityRegistry(address newIdentityRegistry) external onlyOwner {
        if (newIdentityRegistry == address(0)) revert InvalidAddress();
        address oldRegistry = address(identityRegistry);
        identityRegistry = IQoSMetadataIdentityRegistry(newIdentityRegistry);
        emit IdentityRegistryUpdated(oldRegistry, newIdentityRegistry);
    }

    function deprecateAndSetReplacement(address newReplacementConsensus) external onlyOwner {
        if (newReplacementConsensus == address(0) || newReplacementConsensus == address(this)) {
            revert InvalidReplacement();
        }
        deprecated = true;
        replacementConsensus = newReplacementConsensus;
        emit ConsensusDeprecated(newReplacementConsensus);
    }

    function setConsensusConfig(
        uint256 newMinimumReporterCount,
        uint256 newSupportThresholdBps,
        uint256 newMinProposalDuration,
        uint256 newMaxProposalDuration
    ) external onlyOwner {
        if (newMinimumReporterCount == 0) revert InvalidConfig();
        if (newSupportThresholdBps <= 5000 || newSupportThresholdBps > 10_000) revert InvalidConfig();
        if (newMinProposalDuration == 0 || newMaxProposalDuration < newMinProposalDuration) revert InvalidConfig();

        emit ConsensusConfigUpdated(
            minimumReporterCount,
            newMinimumReporterCount,
            supportThresholdBps,
            newSupportThresholdBps,
            minProposalDuration,
            newMinProposalDuration,
            maxProposalDuration,
            newMaxProposalDuration
        );

        minimumReporterCount = newMinimumReporterCount;
        supportThresholdBps = newSupportThresholdBps;
        minProposalDuration = newMinProposalDuration;
        maxProposalDuration = newMaxProposalDuration;
    }

    function proposeOrApproveMetadataUpdate(
        uint256 agentId,
        string[] calldata keys,
        bytes[] calldata values,
        uint256 durationSeconds
    ) external whenActive returns (bytes32 proposalId, bool created, bool executedNow) {
        uint256 reporterWeight = _requireEligibleReporter(msg.sender);

        if (agentId == 0) revert InvalidPayload();
        if (keys.length == 0 || keys.length != values.length) revert InvalidPayload();
        if (durationSeconds < minProposalDuration || durationSeconds > maxProposalDuration) revert InvalidDuration();

        bytes32 payloadHash = _payloadHash(agentId, keys, values);
        bytes32 activeId = activeProposalByPayloadHash[payloadHash];

        if (activeId != bytes32(0) && _isProposalActive(activeId)) {
            proposalId = activeId;
            created = false;
            _approveProposal(proposalId, msg.sender, reporterWeight);
        } else {
            if (activeId != bytes32(0)) {
                delete activeProposalByPayloadHash[payloadHash];
            }

            created = true;
            proposalId = _createProposal(agentId, payloadHash, keys, values, durationSeconds);
            activeProposalByPayloadHash[payloadHash] = proposalId;
            _approveProposal(proposalId, msg.sender, reporterWeight);
        }

        if (canExecute(proposalId)) {
            _executeProposal(proposalId);
            executedNow = true;
        }
    }

    function approveProposal(bytes32 proposalId) external whenActive {
        uint256 reporterWeight = _requireEligibleReporter(msg.sender);
        MetadataProposal storage proposal = _proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (block.timestamp > proposal.expiresAt) revert ProposalExpired();

        _approveProposal(proposalId, msg.sender, reporterWeight);
    }

    function executeProposal(bytes32 proposalId) external whenActive {
        if (!canExecute(proposalId)) revert QuorumNotMet();
        _executeProposal(proposalId);
    }

    function canExecute(bytes32 proposalId) public view returns (bool) {
        if (deprecated) return false;
        MetadataProposal storage proposal = _proposals[proposalId];
        if (proposal.createdAt == 0 || proposal.executed || block.timestamp > proposal.expiresAt) return false;
        if (proposal.supportCount < minimumReporterCount) return false;
        if (!oracleRegistry.currentModeUsesStakeWeight()) return false;

        uint256 totalWeight = oracleRegistry.totalConsensusWeight();
        if (totalWeight == 0) return false;

        return proposal.supportWeight * 10_000 >= totalWeight * supportThresholdBps;
    }

    function getProposal(bytes32 proposalId)
        external
        view
        returns (
            uint256 agentId,
            bytes32 payloadHash,
            uint256 createdAt,
            uint256 expiresAt,
            uint256 supportWeight,
            uint256 supportCount,
            bool executed,
            uint256 keyCount
        )
    {
        MetadataProposal storage proposal = _proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();

        return (
            proposal.agentId,
            proposal.payloadHash,
            proposal.createdAt,
            proposal.expiresAt,
            proposal.supportWeight,
            proposal.supportCount,
            proposal.executed,
            proposal.keys.length
        );
    }

    function getProposalPayload(bytes32 proposalId) external view returns (string[] memory keys, bytes[] memory values) {
        MetadataProposal storage proposal = _proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();

        return (proposal.keys, proposal.values);
    }

    function _createProposal(
        uint256 agentId,
        bytes32 payloadHash,
        string[] calldata keys,
        bytes[] calldata values,
        uint256 durationSeconds
    ) internal returns (bytes32 proposalId) {
        proposalId = keccak256(abi.encodePacked(agentId, payloadHash, proposalNonce++, block.timestamp, msg.sender));
        MetadataProposal storage proposal = _proposals[proposalId];

        proposal.agentId = agentId;
        proposal.payloadHash = payloadHash;
        proposal.createdAt = block.timestamp;
        proposal.expiresAt = block.timestamp + durationSeconds;

        for (uint256 i = 0; i < keys.length; i++) {
            proposal.keys.push(keys[i]);
            proposal.values.push(values[i]);
        }

        emit ProposalCreated(proposalId, agentId, payloadHash, msg.sender, proposal.expiresAt);
    }

    function _approveProposal(bytes32 proposalId, address reporter, uint256 reporterWeight) internal {
        if (hasApproved[proposalId][reporter]) revert AlreadyApproved();
        if (reporterWeight == 0) revert NotEligibleReporter();

        MetadataProposal storage proposal = _proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (block.timestamp > proposal.expiresAt) revert ProposalExpired();

        hasApproved[proposalId][reporter] = true;
        proposal.supportWeight += reporterWeight;
        proposal.supportCount += 1;

        emit ProposalApproved(
            proposalId,
            reporter,
            reporterWeight,
            proposal.supportWeight,
            proposal.supportCount
        );
    }

    function _executeProposal(bytes32 proposalId) internal {
        MetadataProposal storage proposal = _proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (block.timestamp > proposal.expiresAt) revert ProposalExpired();

        proposal.executed = true;

        if (activeProposalByPayloadHash[proposal.payloadHash] == proposalId) {
            delete activeProposalByPayloadHash[proposal.payloadHash];
        }

        for (uint256 i = 0; i < proposal.keys.length; i++) {
            identityRegistry.setMetadataByAuthorizedReporter(
                proposal.agentId, proposal.keys[i], proposal.values[i]
            );
        }

        emit ProposalExecuted(proposalId, proposal.agentId, proposal.keys.length);
    }

    function _requireEligibleReporter(address reporter) internal returns (uint256 weight) {
        oracleRegistry.maybeActivateAdvancedMode();
        if (!oracleRegistry.currentModeUsesStakeWeight()) revert StakeWeightedModeRequired();
        if (!oracleRegistry.isEligibleOracle(reporter)) revert NotEligibleReporter();

        weight = oracleRegistry.getOracleWeight(reporter);
        if (weight == 0) revert NotEligibleReporter();
    }

    function _isProposalActive(bytes32 proposalId) internal view returns (bool) {
        MetadataProposal storage proposal = _proposals[proposalId];
        return proposal.createdAt != 0 && !proposal.executed && block.timestamp <= proposal.expiresAt;
    }

    function _payloadHash(uint256 agentId, string[] calldata keys, bytes[] calldata values) internal pure returns (bytes32) {
        return keccak256(abi.encode(agentId, keys, values));
    }
}
