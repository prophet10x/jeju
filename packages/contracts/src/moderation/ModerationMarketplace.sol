// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BanManager.sol";
import "./IGitHubReputationProvider.sol";
import "./IModerationExtensions.sol";
import {ModerationReputationLib} from "./libraries/ModerationReputationLib.sol";
import {ModerationVotingLib} from "./libraries/ModerationVotingLib.sol";
import {ModerationRewardsLib} from "./libraries/ModerationRewardsLib.sol";

/**
 * @title ModerationMarketplace
 * @author Jeju Network
 * @notice Futarchy-based moderation system where users bet on ban outcomes
 * @dev Implements stake-weighted moderation with flash loan protection.
 *      Heavy logic extracted into internal libraries for EIP-170 compliance.
 * @custom:security-contact security@jejunetwork.org
 */
contract ModerationMarketplace is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ENUMS
    // ═══════════════════════════════════════════════════════════════════════

    enum BanStatus {
        NONE,
        ON_NOTICE,
        CHALLENGED,
        BANNED,
        CLEARED,
        APPEALING
    }

    enum MarketOutcome {
        PENDING,
        BAN_UPHELD,
        BAN_REJECTED
    }

    enum VotePosition {
        YES,
        NO
    }

    /// @notice Reputation tier for stake requirements (mirrors library enum for public API)
    enum ReputationTier {
        UNTRUSTED,
        LOW,
        MEDIUM,
        HIGH,
        TRUSTED
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;
        uint256 stakedBlock;
        uint256 lastActivityBlock;
        bool isStaked;
    }

    struct BanCase {
        bytes32 caseId;
        address reporter;
        address target;
        uint256 reporterStake;
        uint256 targetStake;
        string reason;
        bytes32 evidenceHash;
        BanStatus status;
        uint256 createdAt;
        uint256 marketOpenUntil;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 totalPot;
        bool resolved;
        MarketOutcome outcome;
        uint256 appealCount;
    }

    struct Vote {
        VotePosition position;
        uint256 weight;
        uint256 stakedAt;
        bool hasVoted;
        bool hasClaimed;
    }

    struct StakeCheckpoint {
        uint256 blockNumber;
        uint256 stakeAmount;
    }

    struct ModeratorReputation {
        uint256 successfulBans;
        uint256 unsuccessfulBans;
        uint256 totalSlashedFrom;
        uint256 totalSlashedOthers;
        uint256 reputationScore;
        uint256 lastReportTimestamp;
        uint256 reportCooldownUntil;
        uint256 dailyReportCount;
        uint256 weeklyReportCount;
        uint256 reportDayStart;
        uint256 reportWeekStart;
        uint256 consecutiveWins;
        uint256 lastActivityTimestamp;
        uint256 activeReportCount;
    }

    struct ReportEvidence {
        bytes32[] evidenceHashes;
        string[] notes;
        string category;
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    // Note: Voting/reward/reputation constants live in their respective libraries
    // (ModerationVotingLib, ModerationRewardsLib, ModerationReputationLib)

    uint256 public constant MIN_STAKE_AGE = 24 hours;
    uint256 public constant MIN_STAKE_BLOCKS = 7200;
    uint256 public constant DEFAULT_VOTING_PERIOD = 3 days;
    uint256 public constant APPEAL_VOTING_PERIOD = 7 days;
    uint256 public constant RE_REVIEW_MULTIPLIER = 10;
    uint256 public constant MAX_APPEAL_COUNT = 3;
    uint256 public constant CONVICTION_LOCK_PERIOD = 3 days;

    // Anti-sybil constants
    uint256 public constant MIN_QUORUM_STAKE_AGE = 7 days;
    uint256 public constant MIN_COMBINED_QUORUM_STAKE = 2 ether;
    uint256 public constant MIN_QUORUM_PARTICIPANT_STAKE = 0.5 ether;

    // Pre-computed selectors to avoid runtime abi.encodeWithSignature overhead
    bytes4 private constant _REGISTER_CASE_SELECTOR = bytes4(keccak256("registerCase(bytes32,uint256,uint256)"));
    bytes4 private constant _RESOLVE_CASE_SELECTOR = bytes4(keccak256("resolveCase(bytes32,bool)"));

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    BanManager public immutable banManager;
    IERC20 public immutable stakingToken;
    address public treasury;

    uint256 public minReporterStake = 0.5 ether;
    uint256 public minChallengeStake = 0.5 ether;
    uint256 public totalStaked;

    mapping(address => StakeInfo) public stakes;
    mapping(address => StakeCheckpoint[]) private _stakeCheckpoints;
    mapping(bytes32 => BanCase) public cases;
    mapping(bytes32 => mapping(address => Vote)) public votes;
    mapping(address => bytes32) public activeCase;
    bytes32[] public allCaseIds;
    uint256 private _nextCaseId = 1;
    mapping(address => ModeratorReputation) public moderatorReputation;
    mapping(bytes32 => ReportEvidence) public caseEvidence;
    mapping(address => address[]) public pendingQuorumReports;

    IGitHubReputationProvider public gitHubReputationProvider;
    address public evidenceRegistry;

    // Extension contracts
    ICommitRevealVoting public commitRevealVoting;
    IVoterSlashing public voterSlashing;
    IMultiOracleReputation public multiOracleReputation;
    ICrossChainArbitration public crossChainArbitration;

    bool public useCommitRevealVoting;
    bool public useVoterSlashing;
    bool public useMultiOracleReputation;

    mapping(address => mapping(address => bool)) public hasReportedTarget;
    mapping(address => uint256) public convictionLockUntil;
    mapping(address => mapping(address => uint256)) public quorumParticipantStakeAge;
    mapping(bytes32 => bool) public evidenceResolutionFailed;
    mapping(bytes32 => bool) public evidenceResolutionComplete;
    mapping(bytes32 => uint256) public caseVoterRewardPool;
    mapping(address => uint256) public claimableVoterRewards;
    uint256 public totalVoterRewardsDistributed;

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event Staked(address indexed user, uint256 amount, uint256 totalStake);
    event Unstaked(address indexed user, uint256 amount, uint256 remainingStake);
    event CaseOpened(
        bytes32 indexed caseId,
        address indexed reporter,
        address indexed target,
        uint256 reporterStake,
        string reason,
        bytes32 evidenceHash
    );
    event CaseChallenged(bytes32 indexed caseId, address indexed target, uint256 targetStake, uint256 totalPot);
    event VoteCast(bytes32 indexed caseId, address indexed voter, VotePosition position, uint256 weight);
    event CaseResolved(bytes32 indexed caseId, MarketOutcome outcome, uint256 yesVotes, uint256 noVotes);
    event RewardsDistributed(
        bytes32 indexed caseId, address indexed winner, uint256 winnerAmount, uint256 treasuryAmount
    );
    event ConfigUpdated(string indexed param, uint256 oldValue, uint256 newValue);
    event AppealOpened(bytes32 indexed caseId, address indexed appellant, uint256 appealStake, uint256 appealNumber);
    event StakeCheckpointed(address indexed user, uint256 blockNumber, uint256 amount);
    event ReputationUpdated(
        address indexed moderator,
        uint256 oldScore,
        uint256 newScore,
        uint256 successfulBans,
        uint256 unsuccessfulBans,
        int256 netPnL
    );
    event QuorumReportAdded(
        address indexed target, address indexed reporter, uint256 currentReports, uint256 requiredQuorum
    );
    event QuorumReached(address indexed target, bytes32 indexed caseId, uint256 reportCount);
    event EvidenceAdded(bytes32 indexed caseId, bytes32 evidenceHash, string note);
    event EvidenceRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event EvidenceResolutionFailed(bytes32 indexed caseId);
    event ExtensionUpdated(string indexed name, address indexed extension, bool enabled);
    event CaseEscalated(bytes32 indexed caseId);
    event VoterSlashed(bytes32 indexed caseId, address indexed voter, uint256 amount);
    event CommitRevealInitialized(bytes32 indexed caseId);
    event EvidenceRegistrationFailed(bytes32 indexed caseId);
    event EvidenceResolutionRetried(bytes32 indexed caseId, bool success);
    event VoterRewardClaimed(bytes32 indexed caseId, address indexed voter, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error InsufficientStake();
    error StakeTooYoung();
    error NotStaked();
    error CaseNotFound();
    error CaseNotActive();
    error CaseAlreadyResolved();
    error VotingNotEnded();
    error VotingEnded();
    error AlreadyVoted();
    error NotCaseParty();
    error CannotBanSelf();
    error TargetAlreadyHasActiveCase();
    error MaxAppealsReached();
    error NotBanned();
    error FlashLoanDetected();
    error InvalidAmount();
    error TransferFailed();
    error ReputationTooLow();
    error QuorumNotReached();
    error ReportCooldownActive();
    error AlreadyReportedTarget();
    error TooManyEvidenceItems();
    error BannedUserCannotVote();
    error BannedUserCannotReport();
    error DailyReportLimitReached();
    error WeeklyReportLimitReached();
    error TooManyActiveReports();
    error QuorumStakeAgeTooYoung();
    error QuorumCombinedStakeTooLow();
    error ConvictionLockActive();
    error ExtensionNotEnabled();
    error VoterBanned();
    error InvalidAddress();
    error NotResolved();
    error ResolutionDidNotFail();
    error AlreadyResolved();
    error NoEvidenceRegistry();
    error NotOnWinningSide();
    error DidNotVote();
    error AlreadyClaimed();
    error NoRewards();

    // ═══════════════════════════════════════════════════════════════════════
    //                              MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    modifier validStakeAge(address user) {
        StakeInfo storage userStake = stakes[user];
        if (!userStake.isStaked) revert NotStaked();
        if (block.timestamp < userStake.stakedAt + MIN_STAKE_AGE) revert StakeTooYoung();
        if (block.number < userStake.stakedBlock + MIN_STAKE_BLOCKS) revert FlashLoanDetected();
        _;
    }

    modifier caseExists(bytes32 caseId) {
        // slither-disable-next-line incorrect-equality
        if (cases[caseId].createdAt == 0) revert CaseNotFound();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address _banManager, address _stakingToken, address _treasury, address initialOwner)
        Ownable(initialOwner)
    {
        if (_banManager == address(0)) revert InvalidAddress();
        if (_treasury == address(0)) revert InvalidAddress();

        banManager = BanManager(_banManager);
        stakingToken = IERC20(_stakingToken);
        treasury = _treasury;

        useCommitRevealVoting = true;
        useVoterSlashing = true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              STAKING
    // ═══════════════════════════════════════════════════════════════════════

    function stake() external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert InvalidAmount();

        StakeInfo storage stakeInfo = stakes[msg.sender];
        _checkpoint(msg.sender);

        stakeInfo.amount += msg.value;
        stakeInfo.stakedAt = block.timestamp;
        stakeInfo.stakedBlock = block.number;
        stakeInfo.lastActivityBlock = block.number;
        stakeInfo.isStaked = true;
        totalStaked += msg.value;

        emit Staked(msg.sender, msg.value, stakeInfo.amount);
    }

    function stakeTokens(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (address(stakingToken) == address(0)) revert InvalidAmount();

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        StakeInfo storage stakeInfo = stakes[msg.sender];
        _checkpoint(msg.sender);

        stakeInfo.amount += amount;
        totalStaked += amount;
        stakeInfo.stakedAt = block.timestamp;
        stakeInfo.stakedBlock = block.number;
        stakeInfo.lastActivityBlock = block.number;
        stakeInfo.isStaked = true;

        emit Staked(msg.sender, amount, stakeInfo.amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        StakeInfo storage stakeInfo = stakes[msg.sender];
        if (!stakeInfo.isStaked) revert NotStaked();
        if (stakeInfo.amount < amount) revert InsufficientStake();

        if (block.timestamp < convictionLockUntil[msg.sender]) {
            revert ConvictionLockActive();
        }

        bytes32 activeCaseId = activeCase[msg.sender];
        if (activeCaseId != bytes32(0)) {
            BanCase storage banCase = cases[activeCaseId];
            if (!banCase.resolved) {
                if (banCase.reporter == msg.sender || banCase.target == msg.sender) {
                    revert CaseNotActive();
                }
            }
        }

        _checkpoint(msg.sender);

        stakeInfo.amount -= amount;
        stakeInfo.lastActivityBlock = block.number;
        totalStaked -= amount;

        // slither-disable-next-line incorrect-equality
        if (stakeInfo.amount == 0) {
            stakeInfo.isStaked = false;
        }

        if (address(stakingToken) == address(0)) {
            // slither-disable-next-line low-level-calls
            (bool success,) = msg.sender.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            stakingToken.safeTransfer(msg.sender, amount);
        }

        emit Unstaked(msg.sender, amount, stakeInfo.amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              BAN INITIATION
    // ═══════════════════════════════════════════════════════════════════════

    function openCase(
        address target,
        string calldata reason,
        bytes32 evidenceHash,
        string calldata notes,
        string calldata category
    ) external nonReentrant whenNotPaused validStakeAge(msg.sender) returns (bytes32 caseId) {
        StakeInfo storage reporterStake = stakes[msg.sender];

        if (banManager.isAddressBanned(msg.sender)) revert BannedUserCannotReport();

        _initializeReputation(msg.sender);
        ModeratorReputation storage rep = moderatorReputation[msg.sender];

        if (target == msg.sender) revert CannotBanSelf();

        uint256 requiredStake = getRequiredStakeForReporter(msg.sender);
        if (reporterStake.amount < requiredStake) revert InsufficientStake();

        if (block.timestamp < rep.reportCooldownUntil) revert ReportCooldownActive();

        // Anti-spam checks
        if (block.timestamp < rep.lastReportTimestamp + ModerationReputationLib.MIN_REPORT_INTERVAL) revert ReportCooldownActive();

        if (block.timestamp >= rep.reportDayStart + 1 days) {
            rep.dailyReportCount = 0;
            rep.reportDayStart = block.timestamp;
        }
        if (block.timestamp >= rep.reportWeekStart + 7 days) {
            rep.weeklyReportCount = 0;
            rep.reportWeekStart = block.timestamp;
        }

        if (rep.dailyReportCount >= ModerationReputationLib.MAX_REPORTS_PER_DAY) revert DailyReportLimitReached();
        if (rep.weeklyReportCount >= ModerationReputationLib.MAX_REPORTS_PER_WEEK) revert WeeklyReportLimitReached();
        if (rep.activeReportCount >= ModerationReputationLib.MAX_ACTIVE_REPORTS) revert TooManyActiveReports();

        if (hasReportedTarget[msg.sender][target]) revert AlreadyReportedTarget();

        if (activeCase[target] != bytes32(0) && !cases[activeCase[target]].resolved) {
            revert TargetAlreadyHasActiveCase();
        }

        rep.lastReportTimestamp = block.timestamp;
        rep.lastActivityTimestamp = block.timestamp;
        rep.dailyReportCount++;
        rep.weeklyReportCount++;
        rep.activeReportCount++;

        uint256 quorumRequired = getQuorumRequired(msg.sender);

        if (quorumRequired > 1) {
            return _addToQuorumQueue(target, reason, evidenceHash, notes, category, quorumRequired);
        }

        return _createCase(target, reason, evidenceHash, notes, category);
    }

    function _addToQuorumQueue(
        address target,
        string memory reason,
        bytes32 evidenceHash,
        string memory notes,
        string memory category,
        uint256 quorumRequired
    ) internal returns (bytes32 caseId) {
        StakeInfo storage reporterStake = stakes[msg.sender];

        if (block.timestamp < reporterStake.stakedAt + MIN_QUORUM_STAKE_AGE) {
            revert QuorumStakeAgeTooYoung();
        }
        if (reporterStake.amount < MIN_QUORUM_PARTICIPANT_STAKE) {
            revert InsufficientStake();
        }

        hasReportedTarget[msg.sender][target] = true;
        quorumParticipantStakeAge[target][msg.sender] = reporterStake.stakedAt;
        pendingQuorumReports[target].push(msg.sender);

        uint256 currentCount = pendingQuorumReports[target].length;
        emit QuorumReportAdded(target, msg.sender, currentCount, quorumRequired);

        if (currentCount >= quorumRequired) {
            address[] storage reporters = pendingQuorumReports[target];
            uint256 combinedStake = 0;

            for (uint256 i = 0; i < reporters.length; i++) {
                address reporter = reporters[i];
                StakeInfo storage rStake = stakes[reporter];
                if (block.timestamp < rStake.stakedAt + MIN_QUORUM_STAKE_AGE) {
                    return bytes32(0);
                }
                combinedStake += rStake.amount;
            }

            if (combinedStake < MIN_COMBINED_QUORUM_STAKE) {
                revert QuorumCombinedStakeTooLow();
            }

            for (uint256 i = 0; i < reporters.length; i++) {
                hasReportedTarget[reporters[i]][target] = false;
                delete quorumParticipantStakeAge[target][reporters[i]];
            }
            delete pendingQuorumReports[target];

            caseId = _createCase(target, reason, evidenceHash, notes, category);
            emit QuorumReached(target, caseId, currentCount);
            return caseId;
        }

        return bytes32(0);
    }

    function _createCase(
        address target,
        string memory reason,
        bytes32 evidenceHash,
        string memory notes,
        string memory category
    ) internal returns (bytes32 caseId) {
        StakeInfo storage reporterStake = stakes[msg.sender];
        StakeInfo storage targetStake = stakes[target];

        caseId = keccak256(abi.encodePacked(_nextCaseId++, msg.sender, target, block.timestamp));

        BanStatus initialStatus;
        if (!targetStake.isStaked || targetStake.amount == 0) {
            initialStatus = BanStatus.ON_NOTICE;
        } else {
            initialStatus = BanStatus.CHALLENGED;
        }

        uint256 reporterVoteWeight = ModerationVotingLib.sqrt(reporterStake.amount * ModerationVotingLib.QUADRATIC_SCALE);
        uint256 targetVoteWeight =
            targetStake.isStaked && targetStake.amount > 0 ? ModerationVotingLib.sqrt(targetStake.amount * ModerationVotingLib.QUADRATIC_SCALE) : 0;

        cases[caseId] = BanCase({
            caseId: caseId,
            reporter: msg.sender,
            target: target,
            reporterStake: reporterStake.amount,
            targetStake: targetStake.amount,
            reason: reason,
            evidenceHash: evidenceHash,
            status: initialStatus,
            createdAt: block.timestamp,
            marketOpenUntil: block.timestamp + DEFAULT_VOTING_PERIOD,
            yesVotes: reporterVoteWeight,
            noVotes: targetVoteWeight,
            totalPot: reporterStake.amount + targetStake.amount,
            resolved: false,
            outcome: MarketOutcome.PENDING,
            appealCount: 0
        });

        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = evidenceHash;
        string[] memory noteArray = new string[](1);
        noteArray[0] = notes;

        caseEvidence[caseId] =
            ReportEvidence({evidenceHashes: hashes, notes: noteArray, category: category, timestamp: block.timestamp});

        activeCase[target] = caseId;
        allCaseIds.push(caseId);

        if (evidenceRegistry != address(0)) {
            (bool success,) = evidenceRegistry.call(
                abi.encodeWithSelector(_REGISTER_CASE_SELECTOR, caseId, block.timestamp, block.timestamp + DEFAULT_VOTING_PERIOD)
            );
            if (!success) {
                emit EvidenceRegistrationFailed(caseId);
            }
        }

        votes[caseId][msg.sender] = Vote({
            position: VotePosition.YES,
            weight: reporterVoteWeight,
            stakedAt: reporterStake.stakedAt,
            hasVoted: true,
            hasClaimed: false
        });

        if (targetStake.isStaked && targetStake.amount > 0) {
            votes[caseId][target] = Vote({
                position: VotePosition.NO,
                weight: targetVoteWeight,
                stakedAt: targetStake.stakedAt,
                hasVoted: true,
                hasClaimed: false
            });
        }

        emit CaseOpened(caseId, msg.sender, target, reporterStake.amount, reason, evidenceHash);

        if (initialStatus == BanStatus.ON_NOTICE) {
            banManager.placeOnNotice(target, msg.sender, caseId, reason);
        }

        if (initialStatus == BanStatus.CHALLENGED) {
            emit CaseChallenged(caseId, target, targetStake.amount, cases[caseId].totalPot);
            banManager.placeOnNotice(target, msg.sender, caseId, reason);
            banManager.updateBanStatus(target, BanManager.BanType.CHALLENGED);
        }
    }

    function addEvidence(bytes32 caseId, bytes32 evidenceHash, string calldata note) external caseExists(caseId) {
        BanCase storage banCase = cases[caseId];
        if (banCase.reporter != msg.sender) revert NotCaseParty();
        if (banCase.resolved) revert CaseAlreadyResolved();

        ReportEvidence storage evidence = caseEvidence[caseId];
        if (evidence.evidenceHashes.length >= 10) revert TooManyEvidenceItems();

        evidence.evidenceHashes.push(evidenceHash);
        evidence.notes.push(note);

        emit EvidenceAdded(caseId, evidenceHash, note);
    }

    // slither-disable-next-line timestamp
    function challengeCase(bytes32 caseId) external payable nonReentrant caseExists(caseId) {
        BanCase storage banCase = cases[caseId];

        if (banCase.target != msg.sender) revert NotCaseParty();
        if (banCase.status != BanStatus.ON_NOTICE) revert CaseNotActive();
        if (banCase.resolved) revert CaseAlreadyResolved();
        if (block.timestamp > banCase.marketOpenUntil) revert VotingEnded();
        if (msg.value < minChallengeStake) revert InsufficientStake();

        StakeInfo storage stakeInfo = stakes[msg.sender];
        _checkpoint(msg.sender);

        stakeInfo.amount += msg.value;
        stakeInfo.stakedAt = block.timestamp;
        stakeInfo.stakedBlock = block.number;
        stakeInfo.lastActivityBlock = block.number;
        stakeInfo.isStaked = true;
        totalStaked += msg.value;

        uint256 challengerVoteWeight = ModerationVotingLib.sqrt(msg.value * ModerationVotingLib.QUADRATIC_SCALE);

        banCase.targetStake = msg.value;
        banCase.totalPot += msg.value;
        banCase.noVotes += challengerVoteWeight;
        banCase.status = BanStatus.CHALLENGED;

        votes[caseId][msg.sender] = Vote({
            position: VotePosition.NO,
            weight: challengerVoteWeight,
            stakedAt: block.timestamp,
            hasVoted: true,
            hasClaimed: false
        });

        emit Staked(msg.sender, msg.value, stakeInfo.amount);
        emit CaseChallenged(caseId, msg.sender, msg.value, banCase.totalPot);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VOTING
    // ═══════════════════════════════════════════════════════════════════════

    // slither-disable-next-line timestamp
    function vote(bytes32 caseId, VotePosition position)
        external
        nonReentrant
        caseExists(caseId)
        validStakeAge(msg.sender)
    {
        BanCase storage banCase = cases[caseId];
        Vote storage v = votes[caseId][msg.sender];

        if (banCase.resolved) revert CaseAlreadyResolved();
        if (block.timestamp > banCase.marketOpenUntil) revert VotingEnded();
        if (v.hasVoted) revert AlreadyVoted();

        if (msg.sender == banCase.reporter || msg.sender == banCase.target) {
            revert AlreadyVoted();
        }

        if (banManager.isAddressBanned(msg.sender)) {
            revert BannedUserCannotVote();
        }

        if (useVoterSlashing && address(voterSlashing) != address(0)) {
            if (voterSlashing.isVotingBanned(msg.sender)) {
                revert VoterBanned();
            }
        }

        StakeInfo storage stakeInfo = stakes[msg.sender];

        // Use library for vote weight calculation
        uint256 voteWeight = ModerationVotingLib.calculateVoteWeight(
            stakeInfo.amount,
            banCase.marketOpenUntil,
            block.timestamp,
            banCase.yesVotes,
            banCase.noVotes
        );

        v.position = position;
        v.weight = voteWeight;
        v.stakedAt = stakeInfo.stakedAt;
        v.hasVoted = true;

        if (position == VotePosition.YES) {
            banCase.yesVotes += voteWeight;
        } else {
            banCase.noVotes += voteWeight;
        }

        uint256 newLockUntil = block.timestamp + CONVICTION_LOCK_PERIOD;
        if (newLockUntil > convictionLockUntil[msg.sender]) {
            convictionLockUntil[msg.sender] = newLockUntil;
        }

        emit VoteCast(caseId, msg.sender, position, voteWeight);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════

    // slither-disable-next-line reentrancy-benign,timestamp
    function resolveCase(bytes32 caseId) external nonReentrant caseExists(caseId) {
        BanCase storage banCase = cases[caseId];

        if (banCase.resolved) revert CaseAlreadyResolved();
        if (block.timestamp < banCase.marketOpenUntil) revert VotingNotEnded();

        uint256 totalVotes = banCase.yesVotes + banCase.noVotes;
        uint256 requiredQuorum = (totalStaked * ModerationRewardsLib.MIN_QUORUM_BPS) / 10000;
        bool quorumReached = totalVotes >= requiredQuorum;
        bool banUpheld = quorumReached && (banCase.yesVotes > banCase.noVotes);

        banCase.resolved = true;
        banCase.outcome = banUpheld ? MarketOutcome.BAN_UPHELD : MarketOutcome.BAN_REJECTED;
        banCase.status = banUpheld ? BanStatus.BANNED : BanStatus.CLEARED;

        emit CaseResolved(caseId, banCase.outcome, banCase.yesVotes, banCase.noVotes);

        _distributeRewards(caseId);

        if (banUpheld) {
            banManager.applyAddressBan(banCase.target, caseId, banCase.reason);
        } else {
            banManager.removeAddressBan(banCase.target);
        }

        delete activeCase[banCase.target];
        _resolveEvidenceRegistry(caseId, banUpheld);
    }

    function _resolveEvidenceRegistry(bytes32 caseId, bool banUpheld) internal {
        if (evidenceRegistry == address(0)) {
            evidenceResolutionComplete[caseId] = true;
            return;
        }

        (bool success,) = evidenceRegistry.call(abi.encodeWithSelector(_RESOLVE_CASE_SELECTOR, caseId, banUpheld));

        if (success) {
            evidenceResolutionComplete[caseId] = true;
            evidenceResolutionFailed[caseId] = false;
        } else {
            evidenceResolutionFailed[caseId] = true;
            emit EvidenceResolutionFailed(caseId);
        }
    }

    function retryEvidenceResolution(bytes32 caseId) external nonReentrant caseExists(caseId) {
        BanCase storage banCase = cases[caseId];

        if (!banCase.resolved) revert NotResolved();
        if (!evidenceResolutionFailed[caseId]) revert ResolutionDidNotFail();
        if (evidenceResolutionComplete[caseId]) revert AlreadyResolved();
        if (evidenceRegistry == address(0)) revert NoEvidenceRegistry();

        bool banUpheld = banCase.outcome == MarketOutcome.BAN_UPHELD;
        (bool success,) = evidenceRegistry.call(abi.encodeWithSelector(_RESOLVE_CASE_SELECTOR, caseId, banUpheld));

        if (success) {
            evidenceResolutionComplete[caseId] = true;
            evidenceResolutionFailed[caseId] = false;
        }

        emit EvidenceResolutionRetried(caseId, success);
    }

    // slither-disable-next-line arbitrary-send-eth
    function _distributeRewards(bytes32 caseId) internal {
        BanCase storage banCase = cases[caseId];

        bool banUpheld = banCase.outcome == MarketOutcome.BAN_UPHELD;

        // Use library to calculate distribution
        address loser = banUpheld ? banCase.target : banCase.reporter;
        ModerationRewardsLib.RewardDistribution memory dist = ModerationRewardsLib.calculateDistribution(
            banUpheld,
            banCase.reporter,
            banCase.target,
            banCase.reporterStake,
            banCase.targetStake,
            stakes[loser].amount
        );

        if (dist.loserStake == 0) return;

        // Apply slash to loser
        StakeInfo storage loserInfo = stakes[dist.loser];
        if (dist.actualSlash > 0) {
            loserInfo.amount -= dist.actualSlash;
            totalStaked -= dist.actualSlash;
            if (loserInfo.amount == 0) {
                loserInfo.isStaked = false;
            }
        }

        // Credit winner
        if (dist.winner != address(0) && dist.winnerAmount > 0) {
            StakeInfo storage winnerInfo = stakes[dist.winner];
            winnerInfo.amount += dist.winnerAmount;
            totalStaked += dist.winnerAmount;
            if (!winnerInfo.isStaked) {
                winnerInfo.isStaked = true;
                winnerInfo.stakedAt = block.timestamp;
                winnerInfo.stakedBlock = block.number;
            }
        }

        // Voter pool
        if (dist.voterPoolAmount > 0) {
            caseVoterRewardPool[caseId] = dist.voterPoolAmount;
            totalVoterRewardsDistributed += dist.voterPoolAmount;
        }

        // Treasury transfer
        if (dist.treasuryAmount > 0) {
            if (address(stakingToken) == address(0)) {
                // slither-disable-next-line low-level-calls
                (bool success,) = treasury.call{value: dist.treasuryAmount}("");
                if (!success) revert TransferFailed();
            } else {
                stakingToken.safeTransfer(treasury, dist.treasuryAmount);
            }
        }

        emit RewardsDistributed(caseId, dist.winner, dist.winnerAmount, dist.treasuryAmount);

        // Update reputation using library
        if (dist.isFailedReporter) {
            _updateReputation(banCase.reporter, false, 0, dist.actualSlash);
        } else {
            _updateReputation(banCase.reporter, true, dist.winnerAmount, 0);
        }

        _applyVoterSlashing(caseId, banUpheld);
    }

    function _applyVoterSlashing(bytes32 caseId, bool banUpheld) internal {
        if (!useVoterSlashing || address(voterSlashing) == address(0)) {
            return;
        }

        BanCase storage banCase = cases[caseId];

        uint256 reporterSlash =
            voterSlashing.recordVoteOutcome(banCase.reporter, caseId, banUpheld, banCase.reporterStake);
        if (reporterSlash > 0) {
            emit VoterSlashed(caseId, banCase.reporter, reporterSlash);
        }

        if (banCase.target != address(0) && banCase.targetStake > 0) {
            uint256 targetSlash =
                voterSlashing.recordVoteOutcome(banCase.target, caseId, !banUpheld, banCase.targetStake);
            if (targetSlash > 0) {
                emit VoterSlashed(caseId, banCase.target, targetSlash);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              APPEALS / RE-REVIEW
    // ═══════════════════════════════════════════════════════════════════════

    function requestReReview(bytes32 caseId) external payable nonReentrant caseExists(caseId) {
        BanCase storage banCase = cases[caseId];

        if (banCase.target != msg.sender) revert NotCaseParty();
        if (banCase.status != BanStatus.BANNED) revert NotBanned();
        if (banCase.appealCount >= MAX_APPEAL_COUNT) revert MaxAppealsReached();

        uint256 requiredStake = banCase.reporterStake * RE_REVIEW_MULTIPLIER;
        if (msg.value < requiredStake) revert InsufficientStake();

        StakeInfo storage stakeInfo = stakes[msg.sender];
        _checkpoint(msg.sender);
        stakeInfo.amount += msg.value;
        stakeInfo.stakedAt = block.timestamp;
        stakeInfo.stakedBlock = block.number;
        stakeInfo.lastActivityBlock = block.number;
        stakeInfo.isStaked = true;
        totalStaked += msg.value;

        uint256 reporterVoteWeight = ModerationVotingLib.sqrt(banCase.reporterStake * ModerationVotingLib.QUADRATIC_SCALE);
        uint256 appellantVoteWeight = ModerationVotingLib.sqrt(msg.value * ModerationVotingLib.QUADRATIC_SCALE);

        banCase.appealCount++;
        banCase.status = BanStatus.APPEALING;
        banCase.resolved = false;
        banCase.outcome = MarketOutcome.PENDING;
        banCase.targetStake = msg.value;
        banCase.totalPot = banCase.reporterStake + msg.value;
        banCase.yesVotes = reporterVoteWeight;
        banCase.noVotes = appellantVoteWeight;
        banCase.marketOpenUntil = block.timestamp + APPEAL_VOTING_PERIOD;

        activeCase[msg.sender] = caseId;

        votes[caseId][msg.sender] = Vote({
            position: VotePosition.NO,
            weight: appellantVoteWeight,
            stakedAt: block.timestamp,
            hasVoted: true,
            hasClaimed: false
        });

        emit AppealOpened(caseId, msg.sender, msg.value, banCase.appealCount);
        emit Staked(msg.sender, msg.value, stakeInfo.amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              FLASH LOAN PROTECTION
    // ═══════════════════════════════════════════════════════════════════════

    function _checkpoint(address user) internal {
        StakeInfo storage stakeInfo = stakes[user];
        _stakeCheckpoints[user].push(StakeCheckpoint({blockNumber: block.number, stakeAmount: stakeInfo.amount}));
        emit StakeCheckpointed(user, block.number, stakeInfo.amount);
    }

    function getStakeAtBlock(address user, uint256 blockNumber) external view returns (uint256) {
        StakeCheckpoint[] storage checkpoints = _stakeCheckpoints[user];
        if (checkpoints.length == 0) return 0;

        uint256 low = 0;
        uint256 high = checkpoints.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (checkpoints[mid].blockNumber <= blockNumber) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low > 0 ? checkpoints[low - 1].stakeAmount : 0;
    }

    // slither-disable-next-line timestamp
    function isStakeValidForVoting(address user) external view returns (bool) {
        StakeInfo storage stakeInfo = stakes[user];
        if (!stakeInfo.isStaked) return false;
        if (block.timestamp < stakeInfo.stakedAt + MIN_STAKE_AGE) return false;
        if (block.number < stakeInfo.stakedBlock + MIN_STAKE_BLOCKS) return false;
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                         VOTER REWARDS
    // ═══════════════════════════════════════════════════════════════════════

    function claimVoterReward(bytes32 caseId) external nonReentrant caseExists(caseId) {
        BanCase storage banCase = cases[caseId];
        Vote storage v = votes[caseId][msg.sender];

        if (!banCase.resolved) revert NotResolved();
        if (!v.hasVoted) revert DidNotVote();
        if (v.hasClaimed) revert AlreadyClaimed();

        bool voterWon = (banCase.outcome == MarketOutcome.BAN_UPHELD && v.position == VotePosition.YES)
            || (banCase.outcome == MarketOutcome.BAN_REJECTED && v.position == VotePosition.NO);

        if (!voterWon) revert NotOnWinningSide();

        v.hasClaimed = true;

        uint256 pool = caseVoterRewardPool[caseId];
        if (pool == 0) return;

        uint256 winningVotes = banCase.outcome == MarketOutcome.BAN_UPHELD ? banCase.yesVotes : banCase.noVotes;
        if (winningVotes == 0) return;

        uint256 reward = (pool * v.weight) / winningVotes;
        if (reward == 0) return;

        claimableVoterRewards[msg.sender] += reward;
        emit VoterRewardClaimed(caseId, msg.sender, reward);
    }

    function withdrawVoterRewards() external nonReentrant {
        uint256 amount = claimableVoterRewards[msg.sender];
        if (amount == 0) revert NoRewards();

        claimableVoterRewards[msg.sender] = 0;

        if (address(stakingToken) == address(0)) {
            (bool success,) = msg.sender.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            stakingToken.safeTransfer(msg.sender, amount);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function getCase(bytes32 caseId) external view returns (BanCase memory) {
        return cases[caseId];
    }

    function getStake(address user) external view returns (StakeInfo memory) {
        return stakes[user];
    }

    function getVote(bytes32 caseId, address voter) external view returns (Vote memory) {
        return votes[caseId][voter];
    }

    function getAllCaseIds() external view returns (bytes32[] memory) {
        return allCaseIds;
    }

    function getCaseCount() external view returns (uint256) {
        return allCaseIds.length;
    }

    // canReport moved to ModerationMarketplaceViews

    // ═══════════════════════════════════════════════════════════════════════
    //                         REPUTATION FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function getReputationTier(address user) public view returns (ReputationTier tier) {
        ModeratorReputation storage rep = moderatorReputation[user];
        uint256 score = rep.reputationScore;
        bool isNew = score == 0 && rep.successfulBans == 0 && rep.unsuccessfulBans == 0;

        // Get aggregated score if multi-oracle is enabled
        if (!isNew && useMultiOracleReputation && address(multiOracleReputation) != address(0)) {
            (uint256 aggregatedScore,,,, bool isValid) = multiOracleReputation.getAggregatedReputation(user);
            if (isValid) {
                uint256 effectiveScore = isNew ? ModerationReputationLib.INITIAL_REPUTATION : score;
                score = (effectiveScore * 6000 + aggregatedScore * 4000) / 10000;
                isNew = false;
            }
        }

        ModerationReputationLib.ReputationTier libTier = ModerationReputationLib.getTier(score, isNew);
        return ReputationTier(uint8(libTier));
    }

    function getRequiredStakeForReporter(address reporter) public view returns (uint256 requiredStake) {
        ReputationTier tier = getReputationTier(reporter);
        uint256 internalDiscountBps = ModerationReputationLib.getStakeDiscountBps(
            ModerationReputationLib.ReputationTier(uint8(tier))
        );

        uint256 externalDiscountBps = 0;
        if (address(gitHubReputationProvider) != address(0)) {
            externalDiscountBps = gitHubReputationProvider.getStakeDiscount(reporter);
        }

        return ModerationRewardsLib.calculateRequiredStake(minReporterStake, internalDiscountBps, externalDiscountBps);
    }

    function getQuorumRequired(address reporter) public view returns (uint256 quorum) {
        ReputationTier tier = getReputationTier(reporter);
        return ModerationReputationLib.getQuorumForTier(ModerationReputationLib.ReputationTier(uint8(tier)));
    }

    // getModeratorReputation and getModeratorPnL moved to ModerationMarketplaceViews

    // NOTE: checkQuorumStatus, getReportLimits, getQuorumRequirements, getCaseEvidence,
    // getConvictionLockStatus moved to ModerationMarketplaceViews contract for EIP-170 compliance

    // ═══════════════════════════════════════════════════════════════════════
    //                         REPUTATION INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function _updateReputation(address moderator, bool won, uint256 amountWon, uint256 amountLost) internal {
        ModeratorReputation storage rep = moderatorReputation[moderator];

        if (rep.reputationScore == 0 && rep.successfulBans == 0 && rep.unsuccessfulBans == 0) {
            rep.reputationScore = ModerationReputationLib.INITIAL_REPUTATION;
        }

        uint256 oldScore = rep.reputationScore;

        if (rep.activeReportCount > 0) {
            rep.activeReportCount--;
        }

        if (won) {
            rep.successfulBans++;
            rep.totalSlashedOthers += amountWon;
            rep.consecutiveWins++;
        } else {
            rep.unsuccessfulBans++;
            rep.totalSlashedFrom += amountLost;
            rep.consecutiveWins = 0;
        }

        // Use external library function (DELEGATECALL) for calculation
        ModerationReputationLib.ReputationUpdate memory update = ModerationReputationLib.calculateReputationUpdate(
            oldScore, won, amountLost, rep.consecutiveWins, rep.unsuccessfulBans
        );
        rep.reputationScore = update.newScore;
        if (update.cooldownDuration > 0) {
            rep.reportCooldownUntil = block.timestamp + update.cooldownDuration;
        }

        rep.lastActivityTimestamp = block.timestamp;

        int256 netPnL = int256(rep.totalSlashedOthers) - int256(rep.totalSlashedFrom);
        emit ReputationUpdated(
            moderator, oldScore, rep.reputationScore, rep.successfulBans, rep.unsuccessfulBans, netPnL
        );
    }

    function _initializeReputation(address moderator) internal {
        ModeratorReputation storage rep = moderatorReputation[moderator];
        if (rep.reputationScore == 0 && rep.successfulBans == 0 && rep.unsuccessfulBans == 0) {
            rep.reputationScore = ModerationReputationLib.INITIAL_REPUTATION;
            rep.lastActivityTimestamp = block.timestamp;
            rep.reportDayStart = block.timestamp;
            rep.reportWeekStart = block.timestamp;
        } else {
            _applyReputationDecay(moderator);
        }
    }

    function _applyReputationDecay(address moderator) internal {
        ModeratorReputation storage rep = moderatorReputation[moderator];

        if (rep.lastActivityTimestamp == 0) {
            rep.lastActivityTimestamp = block.timestamp;
            return;
        }

        rep.reputationScore = ModerationReputationLib.calculateDecay(
            rep.reputationScore, rep.lastActivityTimestamp, block.timestamp
        );
        rep.lastActivityTimestamp = block.timestamp;
    }

    function getEffectiveReputation(address moderator) external view returns (uint256) {
        ModeratorReputation storage rep = moderatorReputation[moderator];
        return ModerationReputationLib.calculateDecay(
            rep.reputationScore, rep.lastActivityTimestamp, block.timestamp
        );
    }

    // slither-disable-next-line incorrect-equality,timestamp
    function isBanned(address user) external view returns (bool) {
        bytes32 caseId = activeCase[user];
        if (caseId == bytes32(0)) return false;

        BanCase storage banCase = cases[caseId];
        return banCase.status == BanStatus.BANNED || banCase.status == BanStatus.ON_NOTICE;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setMinReporterStake(uint256 amount) external onlyOwner {
        uint256 oldValue = minReporterStake;
        minReporterStake = amount;
        emit ConfigUpdated("minReporterStake", oldValue, amount);
    }

    function setMinChallengeStake(uint256 amount) external onlyOwner {
        uint256 oldValue = minChallengeStake;
        minChallengeStake = amount;
        emit ConfigUpdated("minChallengeStake", oldValue, amount);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        treasury = newTreasury;
    }

    function setGitHubReputationProvider(address provider) external onlyOwner {
        gitHubReputationProvider = IGitHubReputationProvider(provider);
        emit ConfigUpdated(
            "gitHubReputationProvider", uint256(uint160(address(gitHubReputationProvider))), uint256(uint160(provider))
        );
    }

    function setEvidenceRegistry(address registry) external onlyOwner {
        address oldRegistry = evidenceRegistry;
        evidenceRegistry = registry;
        emit EvidenceRegistryUpdated(oldRegistry, registry);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                         EXTENSION SETTERS
    // ═══════════════════════════════════════════════════════════════════════

    function setCommitRevealVoting(address _extension, bool _enabled) external onlyOwner {
        commitRevealVoting = ICommitRevealVoting(_extension);
        useCommitRevealVoting = _enabled;
        emit ExtensionUpdated("CommitRevealVoting", _extension, _enabled);
    }

    function setVoterSlashing(address _extension, bool _enabled) external onlyOwner {
        voterSlashing = IVoterSlashing(_extension);
        useVoterSlashing = _enabled;
        emit ExtensionUpdated("VoterSlashing", _extension, _enabled);
    }

    function setMultiOracleReputation(address _extension, bool _enabled) external onlyOwner {
        multiOracleReputation = IMultiOracleReputation(_extension);
        useMultiOracleReputation = _enabled;
        emit ExtensionUpdated("MultiOracleReputation", _extension, _enabled);
    }

    function setCrossChainArbitration(address _extension) external onlyOwner {
        crossChainArbitration = ICrossChainArbitration(_extension);
        emit ExtensionUpdated("CrossChainArbitration", _extension, true);
    }

    function escalateToCrossChain(bytes32 caseId) external payable caseExists(caseId) {
        BanCase storage banCase = cases[caseId];
        if (banCase.resolved) revert CaseAlreadyResolved();
        if (address(crossChainArbitration) == address(0)) revert ExtensionNotEnabled();

        crossChainArbitration.escalateCase{value: msg.value}(caseId, banCase.target, banCase.reporter, banCase.reason);
        emit CaseEscalated(caseId);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    receive() external payable {}
}
