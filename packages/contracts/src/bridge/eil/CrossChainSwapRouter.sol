// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

interface IFeeConfigCrossChain {
    function getDeFiFees()
        external
        view
        returns (uint16 swapProtocolFeeBps, uint16 bridgeFeeBps, uint16 crossChainMarginBps);
    function getTreasury() external view returns (address);
}

/**
 * @title CrossChainSwapRouter
 * @notice AMM swap functionality extracted from CrossChainPaymaster for code size optimization.
 *         Uses constant-product (xy=k) formula with XLP liquidity pools.
 */
contract CrossChainSwapRouter is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10000;

    /// @notice Swap fee in basis points (30 = 0.3%)
    uint256 public swapFeeBps = 30;

    /// @notice Total swap volume
    uint256 public totalSwapVolume;

    /// @notice Total swap fees collected
    uint256 public totalSwapFees;

    /// @notice Protocol's accumulated swap fees (claimable by treasury)
    uint256 public protocolSwapFees;

    /// @notice Fee configuration contract (governance-controlled)
    IFeeConfigCrossChain public feeConfig;

    /// @notice Mapping of supported tokens
    mapping(address => bool) public supportedTokens;

    /// @notice Total liquidity per token across all XLPs
    mapping(address => uint256) public totalTokenLiquidity;

    /// @notice Total ETH liquidity across all XLPs
    uint256 public totalETHLiquidity;

    /// @notice XLP liquidity deposits: xlp => token => amount
    mapping(address => mapping(address => uint256)) public xlpDeposits;

    /// @notice XLP ETH deposits
    mapping(address => uint256) public xlpETHDeposits;

    error InsufficientAmount();
    error UnsupportedToken();
    error InsufficientPoolLiquidity();
    error TransferFailed();

    event Swap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );

    event SwapFeeUpdated(uint256 oldFee, uint256 newFee);
    event ProtocolFeesClaimed(address indexed treasury, uint256 amount);
    event TokenSupportUpdated(address indexed token, bool supported);
    event XLPDeposit(address indexed xlp, address indexed token, uint256 amount);
    event XLPWithdraw(address indexed xlp, address indexed token, uint256 amount);

    constructor(address _owner) Ownable(_owner) {}

    function setTokenSupport(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    function setFeeConfig(address _feeConfig) external onlyOwner {
        feeConfig = IFeeConfigCrossChain(_feeConfig);
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
        if (xlpDeposits[msg.sender][token] < amount) revert InsufficientAmount();
        xlpDeposits[msg.sender][token] -= amount;
        totalTokenLiquidity[token] -= amount;
        emit XLPWithdraw(msg.sender, token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    function withdrawETH(uint256 amount) external nonReentrant {
        if (xlpETHDeposits[msg.sender] < amount) revert InsufficientAmount();
        xlpETHDeposits[msg.sender] -= amount;
        totalETHLiquidity -= amount;
        emit XLPWithdraw(msg.sender, address(0), amount);
        _transferETH(msg.sender, amount);
    }

    /**
     * @notice Swap tokens using XLP liquidity (constant-product AMM)
     * @param tokenIn Input token address (address(0) for ETH)
     * @param tokenOut Output token address (address(0) for ETH)
     * @param amountIn Amount of input token
     * @param minAmountOut Minimum output (slippage protection)
     * @return amountOut Actual output amount
     */
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientAmount();
        if (tokenIn == tokenOut) revert UnsupportedToken();

        uint256 reserveIn = _getReserve(tokenIn);
        uint256 reserveOut = _getReserve(tokenOut);
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientPoolLiquidity();

        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);
        if (amountOut < minAmountOut) revert InsufficientAmount();
        if (amountOut > reserveOut) revert InsufficientPoolLiquidity();

        uint256 refundAmount;
        if (tokenIn == address(0)) {
            if (msg.value < amountIn) revert InsufficientAmount();
            refundAmount = msg.value - amountIn;
        }

        uint256 fee = (amountIn * swapFeeBps) / BASIS_POINTS;

        // EFFECTS
        if (tokenIn == address(0)) {
            totalETHLiquidity += amountIn;
        } else {
            totalTokenLiquidity[tokenIn] += amountIn;
        }

        if (tokenOut == address(0)) {
            totalETHLiquidity -= amountOut;
        } else {
            totalTokenLiquidity[tokenOut] -= amountOut;
        }

        totalSwapVolume += amountIn;
        totalSwapFees += fee;

        uint256 protocolCut = (fee * 1000) / BASIS_POINTS;
        if (address(feeConfig) != address(0)) {
            (uint16 swapProtocolFeeBps,,) = feeConfig.getDeFiFees();
            protocolCut = (fee * swapProtocolFeeBps) / BASIS_POINTS;
        }
        protocolSwapFees += protocolCut;

        // INTERACTIONS
        if (tokenIn != address(0)) {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        if (tokenOut == address(0)) {
            _transferETH(msg.sender, amountOut);
        } else {
            IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
        }

        if (refundAmount > 0) _transferETH(msg.sender, refundAmount);

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, fee);
    }

    function getSwapQuote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 priceImpact)
    {
        uint256 reserveIn = _getReserve(tokenIn);
        uint256 reserveOut = _getReserve(tokenOut);
        if (reserveIn == 0 || reserveOut == 0) return (0, 0);
        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);
        priceImpact = (amountIn * BASIS_POINTS) / reserveIn;
    }

    function getReserves(address token0, address token1) external view returns (uint256 reserve0, uint256 reserve1) {
        reserve0 = _getReserve(token0);
        reserve1 = _getReserve(token1);
    }

    function setSwapFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 100, "Fee too high");
        uint256 oldFee = swapFeeBps;
        swapFeeBps = _feeBps;
        emit SwapFeeUpdated(oldFee, _feeBps);
    }

    function claimProtocolFees() external nonReentrant returns (uint256 claimed) {
        address treasury = address(feeConfig) != address(0) ? feeConfig.getTreasury() : owner();
        require(msg.sender == treasury || msg.sender == owner(), "Only treasury");
        claimed = protocolSwapFees;
        if (claimed == 0) revert InsufficientAmount();
        protocolSwapFees = 0;
        emit ProtocolFeesClaimed(treasury, claimed);
        _transferETH(treasury, claimed);
    }

    function getAMMStats()
        external
        view
        returns (uint256 ethReserve, uint256 swapVolume, uint256 swapFees, uint256 currentFeeBps)
    {
        ethReserve = totalETHLiquidity;
        swapVolume = totalSwapVolume;
        swapFees = totalSwapFees;
        currentFeeBps = swapFeeBps;
    }

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal view returns (uint256) {
        uint256 amountInWithFee = amountIn * (BASIS_POINTS - swapFeeBps);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * BASIS_POINTS) + amountInWithFee;
        return numerator / denominator;
    }

    function _getReserve(address token) internal view returns (uint256) {
        if (token == address(0)) return totalETHLiquidity;
        return totalTokenLiquidity[token];
    }

    function _transferETH(address to, uint256 amount) internal {
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    receive() external payable {}
}
