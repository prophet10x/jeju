// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "openzeppelin-contracts/contracts/utils/introspection/IERC165.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {ICrossDomainMessenger} from "./ICrossDomainMessenger.sol";

interface IPriceOracle {
    function getPrice(address token) external view returns (uint256 priceUSD, uint256 decimals);
    function isPriceFresh(address token) external view returns (bool);
    function convertAmount(address fromToken, address toToken, uint256 amount) external view returns (uint256);
}

interface IFeeDistributor {
    function distributeFees(uint256 amount, address appAddress) external;
}

interface IFeeConfigCrossChain {
    function getDeFiFees()
        external
        view
        returns (uint16 swapProtocolFeeBps, uint16 bridgeFeeBps, uint16 crossChainMarginBps);
    function getTreasury() external view returns (address);
}

/**
 * @title CrossChainPaymaster
 * @notice EIL-compliant paymaster enabling trustless cross-chain transfers and multi-token gas sponsorship.
 *         AMM/swap functionality has been extracted to CrossChainSwapRouter for code size optimization.
 */
contract CrossChainPaymaster is BasePaymaster, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    uint256 public constant REQUEST_TIMEOUT = 50;
    uint256 public constant VOUCHER_TIMEOUT = 100;
    uint256 public constant CLAIM_DELAY = 150;
    uint256 public constant MIN_FEE = 0.0001 ether;
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant DEFAULT_FEE_MARGIN = 1000;

    address public immutable l1StakeManager;
    uint256 public immutable chainId;
    ICrossDomainMessenger public messenger;

    /// @notice Price oracle for token conversions
    IPriceOracle public priceOracle;

    /// @notice Fee distributor for LP rewards
    IFeeDistributor public feeDistributor;

    /// @notice Fee margin for gas sponsorship (basis points)
    /// @dev Can be overridden by FeeConfig if set
    uint256 public feeMargin = DEFAULT_FEE_MARGIN;

    /// @notice Fee configuration contract (governance-controlled)
    IFeeConfigCrossChain public feeConfig;

    /// @notice Maximum gas cost allowed per transaction
    uint256 public maxGasCost = 0.1 ether;

    /// @notice Mapping of supported tokens
    mapping(address => bool) public supportedTokens;

    /// @notice Token exchange rates cached for gas efficiency: token => tokensPerETH (scaled by 1e18)
    mapping(address => uint256) public tokenExchangeRates;

    /// @notice Last exchange rate update timestamp per token
    mapping(address => uint256) public exchangeRateUpdatedAt;

    /// @notice Voucher request storage: requestId => VoucherRequest
    mapping(bytes32 => VoucherRequest) public voucherRequests;

    /// @notice Voucher storage: voucherId => Voucher
    mapping(bytes32 => Voucher) public vouchers;

    /// @notice XLP liquidity deposits: xlp => token => amount
    mapping(address => mapping(address => uint256)) public xlpDeposits;

    /// @notice XLP ETH deposits for gas sponsorship
    mapping(address => uint256) public xlpETHDeposits;

    /// @notice Total liquidity per token across all XLPs
    mapping(address => uint256) public totalTokenLiquidity;

    /// @notice Total ETH liquidity across all XLPs
    uint256 public totalETHLiquidity;

    /// @notice Active request count per XLP (for stake requirements)
    mapping(address => uint256) public xlpActiveRequests;

    /// @notice Verified XLP stakes (cached from L1)
    mapping(address => uint256) public xlpVerifiedStake;

    /// @notice Request ID to claiming XLP
    mapping(bytes32 => address) public requestClaimedBy;

    /// @notice Track fulfilled voucher hashes to prevent replay attacks
    mapping(bytes32 => bool) public fulfilledVoucherHashes;

    /// @notice Total gas fees collected (in selected tokens)
    uint256 public totalGasFeesCollected;

    /// @notice XLP statistics for competition tracking
    mapping(address => XLPStats) public xlpStats;

    /// @notice Request XLP allowlist: requestId => xlp => allowed
    mapping(bytes32 => mapping(address => bool)) public requestAllowlist;

    /// @notice Whether request has an allowlist set (if false, any XLP can bid)
    mapping(bytes32 => bool) public requestHasAllowlist;

    /// @notice XLP bid submissions for fee auction: requestId => xlp => bidBlock
    mapping(bytes32 => mapping(address => uint256)) public xlpBids;

    /// @notice All XLPs that bid on a request: requestId => XLPs array
    mapping(bytes32 => address[]) public requestBidders;

    /// @notice Total competition wins per XLP
    mapping(address => uint256) public xlpWins;

    /// @notice Total requests processed
    uint256 public totalRequestsProcessed;

    /// @notice Request nonce for unique ID generation
    uint256 private _requestNonce;

    /// @notice Total XLP competition events
    uint256 public totalCompetitionEvents;

    // ============ Structs ============

    struct VoucherRequest {
        address requester;
        address token;
        uint256 amount;
        address destinationToken;
        uint256 destinationChainId;
        address recipient;
        uint256 gasOnDestination;
        uint256 maxFee;
        uint256 feeIncrement;
        uint256 deadline;
        uint256 createdBlock;
        bool claimed;
        bool expired;
        bool refunded;
        // Multi-XLP Competition fields
        uint256 bidCount; // Number of XLP bids received
        address winningXLP; // XLP that won the auction
        uint256 winningFee; // Fee at which voucher was issued
    }

    /// @notice XLP competition statistics
    struct XLPStats {
        uint256 totalBids; // Total bids submitted
        uint256 wonBids; // Bids won
        uint256 lostBids; // Bids lost to competition
        uint256 totalVolume; // Total volume fulfilled
        uint256 totalFeesEarned; // Total fees earned
        uint256 avgResponseTime; // Average response time in blocks
        uint256 lastActiveBlock; // Last activity block
    }

    struct Voucher {
        bytes32 requestId;
        address xlp;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourceToken;
        address destinationToken;
        uint256 amount;
        uint256 fee;
        uint256 gasProvided;
        uint256 issuedBlock;
        uint256 expiresBlock;
        bool fulfilled;
        bool slashed;
        bool claimed; // Track if source funds have been claimed
    }

    /// @notice Gas payment context for 4337 UserOperations
    struct GasPaymentContext {
        address user;
        address paymentToken;
        uint256 maxTokenAmount;
        address appAddress;
        bool useCrossChainLiquidity;
    }

    event VoucherRequested(
        bytes32 indexed requestId,
        address indexed requester,
        address token,
        uint256 amount,
        uint256 destinationChainId,
        address recipient,
        uint256 maxFee,
        uint256 deadline
    );

    event VoucherIssued(bytes32 indexed voucherId, bytes32 indexed requestId, address indexed xlp, uint256 fee);

    event VoucherFulfilled(bytes32 indexed voucherId, address indexed recipient, uint256 amount);

    event VoucherExpired(bytes32 indexed requestId, address indexed requester);

    event FundsRefunded(bytes32 indexed requestId, address indexed requester, uint256 amount);

    event XLPDeposit(address indexed xlp, address indexed token, uint256 amount);

    event XLPWithdraw(address indexed xlp, address indexed token, uint256 amount);

    event XLPStakeVerified(address indexed xlp, uint256 stake);

    event SourceFundsClaimed(bytes32 indexed requestId, address indexed xlp, uint256 amount, uint256 fee);

    event TokenSupportUpdated(address indexed token, bool supported);

    event GasSponsored(
        address indexed user,
        address indexed paymentToken,
        uint256 gasCostETH,
        uint256 tokensCharged,
        address appAddress
    );

    event ExchangeRateUpdated(address indexed token, uint256 newRate, uint256 timestamp);
    event PriceOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event FeeDistributorUpdated(address indexed oldDistributor, address indexed newDistributor);
    event AppTokenPreferenceUpdated(address indexed oldPreference, address indexed newPreference);
    event FeeMarginUpdated(uint256 oldMargin, uint256 newMargin);
    event XLPBidSubmitted(bytes32 indexed requestId, address indexed xlp, uint256 bidFee, uint256 bidBlock, uint256 totalBids);
    event XLPCompetitionWon(bytes32 indexed requestId, address indexed winner, uint256 winningFee, uint256 competitorCount);
    event XLPCompetitionLost(bytes32 indexed requestId, address indexed loser, address indexed winner, uint256 loserBidFee, uint256 winnerBidFee);
    event RequestAllowlistSet(bytes32 indexed requestId, address[] allowedXLPs);
    event XLPStatsUpdated(address indexed xlp, uint256 totalBids, uint256 wonBids, uint256 totalVolume);

    error UnsupportedToken();
    error InsufficientAmount();
    error InsufficientFee();
    error RequestExpired();
    error RequestNotExpired();
    error RequestAlreadyClaimed();
    error RequestAlreadyRefunded();
    error VoucherExpiredError();
    error VoucherAlreadyFulfilled();
    error InvalidVoucherSignature();
    error InsufficientXLPLiquidity();
    error InsufficientXLPStake();
    error ClaimDelayNotPassed();
    error InvalidDestinationChain();
    error OnlyXLP();
    error Unauthorized();
    error TransferFailed();
    error InvalidRecipient();
    error VoucherAlreadyClaimed();
    error StaleOraclePrice();
    error GasCostTooHigh();
    error InsufficientTokenBalance();
    error InsufficientTokenAllowance();
    error InvalidPaymasterData();
    error XLPNotInAllowlist();
    error XLPAlreadyBid();

    constructor(
        IEntryPoint _entryPoint,
        address _l1StakeManager,
        uint256 _chainId,
        address _priceOracle,
        address _owner
    ) BasePaymaster(_entryPoint, _owner == address(0) ? msg.sender : _owner) {
        require(_l1StakeManager != address(0), "Invalid stake manager");
        l1StakeManager = _l1StakeManager;
        chainId = _chainId;
        messenger = ICrossDomainMessenger(0x4200000000000000000000000000000000000007);
        if (_priceOracle != address(0)) {
            priceOracle = IPriceOracle(_priceOracle);
        }
    }

    function _validateEntryPointInterface(IEntryPoint _entryPoint) internal view override {
        require(address(_entryPoint).code.length > 0, "EntryPoint has no code");
        try IERC165(address(_entryPoint)).supportsInterface(type(IEntryPoint).interfaceId) returns (bool supported) {
            require(supported, "IEntryPoint interface mismatch");
        } catch {}
    }

    function setMessenger(address _messenger) external onlyOwner {
        messenger = ICrossDomainMessenger(_messenger);
    }

    function setPriceOracle(address _priceOracle) external onlyOwner {
        require(_priceOracle != address(0), "Invalid oracle");
        address oldOracle = address(priceOracle);
        priceOracle = IPriceOracle(_priceOracle);
        emit PriceOracleUpdated(oldOracle, _priceOracle);
    }

    function setFeeDistributor(address _feeDistributor) external onlyOwner {
        require(_feeDistributor != address(0), "Invalid distributor");
        address oldDistributor = address(feeDistributor);
        feeDistributor = IFeeDistributor(_feeDistributor);
        emit FeeDistributorUpdated(oldDistributor, _feeDistributor);
    }

    function setFeeMargin(uint256 _feeMargin) external onlyOwner {
        require(_feeMargin <= 2000, "Margin too high");
        uint256 oldMargin = feeMargin;
        feeMargin = _feeMargin;
        emit FeeMarginUpdated(oldMargin, _feeMargin);
    }

    function setFeeConfig(address _feeConfig) external onlyOwner {
        address oldConfig = address(feeConfig);
        feeConfig = IFeeConfigCrossChain(_feeConfig);
        emit FeeConfigUpdated(oldConfig, _feeConfig);
    }

    function getEffectiveFeeMargin() external view returns (uint256) {
        return _getFeeMargin();
    }

    function _getFeeMargin() internal view returns (uint256) {
        if (address(feeConfig) != address(0)) {
            (,, uint16 crossChainMarginBps) = feeConfig.getDeFiFees();
            return crossChainMarginBps;
        }
        return feeMargin;
    }

    event FeeConfigUpdated(address indexed oldConfig, address indexed newConfig);

    function setMaxGasCost(uint256 _maxGasCost) external onlyOwner {
        maxGasCost = _maxGasCost;
    }

    function setTokenSupport(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    function createVoucherRequest(
        address token,
        uint256 amount,
        address destinationToken,
        uint256 destinationChainId,
        address recipient,
        uint256 gasOnDestination,
        uint256 maxFee,
        uint256 feeIncrement
    ) external payable nonReentrant returns (bytes32 requestId) {
        address[] memory empty = new address[](0);
        return _createVoucherRequest(
            token,
            amount,
            destinationToken,
            destinationChainId,
            recipient,
            gasOnDestination,
            maxFee,
            feeIncrement,
            empty
        );
    }

    function createVoucherRequestWithAllowlist(
        address token,
        uint256 amount,
        address destinationToken,
        uint256 destinationChainId,
        address recipient,
        uint256 gasOnDestination,
        uint256 maxFee,
        uint256 feeIncrement,
        address[] calldata allowedXLPs
    ) external payable nonReentrant returns (bytes32 requestId) {
        return _createVoucherRequest(
            token,
            amount,
            destinationToken,
            destinationChainId,
            recipient,
            gasOnDestination,
            maxFee,
            feeIncrement,
            allowedXLPs
        );
    }

    function _createVoucherRequest(
        address token,
        uint256 amount,
        address destinationToken,
        uint256 destinationChainId,
        address recipient,
        uint256 gasOnDestination,
        uint256 maxFee,
        uint256 feeIncrement,
        address[] memory allowedXLPs
    ) internal returns (bytes32 requestId) {
        if (!supportedTokens[token]) revert UnsupportedToken();
        if (amount == 0) revert InsufficientAmount();
        if (maxFee < MIN_FEE) revert InsufficientFee();
        if (destinationChainId == chainId) revert InvalidDestinationChain();
        if (recipient == address(0)) revert InvalidRecipient();

        uint256 excessRefund;
        if (token == address(0)) {
            uint256 required = amount + maxFee;
            if (msg.value < required) revert InsufficientAmount();
            excessRefund = msg.value - required;
        } else {
            if (msg.value < maxFee) revert InsufficientFee();
            excessRefund = msg.value - maxFee;
        }

        requestId = keccak256(
            abi.encodePacked(
                msg.sender, token, amount, destinationChainId, block.number, block.timestamp, ++_requestNonce
            )
        );

        voucherRequests[requestId] = VoucherRequest({
            requester: msg.sender,
            token: token,
            amount: amount,
            destinationToken: destinationToken,
            destinationChainId: destinationChainId,
            recipient: recipient,
            gasOnDestination: gasOnDestination,
            maxFee: maxFee,
            feeIncrement: feeIncrement,
            deadline: block.number + REQUEST_TIMEOUT,
            createdBlock: block.number,
            claimed: false,
            expired: false,
            refunded: false,
            bidCount: 0,
            winningXLP: address(0),
            winningFee: 0
        });

        if (allowedXLPs.length > 0) {
            requestHasAllowlist[requestId] = true;
            for (uint256 i = 0; i < allowedXLPs.length; i++) {
                requestAllowlist[requestId][allowedXLPs[i]] = true;
            }
            emit RequestAllowlistSet(requestId, allowedXLPs);
        }

        emit VoucherRequested(
            requestId, msg.sender, token, amount, destinationChainId, recipient, maxFee, block.number + REQUEST_TIMEOUT
        );

        if (token != address(0)) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }

        if (excessRefund > 0) {
            (bool success,) = msg.sender.call{value: excessRefund}("");
            if (!success) revert TransferFailed();
        }
    }

    function getCurrentFee(bytes32 requestId) public view returns (uint256 currentFee) {
        VoucherRequest storage request = voucherRequests[requestId];
        if (request.requester == address(0)) return 0;

        uint256 elapsedBlocks = block.number - request.createdBlock;
        currentFee = MIN_FEE + (elapsedBlocks * request.feeIncrement);
        if (currentFee > request.maxFee) currentFee = request.maxFee;
    }

    function submitBid(bytes32 requestId) external nonReentrant {
        VoucherRequest storage request = voucherRequests[requestId];

        if (request.requester == address(0)) revert Unauthorized();
        if (request.claimed) revert RequestAlreadyClaimed();
        if (request.expired || block.number > request.deadline) revert RequestExpired();
        if (requestHasAllowlist[requestId] && !requestAllowlist[requestId][msg.sender]) {
            revert XLPNotInAllowlist();
        }
        if (xlpBids[requestId][msg.sender] > 0) revert XLPAlreadyBid();

        xlpBids[requestId][msg.sender] = block.number;
        requestBidders[requestId].push(msg.sender);
        request.bidCount++;
        xlpStats[msg.sender].totalBids++;
        xlpStats[msg.sender].lastActiveBlock = block.number;

        emit XLPBidSubmitted(requestId, msg.sender, getCurrentFee(requestId), block.number, request.bidCount);
    }

    function getRequestCompetition(bytes32 requestId)
        external
        view
        returns (uint256 bidCount, uint256 currentFee, address[] memory bidders, bool hasAllowlist)
    {
        VoucherRequest storage request = voucherRequests[requestId];
        return (request.bidCount, getCurrentFee(requestId), requestBidders[requestId], requestHasAllowlist[requestId]);
    }

    function isXLPAllowed(bytes32 requestId, address xlp) external view returns (bool) {
        if (!requestHasAllowlist[requestId]) return true;
        return requestAllowlist[requestId][xlp];
    }

    function getXLPStats(address xlp) external view returns (XLPStats memory) {
        return xlpStats[xlp];
    }

    function getGlobalCompetitionStats()
        external
        view
        returns (uint256 totalRequests, uint256 totalCompetitions, uint256 avgBidsPerRequest)
    {
        totalRequests = totalRequestsProcessed;
        totalCompetitions = totalCompetitionEvents;
        if (totalRequests > 0) {
            avgBidsPerRequest = (totalCompetitions * 100) / totalRequests;
        }
    }

    function refundExpiredRequest(bytes32 requestId) external nonReentrant {
        VoucherRequest storage request = voucherRequests[requestId];

        if (request.requester == address(0)) revert Unauthorized();
        if (request.claimed) revert RequestAlreadyClaimed();
        if (request.refunded) revert RequestAlreadyRefunded();
        if (block.number <= request.deadline) revert RequestNotExpired();

        address requester = request.requester;
        address token = request.token;
        uint256 amount = request.amount;
        uint256 maxFee = request.maxFee;

        request.expired = true;
        request.refunded = true;

        emit VoucherExpired(requestId, requester);
        emit FundsRefunded(requestId, requester, amount);

        if (token == address(0)) {
            _transferETH(requester, amount + maxFee);
        } else {
            IERC20(token).safeTransfer(requester, amount);
            if (maxFee > 0) _transferETH(requester, maxFee);
        }
    }

    function _transferETH(address to, uint256 amount) internal {
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function depositLiquidity(address token, uint256 amount) external nonReentrant {
        if (!supportedTokens[token]) revert UnsupportedToken();
        if (amount == 0) revert InsufficientAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        xlpDeposits[msg.sender][token] += amount;
        totalTokenLiquidity[token] += amount;

        emit XLPDeposit(msg.sender, token, amount);
    }

    function depositETH() external payable nonReentrant {
        if (msg.value == 0) revert InsufficientAmount();
        xlpETHDeposits[msg.sender] += msg.value;
        totalETHLiquidity += msg.value;
        emit XLPDeposit(msg.sender, address(0), msg.value);
    }

    function withdrawLiquidity(address token, uint256 amount) external nonReentrant {
        if (xlpDeposits[msg.sender][token] < amount) revert InsufficientXLPLiquidity();

        xlpDeposits[msg.sender][token] -= amount;
        totalTokenLiquidity[token] -= amount;
        emit XLPWithdraw(msg.sender, token, amount);

        IERC20(token).safeTransfer(msg.sender, amount);
    }

    function withdrawETH(uint256 amount) external nonReentrant {
        if (xlpETHDeposits[msg.sender] < amount) revert InsufficientXLPLiquidity();

        xlpETHDeposits[msg.sender] -= amount;
        totalETHLiquidity -= amount;
        emit XLPWithdraw(msg.sender, address(0), amount);
        _transferETH(msg.sender, amount);
    }

    function updateExchangeRate(address token) external {
        require(address(priceOracle) != address(0), "Oracle not set");
        require(supportedTokens[token], "Token not supported");

        uint256 rate = priceOracle.convertAmount(address(0), token, 1 ether);
        tokenExchangeRates[token] = rate;
        exchangeRateUpdatedAt[token] = block.timestamp;
        emit ExchangeRateUpdated(token, rate, block.timestamp);
    }

    function batchUpdateExchangeRates(address[] calldata tokens) external {
        require(address(priceOracle) != address(0), "Oracle not set");

        for (uint256 i = 0; i < tokens.length; i++) {
            if (supportedTokens[tokens[i]]) {
                uint256 rate = priceOracle.convertAmount(address(0), tokens[i], 1 ether);
                tokenExchangeRates[tokens[i]] = rate;
                exchangeRateUpdatedAt[tokens[i]] = block.timestamp;
                emit ExchangeRateUpdated(tokens[i], rate, block.timestamp);
            }
        }
    }

    function updateXLPStake(address xlp, uint256 stake) external {
        bool isL1Message = msg.sender == address(messenger) && messenger.xDomainMessageSender() == l1StakeManager;
        require(msg.sender == owner() || isL1Message, "Unauthorized");

        xlpVerifiedStake[xlp] = stake;
        emit XLPStakeVerified(xlp, stake);
    }

    function markVoucherFulfilled(bytes32 voucherId) external {
        bool isL1Message = msg.sender == address(messenger) && messenger.xDomainMessageSender() == l1StakeManager;
        require(msg.sender == owner() || isL1Message, "Unauthorized");
        require(vouchers[voucherId].xlp != address(0), "Voucher not found");
        require(!vouchers[voucherId].fulfilled, "Already fulfilled");

        vouchers[voucherId].fulfilled = true;
        VoucherRequest storage request = voucherRequests[vouchers[voucherId].requestId];
        emit VoucherFulfilled(voucherId, request.recipient, vouchers[voucherId].amount);
    }

    /**
     * @notice Issue a voucher to fulfill a request (XLP only)
     * @param requestId Request to fulfill
     * @param signature XLP's signature on the voucher commitment
     * @return voucherId Unique voucher identifier
     */
    function issueVoucher(bytes32 requestId, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 voucherId)
    {
        VoucherRequest storage request = voucherRequests[requestId];

        if (request.requester == address(0)) revert Unauthorized();
        if (request.claimed) revert RequestAlreadyClaimed();
        if (request.expired || block.number > request.deadline) revert RequestExpired();

        // Check XLP allowlist if set
        if (requestHasAllowlist[requestId] && !requestAllowlist[requestId][msg.sender]) {
            revert XLPNotInAllowlist();
        }

        // Verify XLP has sufficient stake (10% of transfer amount, minimum 0.01 ETH)
        uint256 requiredStake = request.amount / 10;
        if (requiredStake < 0.01 ether) requiredStake = 0.01 ether;
        if (xlpVerifiedStake[msg.sender] < requiredStake) revert InsufficientXLPStake();

        // Calculate fee based on current block
        uint256 fee = getCurrentFee(requestId);

        // Generate voucher ID
        voucherId = keccak256(abi.encodePacked(requestId, msg.sender, block.number, signature));

        // Verify signature (XLP commits to fulfill)
        bytes32 commitment =
            keccak256(abi.encodePacked(requestId, msg.sender, request.amount, fee, request.destinationChainId));
        address signer = commitment.toEthSignedMessageHash().recover(signature);
        if (signer != msg.sender) revert InvalidVoucherSignature();

        // Mark request as claimed
        request.claimed = true;
        request.winningXLP = msg.sender;
        request.winningFee = fee;
        requestClaimedBy[requestId] = msg.sender;
        xlpActiveRequests[msg.sender]++;

        // Update competition tracking
        totalRequestsProcessed++;
        xlpWins[msg.sender]++;

        // Update XLP stats for winner
        XLPStats storage winnerStats = xlpStats[msg.sender];
        winnerStats.wonBids++;
        winnerStats.totalVolume += request.amount;
        winnerStats.totalFeesEarned += fee;
        winnerStats.lastActiveBlock = block.number;

        // Calculate response time (blocks since request created)
        if (winnerStats.avgResponseTime == 0) {
            winnerStats.avgResponseTime = block.number - request.createdBlock;
        } else {
            // Moving average
            winnerStats.avgResponseTime = (winnerStats.avgResponseTime + block.number - request.createdBlock) / 2;
        }

        // Track competition - emit events for other bidders who lost
        address[] storage bidders = requestBidders[requestId];
        if (bidders.length > 1) {
            totalCompetitionEvents++;
            for (uint256 i = 0; i < bidders.length; i++) {
                if (bidders[i] != msg.sender) {
                    xlpStats[bidders[i]].lostBids++;
                    emit XLPCompetitionLost(requestId, bidders[i], msg.sender, 0, fee);
                }
            }
        }

        // Emit competition won event
        emit XLPCompetitionWon(requestId, msg.sender, fee, bidders.length > 0 ? bidders.length : 1);

        emit XLPStatsUpdated(msg.sender, winnerStats.totalBids, winnerStats.wonBids, winnerStats.totalVolume);

        // Store voucher
        vouchers[voucherId] = Voucher({
            requestId: requestId,
            xlp: msg.sender,
            sourceChainId: chainId,
            destinationChainId: request.destinationChainId,
            sourceToken: request.token,
            destinationToken: request.destinationToken,
            amount: request.amount,
            fee: fee,
            gasProvided: request.gasOnDestination,
            issuedBlock: block.number,
            expiresBlock: block.number + VOUCHER_TIMEOUT,
            fulfilled: false,
            slashed: false,
            claimed: false
        });

        emit VoucherIssued(voucherId, requestId, msg.sender, fee);
    }

    /**
     * @notice Claim source funds after claim delay (XLP only)
     * @param voucherId Voucher ID
     * @dev Only callable after CLAIM_DELAY blocks and if voucher was fulfilled on destination
     *      XLP receives: amount (locked tokens) + fee (for their service)
     * @custom:security CEI pattern: Update all state before external calls
     */
    function claimSourceFunds(bytes32 voucherId) external nonReentrant {
        Voucher storage voucher = vouchers[voucherId];
        VoucherRequest storage request = voucherRequests[voucher.requestId];

        if (voucher.xlp != msg.sender) revert OnlyXLP();
        if (!voucher.fulfilled) revert VoucherExpiredError(); // Must be fulfilled first
        if (voucher.slashed) revert Unauthorized();
        if (voucher.claimed) revert VoucherAlreadyClaimed(); // Prevent double-claim
        if (block.number < voucher.issuedBlock + CLAIM_DELAY) revert ClaimDelayNotPassed();

        // Cache values
        uint256 xlpReceives = request.amount;
        uint256 feeReceived = voucher.fee;
        address token = request.token;
        bytes32 requestId = voucher.requestId;

        // EFFECTS: Update ALL state BEFORE external calls (CEI pattern)
        voucher.claimed = true;
        xlpActiveRequests[msg.sender]--;

        // Emit event before external calls
        emit SourceFundsClaimed(requestId, msg.sender, xlpReceives, feeReceived);

        // INTERACTIONS: External calls last
        if (token == address(0)) {
            _transferETH(msg.sender, xlpReceives + feeReceived);
        } else {
            IERC20(token).safeTransfer(msg.sender, xlpReceives);
            if (feeReceived > 0) _transferETH(msg.sender, feeReceived);
        }
    }

    /**
     * @notice Fulfill a voucher on the destination chain
     * @param voucherId Voucher to fulfill
     * @param xlpSignature XLP's signature proving voucher validity
     * @dev Called by user's UserOp on destination chain
     * @custom:security CEI pattern: Update all state before external calls
     */
    function fulfillVoucher(
        bytes32 voucherId,
        bytes32 requestId,
        address xlp,
        address token,
        uint256 amount,
        address recipient,
        uint256 gasAmount,
        bytes calldata xlpSignature
    ) external nonReentrant {
        // Verify voucher signature from XLP
        bytes32 voucherHash =
            keccak256(abi.encodePacked(voucherId, requestId, xlp, token, amount, recipient, gasAmount, chainId));

        // Prevent replay attacks
        if (fulfilledVoucherHashes[voucherHash]) revert VoucherAlreadyFulfilled();

        address signer = voucherHash.toEthSignedMessageHash().recover(xlpSignature);
        if (signer != xlp) revert InvalidVoucherSignature();

        // Verify XLP has liquidity first
        if (token == address(0)) {
            if (xlpETHDeposits[xlp] < amount + gasAmount) revert InsufficientXLPLiquidity();
        } else {
            if (xlpDeposits[xlp][token] < amount) revert InsufficientXLPLiquidity();
            if (gasAmount > 0 && xlpETHDeposits[xlp] < gasAmount) revert InsufficientXLPLiquidity();
        }

        // EFFECTS: Update ALL state BEFORE external calls (CEI pattern)
        fulfilledVoucherHashes[voucherHash] = true;
        vouchers[voucherId].fulfilled = true;

        if (token == address(0)) {
            xlpETHDeposits[xlp] -= amount + gasAmount;
        } else {
            xlpDeposits[xlp][token] -= amount;
            if (gasAmount > 0) {
                xlpETHDeposits[xlp] -= gasAmount;
            }
        }

        // Emit event before external calls
        emit VoucherFulfilled(voucherId, recipient, amount);

        // INTERACTIONS: External calls last
        if (token == address(0)) {
            _transferETH(recipient, amount + gasAmount);
        } else {
            IERC20(token).safeTransfer(recipient, amount);
            if (gasAmount > 0) _transferETH(recipient, gasAmount);
        }
    }

    /**
     * @notice Validate UserOp with multi-token gas payment support
     * @dev User pays gas with any supported token
     *
     * paymasterAndData format:
     * [paymaster(20)][verificationGas(16)][postOpGas(16)][mode(1)][token(20)][appAddress(20)]
     */
    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, /*userOpHash*/ uint256 maxCost)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        // Check gas cost limit
        if (maxCost > maxGasCost) revert GasCostTooHigh();

        // Minimum data: paymaster(20) + verificationGas(16) + postOpGas(16) + mode(1) = 53 bytes
        if (userOp.paymasterAndData.length < 53) {
            return ("", 1); // Invalid
        }

        // Parse mode byte (position 52) - must be 0 for token payment
        uint8 mode = uint8(userOp.paymasterAndData[52]);
        if (mode != 0) {
            return ("", 1); // Invalid mode
        }

        return _validateTokenPayment(userOp, maxCost);
    }

    /**
     * @notice Validate token payment for gas sponsorship
     * @dev User pays gas with any supported token. XLP pool provides ETH.
     */
    function _validateTokenPayment(PackedUserOperation calldata userOp, uint256 maxCost)
        internal
        view
        returns (bytes memory context, uint256 validationData)
    {
        // Format: [mode(1)][token(20)][appAddress(20)] starting at position 52
        if (userOp.paymasterAndData.length < 93) {
            return ("", 1);
        }

        address paymentToken = address(bytes20(userOp.paymasterAndData[53:73]));
        address appAddress = address(bytes20(userOp.paymasterAndData[73:93]));

        // Verify token is supported
        if (!supportedTokens[paymentToken]) {
            return ("", 1);
        }

        // Check oracle freshness if oracle is set
        if (address(priceOracle) != address(0) && !priceOracle.isPriceFresh(paymentToken)) {
            return ("", 1);
        }

        // Calculate token cost with fee margin
        uint256 maxTokenAmount = _calculateTokenCost(maxCost, paymentToken);

        // Verify user has sufficient balance and allowance
        address sender = userOp.sender;
        uint256 userBalance = IERC20(paymentToken).balanceOf(sender);
        if (userBalance < maxTokenAmount) {
            return ("", 1);
        }

        uint256 userAllowance = IERC20(paymentToken).allowance(sender, address(this));
        if (userAllowance < maxTokenAmount) {
            return ("", 1);
        }

        // Verify pool has enough ETH liquidity to sponsor gas
        // Use totalETHLiquidity as the available pool
        uint256 entryPointDeposit = entryPoint().balanceOf(address(this));
        if (entryPointDeposit < maxCost) {
            return ("", 1);
        }

        context = abi.encode(
            GasPaymentContext({
                user: sender,
                paymentToken: paymentToken,
                maxTokenAmount: maxTokenAmount,
                appAddress: appAddress,
                useCrossChainLiquidity: true
            })
        );

        return (context, 0);
    }

    /**
     * @notice Post-operation callback - collect tokens and distribute fees
     */
    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 /*actualUserOpFeePerGas*/ )
        internal
        override
    {
        // Token payment mode
        GasPaymentContext memory ctx = abi.decode(context, (GasPaymentContext));
        _handleTokenPaymentPostOp(mode, ctx, actualGasCost);
    }

    /**
     * @notice Handle post-op for token payment mode
     */
    function _handleTokenPaymentPostOp(PostOpMode mode, GasPaymentContext memory ctx, uint256 actualGasCost) internal {
        // Only charge if operation succeeded or reverted (not on postOp revert)
        if (mode == PostOpMode.opSucceeded || mode == PostOpMode.opReverted) {
            // Calculate actual token cost
            uint256 actualTokenCost = _calculateTokenCost(actualGasCost, ctx.paymentToken);

            // Cap at max to prevent overcharging
            if (actualTokenCost > ctx.maxTokenAmount) {
                actualTokenCost = ctx.maxTokenAmount;
            }

            // Collect tokens from user
            IERC20(ctx.paymentToken).safeTransferFrom(ctx.user, address(this), actualTokenCost);

            // Update totals
            totalGasFeesCollected += actualTokenCost;
            totalTokenLiquidity[ctx.paymentToken] += actualTokenCost;

            // Distribute fees if distributor is set
            if (address(feeDistributor) != address(0) && ctx.appAddress != address(0)) {
                IERC20(ctx.paymentToken).forceApprove(address(feeDistributor), actualTokenCost);
                feeDistributor.distributeFees(actualTokenCost, ctx.appAddress);
            }

            emit GasSponsored(ctx.user, ctx.paymentToken, actualGasCost, actualTokenCost, ctx.appAddress);
        }
    }

    /**
     * @notice Calculate token amount needed for gas cost
     * @param gasCostETH Gas cost in ETH (wei)
     * @param token Payment token address
     * @return tokenAmount Amount of tokens needed
     */
    function _calculateTokenCost(uint256 gasCostETH, address token) internal view returns (uint256 tokenAmount) {
        // Use cached exchange rate if fresh (< 1 hour old)
        if (exchangeRateUpdatedAt[token] > block.timestamp - 1 hours && tokenExchangeRates[token] > 0) {
            tokenAmount = (gasCostETH * tokenExchangeRates[token]) / 1 ether;
        } else if (address(priceOracle) != address(0)) {
            // Fall back to oracle
            tokenAmount = priceOracle.convertAmount(address(0), token, gasCostETH);
        } else {
            // Default 1:1 if no oracle
            tokenAmount = gasCostETH;
        }

        // Add fee margin (governance-controlled via FeeConfig)
        tokenAmount = (tokenAmount * (BASIS_POINTS + _getFeeMargin())) / BASIS_POINTS;
    }

    /**
     * @notice Preview token cost for a given gas estimate
     * @param estimatedGas Estimated gas units
     * @param gasPrice Gas price in wei
     * @param token Payment token address
     * @return tokenCost Estimated token cost
     */
    function previewTokenCost(uint256 estimatedGas, uint256 gasPrice, address token)
        external
        view
        returns (uint256 tokenCost)
    {
        uint256 gasCostETH = estimatedGas * gasPrice;
        return _calculateTokenCost(gasCostETH, token);
    }

    function getXLPLiquidity(address xlp, address token) external view returns (uint256) {
        return xlpDeposits[xlp][token];
    }

    function getXLPETH(address xlp) external view returns (uint256) {
        return xlpETHDeposits[xlp];
    }

    function canFulfillRequest(bytes32 requestId) external view returns (bool) {
        VoucherRequest storage request = voucherRequests[requestId];
        return request.requester != address(0) && !request.claimed && !request.expired && block.number <= request.deadline;
    }

    function getRequest(bytes32 requestId) external view returns (VoucherRequest memory) {
        return voucherRequests[requestId];
    }

    function getVoucher(bytes32 voucherId) external view returns (Voucher memory) {
        return vouchers[voucherId];
    }

    function getTotalLiquidity(address token) external view returns (uint256) {
        if (token == address(0)) return totalETHLiquidity;
        return totalTokenLiquidity[token];
    }

    function canSponsor(uint256 gasCost, address paymentToken, address userAddress)
        external
        view
        returns (bool canSponsorTx, uint256 tokenCost, uint256 userBal)
    {
        if (!supportedTokens[paymentToken]) return (false, 0, 0);
        tokenCost = _calculateTokenCost(gasCost, paymentToken);
        userBal = IERC20(paymentToken).balanceOf(userAddress);
        uint256 userAllowance = IERC20(paymentToken).allowance(userAddress, address(this));
        uint256 entryPointBalance = entryPoint().balanceOf(address(this));
        canSponsorTx = userBal >= tokenCost && userAllowance >= tokenCost && entryPointBalance >= gasCost;
    }

    function fundEntryPoint() external payable onlyOwner {
        entryPoint().depositTo{value: msg.value}(address(this));
    }

    function refillEntryPoint(uint256 amount) external onlyOwner {
        require(totalETHLiquidity >= amount, "Insufficient pool liquidity");
        entryPoint().depositTo{value: amount}(address(this));
    }

    receive() external payable {}

    function version() external pure returns (string memory) {
        return "3.0.0";
    }
}
