// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {INodeManagerModule} from "../interfaces/INodeManagerModule.sol";
import {INodeStateRegistry} from "../interfaces/INodeStateRegistry.sol";
import {NodeStateTypes} from "../libraries/NodeStateTypes.sol";
import {ITokenRegistry} from "../../interfaces/IPaymaster.sol";
import {IPriceOracle} from "../../interfaces/IPriceOracle.sol";

contract NodeManagerV3 is AccessControl, INodeManagerModule {
    bytes32 public constant ROUTER_ROLE = keccak256("ROUTER_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    uint256 public minStakeUSD = 1_000 ether;

    INodeStateRegistry public immutable registry;
    ITokenRegistry public immutable tokenRegistry;
    IPriceOracle public immutable priceOracle;

    error InvalidAddress();
    error InvalidStakeAmount();
    error InvalidRpcUrl();
    error InvalidRegion();
    error TokenNotSupported(address token);
    error InsufficientStakeValue(uint256 provided, uint256 required);
    error NotNodeOperator(bytes32 nodeId, address operator);

    constructor(
        address router,
        address admin,
        address registryAddress,
        address tokenRegistryAddress,
        address priceOracleAddress
    ) {
        if (
            router == address(0) || admin == address(0) || registryAddress == address(0)
                || tokenRegistryAddress == address(0) || priceOracleAddress == address(0)
        ) revert InvalidAddress();

        registry = INodeStateRegistry(registryAddress);
        tokenRegistry = ITokenRegistry(tokenRegistryAddress);
        priceOracle = IPriceOracle(priceOracleAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(ROUTER_ROLE, router);
    }

    function version() external pure returns (uint16) {
        return 3;
    }

    function setRouter(address router, bool enabled) external onlyRole(CONFIG_ROLE) {
        if (router == address(0)) revert InvalidAddress();
        if (enabled) {
            _grantRole(ROUTER_ROLE, router);
        } else {
            _revokeRole(ROUTER_ROLE, router);
        }
    }

    function setMinStakeUSD(uint256 newMinStakeUSD) external onlyRole(CONFIG_ROLE) {
        minStakeUSD = newMinStakeUSD;
    }

    function registerNode(
        address operator,
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        uint8 region
    ) external onlyRole(ROUTER_ROLE) returns (bytes32 nodeId) {
        _validateRegistration(stakingToken, stakeAmount, rewardToken, rpcUrl, region);
        uint256 stakedValueUSD = _calculateStakeValueUSD(stakingToken, stakeAmount);
        if (stakedValueUSD < minStakeUSD) revert InsufficientStakeValue(stakedValueUSD, minStakeUSD);

        NodeStateTypes.NodeStateInput memory input = NodeStateTypes.NodeStateInput({
            operator: operator,
            stakedToken: stakingToken,
            stakedAmount: stakeAmount,
            stakedValueUSD: stakedValueUSD,
            rewardToken: rewardToken,
            rpcUrl: rpcUrl,
            region: region,
            operatorAgentId: 0,
            stateVersion: 3,
            servicesHash: bytes32(0),
            metadataURI: ""
        });

        return registry.createNode(input);
    }

    function registerNodeWithAgent(
        address operator,
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        uint8 region,
        uint256 operatorAgentId
    ) external onlyRole(ROUTER_ROLE) returns (bytes32 nodeId) {
        _validateRegistration(stakingToken, stakeAmount, rewardToken, rpcUrl, region);
        uint256 stakedValueUSD = _calculateStakeValueUSD(stakingToken, stakeAmount);
        if (stakedValueUSD < minStakeUSD) revert InsufficientStakeValue(stakedValueUSD, minStakeUSD);

        NodeStateTypes.NodeStateInput memory input = NodeStateTypes.NodeStateInput({
            operator: operator,
            stakedToken: stakingToken,
            stakedAmount: stakeAmount,
            stakedValueUSD: stakedValueUSD,
            rewardToken: rewardToken,
            rpcUrl: rpcUrl,
            region: region,
            operatorAgentId: operatorAgentId,
            stateVersion: 3,
            servicesHash: bytes32(0),
            metadataURI: ""
        });

        return registry.createNode(input);
    }

    function increaseStake(address operator, bytes32 nodeId, uint256 amount) external onlyRole(ROUTER_ROLE) {
        if (amount == 0) revert InvalidStakeAmount();
        NodeStateTypes.NodeState memory node = registry.getNodeState(nodeId);
        if (node.operator != operator) revert NotNodeOperator(nodeId, operator);

        uint256 addedValueUSD = _calculateStakeValueUSD(node.stakedToken, amount);
        registry.increaseStakeFromModule(nodeId, operator, amount, addedValueUSD);
    }

    function updateNodeConfig(address operator, bytes32 nodeId, string calldata rpcUrl, uint8 region)
        external
        onlyRole(ROUTER_ROLE)
    {
        if (bytes(rpcUrl).length == 0) revert InvalidRpcUrl();
        if (region > 6) revert InvalidRegion();
        registry.updateNodeConfigFromModule(nodeId, operator, rpcUrl, region);
    }

    function updateNodeServices(address operator, bytes32 nodeId, bytes32 servicesHash) external onlyRole(ROUTER_ROLE) {
        registry.updateNodeServicesFromModule(nodeId, operator, servicesHash);
    }

    function setNodeMetadataURI(address operator, bytes32 nodeId, string calldata metadataURI)
        external
        onlyRole(ROUTER_ROLE)
    {
        registry.setNodeMetadataURIFromModule(nodeId, operator, metadataURI);
    }

    function claimRewards(address operator, bytes32 nodeId)
        external
        onlyRole(ROUTER_ROLE)
        returns (uint256 rewardsUSD)
    {
        NodeStateTypes.NodeState memory node = registry.getNodeState(nodeId);
        if (node.operator != operator) revert NotNodeOperator(nodeId, operator);

        rewardsUSD = 0;
        registry.recordRewardClaimFromModule(nodeId, operator, rewardsUSD);
    }

    function deregisterNode(address operator, bytes32 nodeId)
        external
        onlyRole(ROUTER_ROLE)
        returns (uint256 unstakedAmount)
    {
        unstakedAmount = registry.deactivateNodeFromModule(nodeId, operator, operator);
    }

    function _validateRegistration(
        address stakingToken,
        uint256 stakeAmount,
        address rewardToken,
        string calldata rpcUrl,
        uint8 region
    ) internal view {
        if (stakingToken == address(0) || rewardToken == address(0)) revert InvalidAddress();
        if (stakeAmount == 0) revert InvalidStakeAmount();
        if (bytes(rpcUrl).length == 0) revert InvalidRpcUrl();
        if (region > 6) revert InvalidRegion();
        if (!tokenRegistry.isSupported(stakingToken)) revert TokenNotSupported(stakingToken);
        if (!tokenRegistry.isSupported(rewardToken)) revert TokenNotSupported(rewardToken);
    }

    function _calculateStakeValueUSD(address stakingToken, uint256 stakeAmount) internal view returns (uint256) {
        (uint256 tokenPrice,) = priceOracle.getPrice(stakingToken);
        if (tokenPrice == 0) revert TokenNotSupported(stakingToken);
        return (stakeAmount * tokenPrice) / 1e18;
    }
}
