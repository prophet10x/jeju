// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INodeMigrationHandler} from "./interfaces/INodeMigrationHandler.sol";
import {INodeStateRegistry} from "./interfaces/INodeStateRegistry.sol";
import {NodeStakeVault} from "./NodeStakeVault.sol";
import {NodeStateTypes} from "./libraries/NodeStateTypes.sol";

contract NodeStateRegistry is AccessControl, Pausable, ReentrancyGuard, INodeStateRegistry {
    bytes32 public constant MODULE_ADMIN_ROLE = keccak256("MODULE_ADMIN_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    NodeStakeVault public stakeVault;

    mapping(bytes32 => NodeStateTypes.NodeState) private _nodeStates;
    mapping(bytes32 => NodeStateTypes.MigrationCursor) private _migrationCursors;
    mapping(address => bytes32[]) private _operatorNodes;
    bytes32[] private _allNodeIds;

    mapping(uint16 => address) private _modules;
    mapping(uint16 => bool) public moduleEnabled;
    mapping(address => bool) public authorizedModule;
    mapping(uint16 => address) public migrationHandlerByVersion;
    mapping(address => bool) public authorizedMigrationHandler;

    mapping(address => NodeStateTypes.OperatorStats) private _operatorStats;
    mapping(address => NodeStateTypes.TokenDistribution) private _tokenDistribution;
    uint256 private _totalNodesActive;
    uint256 private _totalStakedUSD;
    uint256 private _totalRewardsClaimedUSD;

    event StakeVaultUpdated(address indexed previousVault, address indexed newVault);
    event ModuleRegistered(
        uint16 indexed version, address indexed module, address indexed migrationHandler, bool enabled
    );
    event ModuleEnabled(uint16 indexed version, bool enabled);
    event MigrationHandlerUpdated(uint16 indexed version, address indexed migrationHandler);
    event NodeCreated(bytes32 indexed nodeId, address indexed operator, uint16 indexed version);
    event NodeStakeIncreased(bytes32 indexed nodeId, address indexed operator, uint256 amount, uint256 addedValueUSD);
    event NodeConfigUpdated(bytes32 indexed nodeId, address indexed operator, string rpcUrl, uint8 region);
    event NodeServicesUpdated(bytes32 indexed nodeId, address indexed operator, bytes32 servicesHash);
    event NodeMetadataURIUpdated(bytes32 indexed nodeId, address indexed operator, string metadataURI);
    event NodeRewardsClaimed(bytes32 indexed nodeId, address indexed operator, uint256 rewardsUSD);
    event NodeDeactivated(bytes32 indexed nodeId, address indexed operator, uint256 unstakedAmount);
    event NodeUpgradeStarted(
        bytes32 indexed nodeId, uint16 indexed fromVersion, uint16 indexed targetVersion, bytes32 contextHash
    );
    event NodeMigrationStep(bytes32 indexed nodeId, uint16 indexed targetVersion, uint256 stepIndex);
    event NodeUpgradeCompleted(bytes32 indexed nodeId, uint16 indexed fromVersion, uint16 indexed targetVersion);
    event NodeMigrationPatched(bytes32 indexed nodeId, uint16 indexed targetVersion, bytes32 contextHash);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidVersion();
    error ModuleNotEnabled(uint16 version);
    error NotAuthorizedModule();
    error NotAuthorizedMigrationHandler();
    error NodeNotFound(bytes32 nodeId);
    error NodeNotActive(bytes32 nodeId);
    error UnauthorizedOperator(bytes32 nodeId, address caller);
    error NodeUpgradeInProgress(bytes32 nodeId);
    error UpgradeNotInProgress(bytes32 nodeId);
    error InvalidUpgradeTarget(uint16 fromVersion, uint16 targetVersion);
    error MigrationHandlerMissing(uint16 version);
    error MigrationContextMismatch(bytes32 expected, bytes32 actual);

    modifier onlyAuthorizedModule() {
        if (!authorizedModule[msg.sender]) revert NotAuthorizedModule();
        _;
    }

    modifier onlyAuthorizedMigrationHandler(bytes32 nodeId) {
        if (!authorizedMigrationHandler[msg.sender]) revert NotAuthorizedMigrationHandler();
        NodeStateTypes.MigrationCursor memory cursor = _migrationCursors[nodeId];
        if (!cursor.active) revert UpgradeNotInProgress(nodeId);
        if (migrationHandlerByVersion[cursor.targetVersion] != msg.sender) revert NotAuthorizedMigrationHandler();
        _;
    }

    constructor(address admin, address initialStakeVault) {
        if (admin == address(0) || initialStakeVault == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MODULE_ADMIN_ROLE, admin);
        _grantRole(EMERGENCY_ROLE, admin);
        stakeVault = NodeStakeVault(initialStakeVault);
    }

    function setStakeVault(address newStakeVault) external onlyRole(MODULE_ADMIN_ROLE) {
        if (newStakeVault == address(0)) revert InvalidAddress();
        address previousVault = address(stakeVault);
        stakeVault = NodeStakeVault(newStakeVault);
        emit StakeVaultUpdated(previousVault, newStakeVault);
    }

    function registerModule(uint16 version, address module, address migrationHandler, bool enabled)
        external
        onlyRole(MODULE_ADMIN_ROLE)
    {
        if (version == 0 || module == address(0)) revert InvalidVersion();

        _modules[version] = module;
        moduleEnabled[version] = enabled;
        authorizedModule[module] = true;

        if (migrationHandler != address(0)) {
            migrationHandlerByVersion[version] = migrationHandler;
            authorizedMigrationHandler[migrationHandler] = true;
        }

        emit ModuleRegistered(version, module, migrationHandler, enabled);
    }

    function setModuleEnabled(uint16 version, bool enabled) external onlyRole(MODULE_ADMIN_ROLE) {
        if (_modules[version] == address(0)) revert InvalidVersion();
        moduleEnabled[version] = enabled;
        emit ModuleEnabled(version, enabled);
    }

    function setMigrationHandler(uint16 version, address migrationHandler) external onlyRole(MODULE_ADMIN_ROLE) {
        if (_modules[version] == address(0)) revert InvalidVersion();
        if (migrationHandler == address(0)) revert InvalidAddress();
        migrationHandlerByVersion[version] = migrationHandler;
        authorizedMigrationHandler[migrationHandler] = true;
        emit MigrationHandlerUpdated(version, migrationHandler);
    }

    function createNode(NodeStateTypes.NodeStateInput calldata input)
        external
        onlyAuthorizedModule
        whenNotPaused
        nonReentrant
        returns (bytes32 nodeId)
    {
        if (input.operator == address(0) || input.stakedToken == address(0) || input.rewardToken == address(0)) {
            revert InvalidAddress();
        }
        if (input.stakedAmount == 0) revert InvalidAmount();
        if (input.stateVersion == 0) revert InvalidVersion();

        nodeId = keccak256(abi.encodePacked(input.operator, input.rpcUrl, block.timestamp, _allNodeIds.length));
        if (_nodeStates[nodeId].operator != address(0)) {
            nodeId = keccak256(abi.encodePacked(input.operator, input.rpcUrl, block.timestamp, block.prevrandao));
        }

        stakeVault.depositFrom(input.stakedToken, input.operator, input.stakedAmount);

        _nodeStates[nodeId] = NodeStateTypes.NodeState({
            nodeId: nodeId,
            operator: input.operator,
            stakedToken: input.stakedToken,
            stakedAmount: input.stakedAmount,
            stakedValueUSD: input.stakedValueUSD,
            rewardToken: input.rewardToken,
            rpcUrl: input.rpcUrl,
            region: input.region,
            registrationTime: block.timestamp,
            lastClaimTime: block.timestamp,
            totalRewardsClaimedUSD: 0,
            operatorAgentId: input.operatorAgentId,
            isActive: true,
            isSlashed: false,
            upgradeLocked: false,
            stateVersion: input.stateVersion,
            servicesHash: input.servicesHash,
            metadataURI: input.metadataURI
        });

        _operatorNodes[input.operator].push(nodeId);
        _allNodeIds.push(nodeId);

        _operatorStats[input.operator].totalNodesActive += 1;
        _operatorStats[input.operator].totalStakedUSD += input.stakedValueUSD;

        _tokenDistribution[input.stakedToken].totalStaked += input.stakedAmount;
        _tokenDistribution[input.stakedToken].totalStakedUSD += input.stakedValueUSD;
        _tokenDistribution[input.stakedToken].nodeCount += 1;

        _totalNodesActive += 1;
        _totalStakedUSD += input.stakedValueUSD;

        emit NodeCreated(nodeId, input.operator, input.stateVersion);
    }

    function increaseStakeFromModule(bytes32 nodeId, address operator, uint256 amount, uint256 addedValueUSD)
        external
        onlyAuthorizedModule
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert InvalidAmount();
        NodeStateTypes.NodeState storage node = _getNodeOrRevert(nodeId);
        _assertMutableNode(node, nodeId, operator);

        stakeVault.depositFrom(node.stakedToken, operator, amount);

        node.stakedAmount += amount;
        node.stakedValueUSD += addedValueUSD;

        _operatorStats[operator].totalStakedUSD += addedValueUSD;
        _tokenDistribution[node.stakedToken].totalStaked += amount;
        _tokenDistribution[node.stakedToken].totalStakedUSD += addedValueUSD;
        _totalStakedUSD += addedValueUSD;

        emit NodeStakeIncreased(nodeId, operator, amount, addedValueUSD);
    }

    function updateNodeConfigFromModule(bytes32 nodeId, address operator, string calldata rpcUrl, uint8 region)
        external
        onlyAuthorizedModule
        whenNotPaused
    {
        NodeStateTypes.NodeState storage node = _getNodeOrRevert(nodeId);
        _assertMutableNode(node, nodeId, operator);

        node.rpcUrl = rpcUrl;
        node.region = region;
        emit NodeConfigUpdated(nodeId, operator, rpcUrl, region);
    }

    function updateNodeServicesFromModule(bytes32 nodeId, address operator, bytes32 servicesHash)
        external
        onlyAuthorizedModule
        whenNotPaused
    {
        NodeStateTypes.NodeState storage node = _getNodeOrRevert(nodeId);
        _assertMutableNode(node, nodeId, operator);

        node.servicesHash = servicesHash;
        emit NodeServicesUpdated(nodeId, operator, servicesHash);
    }

    function setNodeMetadataURIFromModule(bytes32 nodeId, address operator, string calldata metadataURI)
        external
        onlyAuthorizedModule
        whenNotPaused
    {
        NodeStateTypes.NodeState storage node = _getNodeOrRevert(nodeId);
        _assertMutableNode(node, nodeId, operator);

        node.metadataURI = metadataURI;
        emit NodeMetadataURIUpdated(nodeId, operator, metadataURI);
    }

    function recordRewardClaimFromModule(bytes32 nodeId, address operator, uint256 rewardsUSD)
        external
        onlyAuthorizedModule
        whenNotPaused
    {
        NodeStateTypes.NodeState storage node = _getNodeOrRevert(nodeId);
        _assertMutableNode(node, nodeId, operator);

        node.lastClaimTime = block.timestamp;
        node.totalRewardsClaimedUSD += rewardsUSD;
        _operatorStats[operator].lifetimeRewardsUSD += rewardsUSD;
        _totalRewardsClaimedUSD += rewardsUSD;
        emit NodeRewardsClaimed(nodeId, operator, rewardsUSD);
    }

    function deactivateNodeFromModule(bytes32 nodeId, address operator, address payoutRecipient)
        external
        onlyAuthorizedModule
        whenNotPaused
        nonReentrant
        returns (uint256 unstakedAmount)
    {
        if (payoutRecipient == address(0)) revert InvalidAddress();
        NodeStateTypes.NodeState storage node = _getNodeOrRevert(nodeId);
        _assertMutableNode(node, nodeId, operator);

        node.isActive = false;

        unstakedAmount = node.stakedAmount;
        uint256 unstakedValueUSD = node.stakedValueUSD;
        address stakedToken = node.stakedToken;

        if (unstakedAmount > 0) {
            stakeVault.releaseTo(stakedToken, payoutRecipient, unstakedAmount);
        }

        node.stakedAmount = 0;
        node.stakedValueUSD = 0;

        _operatorStats[operator].totalNodesActive -= 1;
        _operatorStats[operator].totalStakedUSD -= unstakedValueUSD;

        _tokenDistribution[stakedToken].totalStaked -= unstakedAmount;
        _tokenDistribution[stakedToken].totalStakedUSD -= unstakedValueUSD;
        _tokenDistribution[stakedToken].nodeCount -= 1;

        _totalNodesActive -= 1;
        _totalStakedUSD -= unstakedValueUSD;

        emit NodeDeactivated(nodeId, operator, unstakedAmount);
    }

    function applyMigrationPatch(bytes32 nodeId, NodeStateTypes.MigrationPatch calldata patch)
        external
        onlyAuthorizedMigrationHandler(nodeId)
    {
        NodeStateTypes.NodeState storage node = _getNodeOrRevert(nodeId);
        if (!node.upgradeLocked) revert UpgradeNotInProgress(nodeId);

        if (patch.updateRpcUrl) {
            node.rpcUrl = patch.rpcUrl;
        }
        if (patch.updateRegion) {
            node.region = patch.region;
        }
        if (patch.updateServicesHash) {
            node.servicesHash = patch.servicesHash;
        }
        if (patch.updateMetadataURI) {
            node.metadataURI = patch.metadataURI;
        }
        if (patch.updateStakedValueUSD) {
            _reconcileStakedValue(node, patch.stakedValueUSD);
        }

        emit NodeMigrationPatched(nodeId, _migrationCursors[nodeId].targetVersion, _migrationContext(node));
    }

    function upgradeNodeVersion(bytes32 nodeId, uint16 targetVersion, uint256 maxSteps)
        external
        whenNotPaused
        nonReentrant
    {
        NodeStateTypes.NodeState storage node = _getNodeOrRevert(nodeId);
        if (node.operator != msg.sender && !hasRole(MODULE_ADMIN_ROLE, msg.sender)) {
            revert UnauthorizedOperator(nodeId, msg.sender);
        }
        if (!moduleEnabled[targetVersion]) revert ModuleNotEnabled(targetVersion);

        NodeStateTypes.MigrationCursor storage cursor = _migrationCursors[nodeId];
        if (!cursor.active) {
            if (targetVersion <= node.stateVersion) revert InvalidUpgradeTarget(node.stateVersion, targetVersion);

            address handlerAddress = migrationHandlerByVersion[targetVersion];
            if (handlerAddress == address(0)) revert MigrationHandlerMissing(targetVersion);

            bytes32 contextHash = _migrationContext(node);
            cursor.fromVersion = node.stateVersion;
            cursor.targetVersion = targetVersion;
            cursor.nextStep = 0;
            cursor.active = true;
            cursor.contextHash = contextHash;
            node.upgradeLocked = true;

            emit NodeUpgradeStarted(nodeId, node.stateVersion, targetVersion, contextHash);
        }

        if (cursor.targetVersion != targetVersion) {
            revert InvalidUpgradeTarget(cursor.targetVersion, targetVersion);
        }

        bytes32 currentContext = _migrationContext(node);
        if (currentContext != cursor.contextHash) {
            revert MigrationContextMismatch(cursor.contextHash, currentContext);
        }

        address migrationHandler = migrationHandlerByVersion[targetVersion];
        if (migrationHandler == address(0)) revert MigrationHandlerMissing(targetVersion);
        uint256 stepCount =
            INodeMigrationHandler(migrationHandler).getStepCount(nodeId, cursor.fromVersion, cursor.targetVersion);

        uint256 stepsRemaining = stepCount > cursor.nextStep ? stepCount - cursor.nextStep : 0;
        uint256 stepsToRun = maxSteps == 0 ? stepsRemaining : Math.min(maxSteps, stepsRemaining);
        for (uint256 i = 0; i < stepsToRun; i++) {
            uint256 stepIndex = cursor.nextStep;
            INodeMigrationHandler(migrationHandler).runStep(nodeId, cursor.fromVersion, cursor.targetVersion, stepIndex);
            cursor.nextStep = stepIndex + 1;
            cursor.contextHash = _migrationContext(node);
            emit NodeMigrationStep(nodeId, cursor.targetVersion, stepIndex);
        }

        if (cursor.nextStep >= stepCount) {
            uint16 fromVersion = cursor.fromVersion;
            uint16 completedTarget = cursor.targetVersion;
            node.stateVersion = completedTarget;
            node.upgradeLocked = false;
            delete _migrationCursors[nodeId];
            emit NodeUpgradeCompleted(nodeId, fromVersion, completedTarget);
        }
    }

    function getNodeState(bytes32 nodeId) external view returns (NodeStateTypes.NodeState memory) {
        return _nodeStates[nodeId];
    }

    function getNodeVersion(bytes32 nodeId) external view returns (uint16) {
        return _nodeStates[nodeId].stateVersion;
    }

    function getMigrationCursor(bytes32 nodeId) external view returns (NodeStateTypes.MigrationCursor memory) {
        return _migrationCursors[nodeId];
    }

    function getOperatorNodes(address operator) external view returns (bytes32[] memory) {
        return _operatorNodes[operator];
    }

    function getAllNodes() external view returns (bytes32[] memory) {
        return _allNodeIds;
    }

    function getModule(uint16 version) external view returns (address) {
        return _modules[version];
    }

    function getOperatorStats(address operator) external view returns (NodeStateTypes.OperatorStats memory) {
        return _operatorStats[operator];
    }

    function getNetworkStats()
        external
        view
        returns (uint256 totalNodesActive, uint256 totalStakedUSD, uint256 totalRewardsClaimedUSD)
    {
        return (_totalNodesActive, _totalStakedUSD, _totalRewardsClaimedUSD);
    }

    function getTokenDistribution(address token) external view returns (NodeStateTypes.TokenDistribution memory) {
        return _tokenDistribution[token];
    }

    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(MODULE_ADMIN_ROLE) {
        _unpause();
    }

    function _getNodeOrRevert(bytes32 nodeId) internal view returns (NodeStateTypes.NodeState storage node) {
        node = _nodeStates[nodeId];
        if (node.operator == address(0)) revert NodeNotFound(nodeId);
    }

    function _assertMutableNode(NodeStateTypes.NodeState storage node, bytes32 nodeId, address operator) internal view {
        if (node.operator != operator) revert UnauthorizedOperator(nodeId, operator);
        if (!node.isActive) revert NodeNotActive(nodeId);
        if (node.upgradeLocked) revert NodeUpgradeInProgress(nodeId);
    }

    function _migrationContext(NodeStateTypes.NodeState storage node) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                node.stateVersion,
                node.stakedToken,
                node.stakedAmount,
                node.stakedValueUSD,
                node.rewardToken,
                keccak256(bytes(node.rpcUrl)),
                node.region,
                node.operatorAgentId,
                node.isActive,
                node.isSlashed,
                node.servicesHash,
                keccak256(bytes(node.metadataURI))
            )
        );
    }

    function _reconcileStakedValue(NodeStateTypes.NodeState storage node, uint256 updatedStakedValueUSD) internal {
        uint256 previous = node.stakedValueUSD;
        if (previous == updatedStakedValueUSD) return;

        if (updatedStakedValueUSD > previous) {
            uint256 increase = updatedStakedValueUSD - previous;
            _operatorStats[node.operator].totalStakedUSD += increase;
            _tokenDistribution[node.stakedToken].totalStakedUSD += increase;
            _totalStakedUSD += increase;
        } else {
            uint256 decrease = previous - updatedStakedValueUSD;
            _operatorStats[node.operator].totalStakedUSD -= decrease;
            _tokenDistribution[node.stakedToken].totalStakedUSD -= decrease;
            _totalStakedUSD -= decrease;
        }

        node.stakedValueUSD = updatedStakedValueUSD;
    }
}
