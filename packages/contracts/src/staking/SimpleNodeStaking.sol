// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SimpleNodeStaking
 * @notice Simplified node staking for testnet. No external dependencies.
 */
contract SimpleNodeStaking is Ownable {
    using SafeERC20 for IERC20;

    enum Region { NorthAmerica, SouthAmerica, Europe, Asia, Africa, Oceania }

    struct NodeStake {
        bytes32 nodeId;
        address operator;
        address stakedToken;
        uint256 stakedAmount;
        uint256 stakedValueUSD;
        address rewardToken;
        string rpcUrl;
        Region geographicRegion;
        uint256 registrationTime;
        uint256 lastClaimTime;
        uint256 totalRewardsClaimed;
        bool isActive;
        bool isSlashed;
    }

    struct PerformanceMetrics {
        uint256 uptimeScore;
        uint256 requestsServed;
        uint256 avgResponseTime;
        uint256 lastUpdateTime;
    }

    struct OperatorStats {
        uint256 totalNodesActive;
        uint256 totalStakedUSD;
        uint256 lifetimeRewardsUSD;
    }

    mapping(bytes32 => NodeStake) public nodes;
    mapping(bytes32 => PerformanceMetrics) public performance;
    mapping(address => bytes32[]) public operatorNodesList;
    mapping(address => OperatorStats) public operatorStats;
    bytes32[] public allNodeIds;

    uint256 public totalStakedUSD;
    uint256 public totalRewardsClaimedUSD;
    uint256 public maxNodesPerOperator = 5;
    uint256 public constant MIN_STAKING_PERIOD = 7 days;

    // Fixed price: 1 token = $1 USD for testnet
    uint256 public tokenPriceUSD = 1e18;

    event NodeRegistered(bytes32 indexed nodeId, address indexed operator, address indexed stakedToken, address rewardToken, uint256 stakedAmount, uint256 stakedValueUSD);
    event NodeDeregistered(bytes32 indexed nodeId, address indexed operator);
    event RewardsClaimed(bytes32 indexed nodeId, address indexed operator, address indexed rewardToken, uint256 rewardAmount, uint256 paymasterFeesETH);

    error ZeroStake();
    error InvalidAddress();
    error TooManyNodes();
    error NodeNotFound();
    error Unauthorized();
    error MinimumPeriodNotMet();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function registerNode(
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        Region region
    ) external returns (bytes32 nodeId) {
        if (stakeAmount == 0) revert ZeroStake();
        if (stakingToken == address(0) || rewardToken == address(0)) revert InvalidAddress();
        if (operatorStats[msg.sender].totalNodesActive >= maxNodesPerOperator) revert TooManyNodes();

        // Transfer stake tokens
        IERC20(stakingToken).safeTransferFrom(msg.sender, address(this), stakeAmount);

        uint256 stakeValueUSD = (stakeAmount * tokenPriceUSD) / 1e18;

        nodeId = keccak256(abi.encodePacked(msg.sender, block.timestamp, stakeAmount, rpcUrl));

        nodes[nodeId] = NodeStake({
            nodeId: nodeId,
            operator: msg.sender,
            stakedToken: stakingToken,
            stakedAmount: stakeAmount,
            stakedValueUSD: stakeValueUSD,
            rewardToken: rewardToken,
            rpcUrl: rpcUrl,
            geographicRegion: region,
            registrationTime: block.timestamp,
            lastClaimTime: block.timestamp,
            totalRewardsClaimed: 0,
            isActive: true,
            isSlashed: false
        });

        operatorNodesList[msg.sender].push(nodeId);
        allNodeIds.push(nodeId);

        operatorStats[msg.sender].totalNodesActive += 1;
        operatorStats[msg.sender].totalStakedUSD += stakeValueUSD;
        totalStakedUSD += stakeValueUSD;

        performance[nodeId] = PerformanceMetrics({
            uptimeScore: 10000, // 100.00%
            requestsServed: 0,
            avgResponseTime: 0,
            lastUpdateTime: block.timestamp
        });

        emit NodeRegistered(nodeId, msg.sender, stakingToken, rewardToken, stakeAmount, stakeValueUSD);
    }

    function deregisterNode(bytes32 nodeId) external {
        NodeStake storage node = nodes[nodeId];
        if (node.operator == address(0)) revert NodeNotFound();
        if (node.operator != msg.sender) revert Unauthorized();
        if (block.timestamp - node.registrationTime < MIN_STAKING_PERIOD) revert MinimumPeriodNotMet();

        node.isActive = false;

        // Return staked tokens
        IERC20(node.stakedToken).safeTransfer(msg.sender, node.stakedAmount);

        operatorStats[msg.sender].totalNodesActive -= 1;
        operatorStats[msg.sender].totalStakedUSD -= node.stakedValueUSD;
        totalStakedUSD -= node.stakedValueUSD;

        emit NodeDeregistered(nodeId, msg.sender);
    }

    function claimRewards(bytes32 nodeId) external {
        NodeStake storage node = nodes[nodeId];
        if (node.operator != msg.sender) revert Unauthorized();
        // Testnet: no actual rewards distributed
    }

    function calculatePendingRewards(bytes32 nodeId) external view returns (uint256) {
        NodeStake storage node = nodes[nodeId];
        if (!node.isActive) return 0;
        // Testnet: return 0 pending rewards
        return 0;
    }

    function getNodeInfo(bytes32 nodeId) external view returns (NodeStake memory, PerformanceMetrics memory, uint256) {
        return (nodes[nodeId], performance[nodeId], 0);
    }

    function getOperatorNodes(address operator) external view returns (bytes32[] memory) {
        return operatorNodesList[operator];
    }

    function getOperatorStats(address operator) external view returns (OperatorStats memory) {
        return operatorStats[operator];
    }

    function getNetworkStats() external view returns (uint256, uint256, uint256) {
        return (allNodeIds.length, totalStakedUSD, totalRewardsClaimedUSD);
    }

    function getAllNodes() external view returns (bytes32[] memory) {
        return allNodeIds;
    }

    function updatePerformance(bytes32 nodeId, uint256 uptimeScore, uint256 requestsServed, uint256 avgResponseTime) external onlyOwner {
        performance[nodeId] = PerformanceMetrics({
            uptimeScore: uptimeScore,
            requestsServed: requestsServed,
            avgResponseTime: avgResponseTime,
            lastUpdateTime: block.timestamp
        });
    }

    function setTokenPrice(uint256 newPrice) external onlyOwner {
        tokenPriceUSD = newPrice;
    }
}
