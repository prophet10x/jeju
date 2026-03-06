// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IRuntimeParameterExecutor {
    function setParameter(bytes32 parameterId, bytes calldata value) external returns (bool success);
    function runtimeDelaySeconds() external view returns (uint256);
    function acceptGovernance() external;
}

interface IConstitutionalGovernorRouter {
    function submitCoreUpgradeProposal(
        address target,
        bytes calldata data,
        string calldata description,
        string calldata metadataURI
    ) external returns (bytes32 proposalId);
}

/**
 * @title MetaAgentActionRouter
 * @notice Routes runoff winner intents into runtime lane or constitutional lane.
 * @dev Runtime parameter updates are queued with delay and executed trustlessly.
 */
contract MetaAgentActionRouter is Ownable {
    struct RuntimeParameterAction {
        bytes32 actionId;
        bytes32 roundId;
        bytes32 parameterId;
        uint256 newValue;
        uint256 queuedAt;
        uint256 executeAfter;
        bool executed;
    }

    IRuntimeParameterExecutor public parameters;
    IConstitutionalGovernorRouter public constitutionalGovernor;
    address public runoffGovernor;

    uint256 private _runtimeActionNonce;

    mapping(bytes32 => RuntimeParameterAction) public runtimeActions;

    event ParametersUpdated(address indexed oldParameters, address indexed newParameters);
    event ConstitutionalGovernorUpdated(address indexed oldGovernor, address indexed newGovernor);
    event RunoffGovernorUpdated(address indexed oldGovernor, address indexed newGovernor);

    event RuntimeParameterActionQueued(
        bytes32 indexed actionId,
        bytes32 indexed roundId,
        bytes32 indexed parameterId,
        uint256 newValue,
        uint256 executeAfter
    );
    event RuntimeParameterActionExecuted(bytes32 indexed actionId, bytes32 indexed parameterId, uint256 newValue);
    event ParameterGovernanceAccepted(address indexed parameters);
    event ConstitutionalUpgradeForwarded(
        bytes32 indexed roundId,
        bytes32 indexed constitutionalProposalId,
        address indexed target,
        string description
    );

    error InvalidAddress();
    error NotRunoffGovernor();
    error RuntimeActionNotFound();
    error RuntimeActionAlreadyExecuted();
    error RuntimeActionNotReady();

    modifier onlyRunoffGovernor() {
        if (msg.sender != runoffGovernor) revert NotRunoffGovernor();
        _;
    }

    constructor(address _parameters, address _constitutionalGovernor, address _runoffGovernor, address initialOwner)
        Ownable(initialOwner)
    {
        if (_parameters == address(0) || _constitutionalGovernor == address(0) || _runoffGovernor == address(0)) {
            revert InvalidAddress();
        }

        parameters = IRuntimeParameterExecutor(_parameters);
        constitutionalGovernor = IConstitutionalGovernorRouter(_constitutionalGovernor);
        runoffGovernor = _runoffGovernor;
    }

    function setParameters(address newParameters) external onlyOwner {
        if (newParameters == address(0)) revert InvalidAddress();
        address oldParameters = address(parameters);
        parameters = IRuntimeParameterExecutor(newParameters);
        emit ParametersUpdated(oldParameters, newParameters);
    }

    function setConstitutionalGovernor(address newConstitutionalGovernor) external onlyOwner {
        if (newConstitutionalGovernor == address(0)) revert InvalidAddress();
        address oldGovernor = address(constitutionalGovernor);
        constitutionalGovernor = IConstitutionalGovernorRouter(newConstitutionalGovernor);
        emit ConstitutionalGovernorUpdated(oldGovernor, newConstitutionalGovernor);
    }

    function setRunoffGovernor(address newRunoffGovernor) external onlyOwner {
        if (newRunoffGovernor == address(0)) revert InvalidAddress();
        address oldGovernor = runoffGovernor;
        runoffGovernor = newRunoffGovernor;
        emit RunoffGovernorUpdated(oldGovernor, newRunoffGovernor);
    }

    function queueRuntimeParameterUpdate(bytes32 roundId, bytes32 parameterId, uint256 newValue)
        external
        onlyRunoffGovernor
        returns (bytes32 actionId)
    {
        uint256 runtimeDelay = parameters.runtimeDelaySeconds();
        uint256 executeAfter = block.timestamp + runtimeDelay;

        actionId = keccak256(
            abi.encode(roundId, parameterId, newValue, block.timestamp, block.chainid, _runtimeActionNonce++)
        );

        runtimeActions[actionId] = RuntimeParameterAction({
            actionId: actionId,
            roundId: roundId,
            parameterId: parameterId,
            newValue: newValue,
            queuedAt: block.timestamp,
            executeAfter: executeAfter,
            executed: false
        });

        emit RuntimeParameterActionQueued(actionId, roundId, parameterId, newValue, executeAfter);
    }

    function executeRuntimeParameterAction(bytes32 actionId) external {
        RuntimeParameterAction storage action = runtimeActions[actionId];
        if (action.queuedAt == 0) revert RuntimeActionNotFound();
        if (action.executed) revert RuntimeActionAlreadyExecuted();
        if (block.timestamp < action.executeAfter) revert RuntimeActionNotReady();

        action.executed = true;
        parameters.setParameter(action.parameterId, abi.encode(action.newValue));

        emit RuntimeParameterActionExecuted(actionId, action.parameterId, action.newValue);
    }

    function acceptParameterGovernance() external onlyOwner {
        parameters.acceptGovernance();
        emit ParameterGovernanceAccepted(address(parameters));
    }

    function forwardConstitutionalUpgrade(
        bytes32 roundId,
        address target,
        bytes calldata data,
        string calldata description,
        string calldata metadataURI
    ) external onlyRunoffGovernor returns (bytes32 constitutionalProposalId) {
        constitutionalProposalId = constitutionalGovernor.submitCoreUpgradeProposal(
            target, data, description, metadataURI
        );

        emit ConstitutionalUpgradeForwarded(roundId, constitutionalProposalId, target, description);
    }
}
