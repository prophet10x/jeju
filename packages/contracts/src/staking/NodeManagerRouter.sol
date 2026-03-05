// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {INodeManagerModule} from "./interfaces/INodeManagerModule.sol";
import {INodeStateRegistry} from "./interfaces/INodeStateRegistry.sol";
import {NodeStateTypes} from "./libraries/NodeStateTypes.sol";

contract NodeManagerRouter is AccessControl, Pausable {
    bytes32 public constant MODULE_ADMIN_ROLE = keccak256("MODULE_ADMIN_ROLE");
    bytes32 public constant PERFORMANCE_ORACLE_ROLE = keccak256("PERFORMANCE_ORACLE_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    INodeStateRegistry public immutable registry;
    uint16 public defaultRegistrationVersion;
    uint256 public minStakeUSD = 1_000 ether;
    uint256 public baseRewardPerMonthUSD = 100 ether;

    struct NodeStakeView {
        bytes32 nodeId;
        address operator;
        address stakedToken;
        uint256 stakedAmount;
        uint256 stakedValueUSD;
        address rewardToken;
        string rpcUrl;
        uint8 geographicRegion;
        uint256 registrationTime;
        uint256 lastClaimTime;
        uint256 totalRewardsClaimed;
        uint256 operatorAgentId;
        bool isActive;
        bool isSlashed;
    }

    struct PerformanceMetricsView {
        uint256 uptimeScore;
        uint256 requestsServed;
        uint256 avgResponseTime;
        uint256 lastUpdateTime;
    }

    struct OperatorStatsView {
        uint256 totalNodesActive;
        uint256 totalStakedUSD;
        uint256 lifetimeRewardsUSD;
    }

    struct TokenDistributionView {
        uint256 totalStaked;
        uint256 totalStakedUSD;
        uint256 nodeCount;
        uint256 rewardBudget;
    }

    mapping(bytes32 => PerformanceMetricsView) private _performanceMetrics;

    event DefaultRegistrationVersionUpdated(uint16 previousVersion, uint16 newVersion);
    event PerformanceOracleUpdated(address indexed oracle, bool enabled);
    event RewardConfigUpdated(uint256 minStakeUSD, uint256 baseRewardPerMonthUSD);
    event NodeRegistered(
        bytes32 indexed nodeId,
        address indexed operator,
        address indexed stakedToken,
        address rewardToken,
        uint256 stakedAmount,
        uint256 stakedValueUSD
    );
    event RewardsClaimed(
        bytes32 indexed nodeId,
        address indexed operator,
        address indexed rewardToken,
        uint256 rewardAmount,
        uint256 paymasterFeesETH
    );
    event NodeDeregistered(bytes32 indexed nodeId, address indexed operator);

    error InvalidAddress();
    error InvalidVersion();
    error ModuleNotConfigured(uint16 version);
    error NodeNotFound(bytes32 nodeId);
    error Unauthorized();
    error UnsupportedOperation();

    constructor(address registryAddress, uint16 initialDefaultVersion, address admin) {
        if (registryAddress == address(0) || admin == address(0)) revert InvalidAddress();
        if (initialDefaultVersion == 0) revert InvalidVersion();

        registry = INodeStateRegistry(registryAddress);
        defaultRegistrationVersion = initialDefaultVersion;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MODULE_ADMIN_ROLE, admin);
        _grantRole(PERFORMANCE_ORACLE_ROLE, admin);
        _grantRole(EMERGENCY_ROLE, admin);
    }

    function setDefaultRegistrationVersion(uint16 version) external onlyRole(MODULE_ADMIN_ROLE) {
        if (version == 0) revert InvalidVersion();
        _ensureModuleConfigured(version);
        uint16 previousVersion = defaultRegistrationVersion;
        defaultRegistrationVersion = version;
        emit DefaultRegistrationVersionUpdated(previousVersion, version);
    }

    function setPerformanceOracle(address oracle, bool enabled) external onlyRole(MODULE_ADMIN_ROLE) {
        if (oracle == address(0)) revert InvalidAddress();
        if (enabled) {
            _grantRole(PERFORMANCE_ORACLE_ROLE, oracle);
        } else {
            _revokeRole(PERFORMANCE_ORACLE_ROLE, oracle);
        }
        emit PerformanceOracleUpdated(oracle, enabled);
    }

    function setRewardConfig(uint256 newMinStakeUSD, uint256 newBaseRewardPerMonthUSD)
        external
        onlyRole(MODULE_ADMIN_ROLE)
    {
        minStakeUSD = newMinStakeUSD;
        baseRewardPerMonthUSD = newBaseRewardPerMonthUSD;
        emit RewardConfigUpdated(newMinStakeUSD, newBaseRewardPerMonthUSD);
    }

    function supportsAtomicNodeIdentityRegistration() external pure returns (bool) {
        return false;
    }

    function registerNode(
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        uint8 region
    ) external whenNotPaused returns (bytes32 nodeId) {
        INodeManagerModule module = _moduleForVersion(defaultRegistrationVersion);
        nodeId = module.registerNode(msg.sender, stakingToken, stakeAmount, rewardToken, rpcUrl, region);
        NodeStateTypes.NodeState memory state = registry.getNodeState(nodeId);
        emit NodeRegistered(
            nodeId, msg.sender, state.stakedToken, state.rewardToken, state.stakedAmount, state.stakedValueUSD
        );
    }

    function registerNodeWithAgent(
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        uint8 region,
        uint256 operatorAgentId
    ) external whenNotPaused returns (bytes32 nodeId) {
        INodeManagerModule module = _moduleForVersion(defaultRegistrationVersion);
        nodeId = module.registerNodeWithAgent(
            msg.sender, stakingToken, stakeAmount, rewardToken, rpcUrl, region, operatorAgentId
        );
        NodeStateTypes.NodeState memory state = registry.getNodeState(nodeId);
        emit NodeRegistered(
            nodeId, msg.sender, state.stakedToken, state.rewardToken, state.stakedAmount, state.stakedValueUSD
        );
    }

    function getNodeIdentityAgentId(bytes32) external pure returns (uint256) {
        return 0;
    }

    function claimRewards(bytes32 nodeId) external whenNotPaused {
        INodeManagerModule module = _moduleForNode(nodeId);
        uint256 rewardsUSD = module.claimRewards(msg.sender, nodeId);
        NodeStateTypes.NodeState memory node = registry.getNodeState(nodeId);
        emit RewardsClaimed(nodeId, msg.sender, node.rewardToken, rewardsUSD, 0);
    }

    function deregisterNode(bytes32 nodeId) external whenNotPaused {
        INodeManagerModule module = _moduleForNode(nodeId);
        module.deregisterNode(msg.sender, nodeId);
        emit NodeDeregistered(nodeId, msg.sender);
    }

    function deactivateNode(bytes32 nodeId) external whenNotPaused {
        INodeManagerModule module = _moduleForNode(nodeId);
        module.deregisterNode(msg.sender, nodeId);
        emit NodeDeregistered(nodeId, msg.sender);
    }

    function increaseStake(bytes32 nodeId, uint256 amount) external whenNotPaused {
        INodeManagerModule module = _moduleForNode(nodeId);
        module.increaseStake(msg.sender, nodeId, amount);
    }

    function updateNodeConfig(bytes32 nodeId, string calldata rpcUrl, uint8 region) external whenNotPaused {
        INodeManagerModule module = _moduleForNode(nodeId);
        module.updateNodeConfig(msg.sender, nodeId, rpcUrl, region);
    }

    function updateNodeServices(bytes32 nodeId, bytes32 servicesHash) external whenNotPaused {
        INodeManagerModule module = _moduleForNode(nodeId);
        module.updateNodeServices(msg.sender, nodeId, servicesHash);
    }

    function setNodeMetadataURI(bytes32 nodeId, string calldata metadataURI) external whenNotPaused {
        INodeManagerModule module = _moduleForNode(nodeId);
        module.setNodeMetadataURI(msg.sender, nodeId, metadataURI);
    }

    function updatePerformance(bytes32 nodeId, uint256 uptimeScore, uint256 requestsServed, uint256 avgResponseTime)
        external
        onlyRole(PERFORMANCE_ORACLE_ROLE)
        whenNotPaused
    {
        NodeStateTypes.NodeState memory node = registry.getNodeState(nodeId);
        if (node.operator == address(0)) revert NodeNotFound(nodeId);
        _performanceMetrics[nodeId] = PerformanceMetricsView({
            uptimeScore: uptimeScore,
            requestsServed: requestsServed,
            avgResponseTime: avgResponseTime,
            lastUpdateTime: block.timestamp
        });
    }

    function pendingSlashes(bytes32)
        external
        pure
        returns (
            bytes32 nodeId,
            uint256 slashPercentageBPS,
            string memory reason,
            uint256 proposedAt,
            uint256 executeAfter,
            bool executed,
            bool disputed
        )
    {
        return (bytes32(0), 0, "", 0, 0, false, false);
    }

    function executeSlash(bytes32) external pure {
        revert UnsupportedOperation();
    }

    function getNodeInfo(bytes32 nodeId)
        external
        view
        returns (NodeStakeView memory node, PerformanceMetricsView memory perf, uint256 pendingRewardsUSD)
    {
        NodeStateTypes.NodeState memory state = registry.getNodeState(nodeId);
        if (state.operator == address(0)) revert NodeNotFound(nodeId);

        node = NodeStakeView({
            nodeId: state.nodeId,
            operator: state.operator,
            stakedToken: state.stakedToken,
            stakedAmount: state.stakedAmount,
            stakedValueUSD: state.stakedValueUSD,
            rewardToken: state.rewardToken,
            rpcUrl: state.rpcUrl,
            geographicRegion: state.region,
            registrationTime: state.registrationTime,
            lastClaimTime: state.lastClaimTime,
            totalRewardsClaimed: state.totalRewardsClaimedUSD,
            operatorAgentId: state.operatorAgentId,
            isActive: state.isActive,
            isSlashed: state.isSlashed
        });

        perf = _performanceMetrics[nodeId];
        pendingRewardsUSD = 0;
    }

    function getOperatorNodes(address operator) external view returns (bytes32[] memory nodeIds) {
        return registry.getOperatorNodes(operator);
    }

    function calculatePendingRewards(bytes32) external pure returns (uint256 rewardsUSD) {
        return 0;
    }

    function getNetworkStats()
        external
        view
        returns (uint256 totalNodesActive, uint256 totalStakedUSD, uint256 totalRewardsClaimedUSD)
    {
        return registry.getNetworkStats();
    }

    function getOperatorStats(address operator) external view returns (OperatorStatsView memory stats) {
        NodeStateTypes.OperatorStats memory source = registry.getOperatorStats(operator);
        stats = OperatorStatsView({
            totalNodesActive: source.totalNodesActive,
            totalStakedUSD: source.totalStakedUSD,
            lifetimeRewardsUSD: source.lifetimeRewardsUSD
        });
    }

    function getTokenDistribution(address token) external view returns (TokenDistributionView memory distribution) {
        NodeStateTypes.TokenDistribution memory source = registry.getTokenDistribution(token);
        distribution = TokenDistributionView({
            totalStaked: source.totalStaked,
            totalStakedUSD: source.totalStakedUSD,
            nodeCount: source.nodeCount,
            rewardBudget: 0
        });
    }

    function getAllNodes() external view returns (bytes32[] memory nodeIds) {
        return registry.getAllNodes();
    }

    function getNodeServicesHash(bytes32 nodeId) external view returns (bytes32 servicesHash) {
        return registry.getNodeState(nodeId).servicesHash;
    }

    function getNodeMetadataURI(bytes32 nodeId) external view returns (string memory metadataURI) {
        return registry.getNodeState(nodeId).metadataURI;
    }

    function nodes(bytes32 nodeId)
        external
        view
        returns (
            bytes32 outNodeId,
            address operator,
            address stakedToken,
            uint256 stakedAmount,
            uint256 stakedValueUSD,
            address rewardToken,
            string memory rpcUrl,
            uint8 geographicRegion,
            uint256 registrationTime,
            uint256 lastClaimTime,
            uint256 totalRewardsClaimed,
            uint256 operatorAgentId,
            bool isActive,
            bool isSlashed
        )
    {
        NodeStateTypes.NodeState memory state = registry.getNodeState(nodeId);
        return (
            state.nodeId,
            state.operator,
            state.stakedToken,
            state.stakedAmount,
            state.stakedValueUSD,
            state.rewardToken,
            state.rpcUrl,
            state.region,
            state.registrationTime,
            state.lastClaimTime,
            state.totalRewardsClaimedUSD,
            state.operatorAgentId,
            state.isActive,
            state.isSlashed
        );
    }

    function performance(bytes32 nodeId)
        external
        view
        returns (uint256 uptimeScore, uint256 requestsServed, uint256 avgResponseTime, uint256 lastUpdateTime)
    {
        PerformanceMetricsView memory perf = _performanceMetrics[nodeId];
        return (perf.uptimeScore, perf.requestsServed, perf.avgResponseTime, perf.lastUpdateTime);
    }

    function getNodeVersion(bytes32 nodeId) external view returns (uint16 version) {
        return registry.getNodeVersion(nodeId);
    }

    function getMigrationCursor(bytes32 nodeId) external view returns (NodeStateTypes.MigrationCursor memory cursor) {
        return registry.getMigrationCursor(nodeId);
    }

    function upgradeNodeVersion(bytes32 nodeId, uint16 targetVersion, uint256 maxSteps) external whenNotPaused {
        NodeStateTypes.NodeState memory node = registry.getNodeState(nodeId);
        if (node.operator != msg.sender && !hasRole(MODULE_ADMIN_ROLE, msg.sender)) {
            revert Unauthorized();
        }
        registry.upgradeNodeVersion(nodeId, targetVersion, maxSteps);
    }

    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(MODULE_ADMIN_ROLE) {
        _unpause();
    }

    function _moduleForNode(bytes32 nodeId) internal view returns (INodeManagerModule module) {
        uint16 version = registry.getNodeVersion(nodeId);
        if (version == 0) revert NodeNotFound(nodeId);
        module = _moduleForVersion(version);
    }

    function _moduleForVersion(uint16 version) internal view returns (INodeManagerModule module) {
        _ensureModuleConfigured(version);
        module = INodeManagerModule(registry.getModule(version));
    }

    function _ensureModuleConfigured(uint16 version) internal view {
        address moduleAddress = registry.getModule(version);
        if (moduleAddress == address(0)) revert ModuleNotConfigured(version);
    }
}
