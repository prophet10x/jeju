// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IConstitutionalVotesToken {
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
}

interface ICoreGovernanceTimelock {
    function timelockDelay() external view returns (uint256);
    function proposeUpgrade(address target, bytes calldata data, string calldata description) external returns (bytes32);
    function execute(bytes32 proposalId) external;
    function canExecute(bytes32 proposalId) external view returns (bool);
}

/**
 * @title MetaAgentConstitutionalGovernor
 * @notice Constitutional lane for core upgrades with long voting and timelock execution.
 * @dev Vote window lasts 30 days and supports early pass once yes votes exceed 50%
 *      of snapshot delegated supply. Successful proposals are queued in GovernanceTimelock.
 */
contract MetaAgentConstitutionalGovernor is Ownable {
    struct ConstitutionalProposal {
        bytes32 proposalId;
        address proposer;
        address target;
        bytes data;
        string description;
        string metadataURI;
        uint256 snapshotTime;
        uint256 snapshotDelegatedSupply;
        uint256 createdAt;
        uint256 voteEnd;
        uint256 yesVotes;
        uint256 noVotes;
        bool queued;
        bool rejected;
        bool executed;
        bytes32 timelockProposalId;
    }

    uint256 public constant VOTING_PERIOD = 30 days;
    uint256 public constant EARLY_PASS_THRESHOLD_BPS = 5000;
    uint256 public constant REQUIRED_CORE_TIMELOCK_DELAY = 7 days;

    IConstitutionalVotesToken public governanceToken;
    ICoreGovernanceTimelock public governanceTimelock;
    address public protocolUpgradeManager;

    uint256 private _proposalNonce;

    mapping(bytes32 => ConstitutionalProposal) public proposals;
    mapping(bytes32 => mapping(address => bool)) public hasVoted;

    event GovernanceTokenUpdated(address indexed oldToken, address indexed newToken);
    event GovernanceTimelockUpdated(address indexed oldTimelock, address indexed newTimelock);
    event ProtocolUpgradeManagerUpdated(address indexed oldManager, address indexed newManager);

    event ConstitutionalProposalCreated(
        bytes32 indexed proposalId,
        address indexed proposer,
        address indexed target,
        uint256 snapshotTime,
        uint256 voteEnd,
        uint256 snapshotDelegatedSupply,
        string metadataURI
    );
    event ConstitutionalVoteCast(
        bytes32 indexed proposalId,
        address indexed voter,
        bool support,
        uint256 weight,
        uint256 yesVotes,
        uint256 noVotes
    );
    event ConstitutionalProposalQueued(bytes32 indexed proposalId, bytes32 indexed timelockProposalId);
    event ConstitutionalProposalRejected(bytes32 indexed proposalId, uint256 yesVotes, uint256 requiredVotes);
    event ConstitutionalProposalExecuted(bytes32 indexed proposalId, bytes32 indexed timelockProposalId);

    error InvalidAddress();
    error InvalidTarget();
    error ProposalNotFound();
    error ProposalAlreadyFinalized();
    error VoteWindowClosed();
    error VoteWindowOpen();
    error AlreadyVoted();
    error NoVotingPower();
    error TimelockDelayMismatch(uint256 expectedDelay, uint256 actualDelay);
    error ProposalNotQueued();
    error TimelockNotReady();

    constructor(
        address _governanceToken,
        address _governanceTimelock,
        address _protocolUpgradeManager,
        address initialOwner
    ) Ownable(initialOwner) {
        if (_governanceToken == address(0) || _governanceTimelock == address(0) || _protocolUpgradeManager == address(0)) {
            revert InvalidAddress();
        }

        governanceToken = IConstitutionalVotesToken(_governanceToken);
        governanceTimelock = ICoreGovernanceTimelock(_governanceTimelock);
        protocolUpgradeManager = _protocolUpgradeManager;
    }

    function setGovernanceToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert InvalidAddress();
        address oldToken = address(governanceToken);
        governanceToken = IConstitutionalVotesToken(newToken);
        emit GovernanceTokenUpdated(oldToken, newToken);
    }

    function setGovernanceTimelock(address newTimelock) external onlyOwner {
        if (newTimelock == address(0)) revert InvalidAddress();
        address oldTimelock = address(governanceTimelock);
        governanceTimelock = ICoreGovernanceTimelock(newTimelock);
        emit GovernanceTimelockUpdated(oldTimelock, newTimelock);
    }

    function setProtocolUpgradeManager(address newManager) external onlyOwner {
        if (newManager == address(0)) revert InvalidAddress();
        address oldManager = protocolUpgradeManager;
        protocolUpgradeManager = newManager;
        emit ProtocolUpgradeManagerUpdated(oldManager, newManager);
    }

    function submitCoreUpgradeProposal(
        address target,
        bytes calldata data,
        string calldata description,
        string calldata metadataURI
    ) external returns (bytes32 proposalId) {
        if (target != protocolUpgradeManager) revert InvalidTarget();

        uint256 snapshotTime = block.timestamp > 0 ? block.timestamp - 1 : 0;
        uint256 snapshotDelegatedSupply = governanceToken.getPastTotalSupply(snapshotTime);

        proposalId = keccak256(
            abi.encode(msg.sender, target, data, block.timestamp, block.chainid, _proposalNonce++)
        );

        ConstitutionalProposal storage proposal = proposals[proposalId];
        proposal.proposalId = proposalId;
        proposal.proposer = msg.sender;
        proposal.target = target;
        proposal.data = data;
        proposal.description = description;
        proposal.metadataURI = metadataURI;
        proposal.snapshotTime = snapshotTime;
        proposal.snapshotDelegatedSupply = snapshotDelegatedSupply;
        proposal.createdAt = block.timestamp;
        proposal.voteEnd = block.timestamp + VOTING_PERIOD;

        emit ConstitutionalProposalCreated(
            proposalId,
            msg.sender,
            target,
            snapshotTime,
            proposal.voteEnd,
            snapshotDelegatedSupply,
            metadataURI
        );
    }

    function castVote(bytes32 proposalId, bool support) external {
        ConstitutionalProposal storage proposal = proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();
        if (proposal.queued || proposal.rejected) revert ProposalAlreadyFinalized();
        if (block.timestamp > proposal.voteEnd) revert VoteWindowClosed();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        uint256 votingWeight = governanceToken.getPastVotes(msg.sender, proposal.snapshotTime);
        if (votingWeight == 0) revert NoVotingPower();

        hasVoted[proposalId][msg.sender] = true;

        if (support) {
            proposal.yesVotes += votingWeight;
        } else {
            proposal.noVotes += votingWeight;
        }

        emit ConstitutionalVoteCast(
            proposalId,
            msg.sender,
            support,
            votingWeight,
            proposal.yesVotes,
            proposal.noVotes
        );

        if (_meetsEarlyPass(proposal)) {
            _queueInTimelock(proposal);
        }
    }

    function finalizeProposal(bytes32 proposalId) external {
        ConstitutionalProposal storage proposal = proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();
        if (proposal.queued || proposal.rejected) revert ProposalAlreadyFinalized();
        if (block.timestamp < proposal.voteEnd) revert VoteWindowOpen();

        if (_meetsEarlyPass(proposal)) {
            _queueInTimelock(proposal);
            return;
        }

        proposal.rejected = true;
        uint256 requiredVotes = _requiredVotesToPass(proposal.snapshotDelegatedSupply);
        emit ConstitutionalProposalRejected(proposalId, proposal.yesVotes, requiredVotes);
    }

    function executeQueuedProposal(bytes32 proposalId) external {
        ConstitutionalProposal storage proposal = proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();
        if (!proposal.queued) revert ProposalNotQueued();
        if (proposal.executed) revert ProposalAlreadyFinalized();

        if (!governanceTimelock.canExecute(proposal.timelockProposalId)) {
            revert TimelockNotReady();
        }

        proposal.executed = true;
        governanceTimelock.execute(proposal.timelockProposalId);

        emit ConstitutionalProposalExecuted(proposalId, proposal.timelockProposalId);
    }

    function requiredVotesToPass(bytes32 proposalId) external view returns (uint256) {
        ConstitutionalProposal storage proposal = proposals[proposalId];
        if (proposal.createdAt == 0) revert ProposalNotFound();
        return _requiredVotesToPass(proposal.snapshotDelegatedSupply);
    }

    function _queueInTimelock(ConstitutionalProposal storage proposal) internal {
        uint256 configuredDelay = governanceTimelock.timelockDelay();
        if (configuredDelay != REQUIRED_CORE_TIMELOCK_DELAY) {
            revert TimelockDelayMismatch(REQUIRED_CORE_TIMELOCK_DELAY, configuredDelay);
        }

        proposal.queued = true;
        proposal.timelockProposalId =
            governanceTimelock.proposeUpgrade(proposal.target, proposal.data, proposal.description);

        emit ConstitutionalProposalQueued(proposal.proposalId, proposal.timelockProposalId);
    }

    function _meetsEarlyPass(ConstitutionalProposal storage proposal) internal view returns (bool) {
        if (proposal.snapshotDelegatedSupply == 0) {
            return false;
        }
        return proposal.yesVotes * 10_000 > proposal.snapshotDelegatedSupply * EARLY_PASS_THRESHOLD_BPS;
    }

    function _requiredVotesToPass(uint256 snapshotDelegatedSupply) internal pure returns (uint256) {
        if (snapshotDelegatedSupply == 0) {
            return 0;
        }
        return (snapshotDelegatedSupply * EARLY_PASS_THRESHOLD_BPS) / 10_000 + 1;
    }
}
