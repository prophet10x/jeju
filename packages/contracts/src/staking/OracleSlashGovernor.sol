// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {INodeStakingManager} from "./INodeStakingManager.sol";
import {OraclePowerRegistry} from "./OraclePowerRegistry.sol";

/**
 * @title OracleSlashGovernor
 * @notice Stake-weighted oracle voting for node slashing proposals
 * @dev Consensus queues proposals, eligible oracles vote with their current
 * oracle weight, and execution windows shorten with stronger support.
 */
contract OracleSlashGovernor is Ownable {
    struct SlashProposal {
        bytes32 nodeId;
        uint256 epoch;
        uint256 slashBps;
        bytes32 evidenceHash;
        uint256 createdAtBlock;
        uint256 executableAtBlock;
        uint256 yesWeight;
        uint256 noWeight;
        bool executed;
    }

    struct OracleVote {
        bool voted;
        bool support;
        uint256 weight;
    }

    INodeStakingManager public immutable stakingManager;
    OraclePowerRegistry public immutable oracleRegistry;
    address public consensus;

    uint256 public fastSupportBps;
    uint256 public standardSupportBps;
    uint256 public fastExecutionDelayBlocks;
    uint256 public standardExecutionDelayBlocks;

    mapping(bytes32 => SlashProposal) public proposals;
    mapping(bytes32 => mapping(address => OracleVote)) public votes;

    event ConsensusUpdated(address indexed oldConsensus, address indexed newConsensus);
    event ProposalQueued(bytes32 indexed proposalId, bytes32 indexed nodeId, uint256 epoch, uint256 slashBps);
    event ProposalVoted(bytes32 indexed proposalId, address indexed oracle, bool support, uint256 weight);
    event ProposalExecutableAtUpdated(bytes32 indexed proposalId, uint256 executableAtBlock);
    event ProposalExecuted(bytes32 indexed proposalId, bytes32 indexed nodeId, uint256 slashBps);

    error InvalidAddress();
    error InvalidAmount();
    error NotConsensus();
    error NotEligibleOracle();
    error ProposalAlreadyExists();
    error ProposalNotFound();
    error AlreadyVoted();
    error ProposalNotExecutable();
    error ProposalAlreadyExecuted();

    constructor(
        address _stakingManager,
        address _oracleRegistry,
        address initialOwner,
        uint256 _fastSupportBps,
        uint256 _standardSupportBps,
        uint256 _fastExecutionDelayBlocks,
        uint256 _standardExecutionDelayBlocks
    ) Ownable(initialOwner) {
        if (_stakingManager == address(0) || _oracleRegistry == address(0)) revert InvalidAddress();
        if (_standardSupportBps == 0 || _standardSupportBps > 10_000) revert InvalidAmount();
        if (_fastSupportBps < _standardSupportBps || _fastSupportBps > 10_000) revert InvalidAmount();
        if (_fastExecutionDelayBlocks == 0 || _standardExecutionDelayBlocks == 0) revert InvalidAmount();

        stakingManager = INodeStakingManager(_stakingManager);
        oracleRegistry = OraclePowerRegistry(_oracleRegistry);
        fastSupportBps = _fastSupportBps;
        standardSupportBps = _standardSupportBps;
        fastExecutionDelayBlocks = _fastExecutionDelayBlocks;
        standardExecutionDelayBlocks = _standardExecutionDelayBlocks;
    }

    function proposalId(bytes32 nodeId, uint256 epoch, bytes32 evidenceHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(nodeId, epoch, evidenceHash));
    }

    function queueProposalFromConsensus(bytes32 nodeId, uint256 epoch, uint256 slashBps, bytes32 evidenceHash)
        external
        returns (bytes32 id)
    {
        if (msg.sender != consensus) revert NotConsensus();

        id = proposalId(nodeId, epoch, evidenceHash);
        if (proposals[id].createdAtBlock != 0) revert ProposalAlreadyExists();

        proposals[id] = SlashProposal({
            nodeId: nodeId,
            epoch: epoch,
            slashBps: slashBps,
            evidenceHash: evidenceHash,
            createdAtBlock: block.number,
            executableAtBlock: 0,
            yesWeight: 0,
            noWeight: 0,
            executed: false
        });

        emit ProposalQueued(id, nodeId, epoch, slashBps);
    }

    function vote(bytes32 id, bool support) external {
        oracleRegistry.maybeActivateAdvancedMode();

        if (!oracleRegistry.isEligibleOracle(msg.sender)) revert NotEligibleOracle();
        if (proposals[id].createdAtBlock == 0) revert ProposalNotFound();
        if (proposals[id].executed) revert ProposalAlreadyExecuted();
        if (votes[id][msg.sender].voted) revert AlreadyVoted();

        uint256 weight = oracleRegistry.getOracleWeight(msg.sender);
        if (weight == 0) revert NotEligibleOracle();

        votes[id][msg.sender] = OracleVote({voted: true, support: support, weight: weight});

        if (support) {
            proposals[id].yesWeight += weight;
        } else {
            proposals[id].noWeight += weight;
        }

        emit ProposalVoted(id, msg.sender, support, weight);
        _refreshExecutableAt(id);
    }

    function executeProposal(bytes32 id) external {
        SlashProposal storage proposal = proposals[id];
        if (proposal.createdAtBlock == 0) revert ProposalNotFound();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.executableAtBlock == 0 || block.number < proposal.executableAtBlock) revert ProposalNotExecutable();

        proposal.executed = true;
        stakingManager.slashNode(proposal.nodeId, proposal.slashBps, "oracle-weighted vote");

        emit ProposalExecuted(id, proposal.nodeId, proposal.slashBps);
    }

    function setConsensus(address newConsensus) external onlyOwner {
        if (newConsensus == address(0)) revert InvalidAddress();
        address oldConsensus = consensus;
        consensus = newConsensus;
        emit ConsensusUpdated(oldConsensus, newConsensus);
    }

    function setThresholds(
        uint256 newFastSupportBps,
        uint256 newStandardSupportBps,
        uint256 newFastExecutionDelayBlocks,
        uint256 newStandardExecutionDelayBlocks
    ) external onlyOwner {
        if (newStandardSupportBps == 0 || newStandardSupportBps > 10_000) revert InvalidAmount();
        if (newFastSupportBps < newStandardSupportBps || newFastSupportBps > 10_000) revert InvalidAmount();
        if (newFastExecutionDelayBlocks == 0 || newStandardExecutionDelayBlocks == 0) revert InvalidAmount();

        fastSupportBps = newFastSupportBps;
        standardSupportBps = newStandardSupportBps;
        fastExecutionDelayBlocks = newFastExecutionDelayBlocks;
        standardExecutionDelayBlocks = newStandardExecutionDelayBlocks;
    }

    function _refreshExecutableAt(bytes32 id) internal {
        SlashProposal storage proposal = proposals[id];
        uint256 totalWeight = oracleRegistry.totalConsensusWeight();
        if (totalWeight == 0) {
            proposal.executableAtBlock = 0;
            emit ProposalExecutableAtUpdated(id, 0);
            return;
        }

        uint256 supportBps = (proposal.yesWeight * 10_000) / totalWeight;
        uint256 opposeBps = (proposal.noWeight * 10_000) / totalWeight;

        if (supportBps >= fastSupportBps && opposeBps <= 10_000 - fastSupportBps) {
            proposal.executableAtBlock = proposal.createdAtBlock + fastExecutionDelayBlocks;
        } else if (supportBps >= standardSupportBps && opposeBps < 10_000 - standardSupportBps) {
            proposal.executableAtBlock = proposal.createdAtBlock + standardExecutionDelayBlocks;
        } else {
            proposal.executableAtBlock = 0;
        }

        emit ProposalExecutableAtUpdated(id, proposal.executableAtBlock);
    }
}
