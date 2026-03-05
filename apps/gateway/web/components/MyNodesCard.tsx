import {
  formatTokenAmount,
  formatTokenUsd as formatUSD,
  NODE_SERVICE_DEFINITIONS,
  type NodeServiceId,
} from '@jejunetwork/shared'
import {
  TransactionStatusModal,
  type TransactionStatusResult,
} from '@jejunetwork/ui'
import { type LucideProps, Server } from 'lucide-react'
import type { ComponentType } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { type Hex, keccak256, parseUnits, toBytes } from 'viem'
import { usePublicClient } from 'wagmi'
import { CONTRACTS, EXPLORER_URL } from '../../lib/config'
import {
  formatUptimeScore,
  getNodeStakingAddress,
  NODE_STAKING_MANAGER_ABI,
  REGION_NAMES,
  type Region,
} from '../../lib/nodeStaking'
import {
  useNodeInfo,
  useNodeRewards,
  useNodeStaking,
} from '../hooks/useNodeStaking'
import { useProtocolTokens } from '../hooks/useProtocolTokens'

const ServerIcon = Server as ComponentType<LucideProps>
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const PRICE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getPrice',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'price', type: 'uint256' },
      { name: 'decimals', type: 'uint8' },
    ],
    stateMutability: 'view',
  },
] as const

interface NodeCardProps {
  nodeId: string
}

function NodeCard({ nodeId }: NodeCardProps) {
  const {
    nodeInfo,
    isLoading: isNodeInfoLoading,
    refetch: refetchNodeInfo,
  } = useNodeInfo(nodeId)
  const { pendingRewardsUSD, claimRewards, isClaiming, isClaimSuccess } =
    useNodeRewards(nodeId)
  const {
    deregisterNode,
    increaseNodeStake,
    updateNodeConfig,
    updateNodeServices,
    updateNodeMetadataURI,
    isDeregistering,
    isMutatingNode,
    refetchNodes,
    gasless,
  } = useNodeStaking()
  const { getToken } = useProtocolTokens()
  const publicClient = usePublicClient()
  const [stakeIncreaseInput, setStakeIncreaseInput] = useState('0')
  const [editRpcUrl, setEditRpcUrl] = useState('')
  const [editRegion, setEditRegion] = useState(0)
  const [metadataUri, setMetadataUri] = useState('')
  const [selectedServices, setSelectedServices] = useState<NodeServiceId[]>([])
  const [storedServicesHash, setStoredServicesHash] = useState<Hex | null>(null)
  const [storedMetadataUri, setStoredMetadataUri] = useState('')
  const [liveStakeValueUsdWei, setLiveStakeValueUsdWei] = useState<
    bigint | null
  >(null)
  const [isConfigInitialized, setIsConfigInitialized] = useState(false)
  const [actionResult, setActionResult] =
    useState<TransactionStatusResult | null>(null)

  const servicesHash = useMemo(() => {
    if (selectedServices.length === 0) return null
    const normalized = [...selectedServices].sort()
    return keccak256(toBytes(JSON.stringify(normalized)))
  }, [selectedServices])

  const toggleService = (serviceId: NodeServiceId) => {
    setSelectedServices((current) =>
      current.includes(serviceId)
        ? current.filter((value) => value !== serviceId)
        : [...current, serviceId],
    )
  }

  const markSubmitted = (title: string, message: string, txHash?: Hex) => {
    setActionResult({
      status: 'info',
      title,
      message,
      txHash,
      explorerUrl: EXPLORER_URL,
    })
  }

  const markError = (title: string, message: string, txHash?: Hex) => {
    setActionResult({
      status: 'error',
      title,
      message,
      txHash,
      explorerUrl: EXPLORER_URL,
    })
  }

  const markSuccess = (title: string, message: string, txHash?: Hex) => {
    setActionResult({
      status: 'success',
      title,
      message,
      txHash,
      explorerUrl: EXPLORER_URL,
    })
  }

  const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : 'Unknown transaction failure'

  useEffect(() => {
    if (!nodeInfo || isConfigInitialized) return
    const [loadedNode] = nodeInfo
    setEditRpcUrl(loadedNode.rpcUrl)
    setEditRegion(Number(loadedNode.geographicRegion))
    setIsConfigInitialized(true)
  }, [isConfigInitialized, nodeInfo])

  useEffect(() => {
    let cancelled = false

    async function loadStoredNodeMetadata() {
      if (!publicClient) return

      try {
        const stakingAddress = getNodeStakingAddress()
        const [servicesHashResult, metadataUriResult] = await Promise.all([
          publicClient.readContract({
            address: stakingAddress,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'getNodeServicesHash',
            args: [nodeId as `0x${string}`],
          }),
          publicClient.readContract({
            address: stakingAddress,
            abi: NODE_STAKING_MANAGER_ABI,
            functionName: 'getNodeMetadataURI',
            args: [nodeId as `0x${string}`],
          }),
        ])

        if (cancelled) return

        const resolvedHash = servicesHashResult as Hex
        const resolvedMetadataUri = metadataUriResult as string
        setStoredServicesHash(resolvedHash)
        setStoredMetadataUri(resolvedMetadataUri)
        if (!metadataUri && resolvedMetadataUri) {
          setMetadataUri(resolvedMetadataUri)
        }
      } catch {
        if (!cancelled) {
          setStoredServicesHash(null)
        }
      }
    }

    void loadStoredNodeMetadata()

    return () => {
      cancelled = true
    }
  }, [metadataUri, nodeId, publicClient])

  useEffect(() => {
    let cancelled = false

    async function loadLiveStakeValueUsd() {
      if (!publicClient || !nodeInfo || CONTRACTS.priceOracle === ZERO_ADDRESS)
        return
      const [node] = nodeInfo

      try {
        const [tokenPrice] = (await publicClient.readContract({
          address: CONTRACTS.priceOracle,
          abi: PRICE_ORACLE_ABI,
          functionName: 'getPrice',
          args: [node.stakedToken],
        })) as readonly [bigint, number]

        if (cancelled) return

        if (tokenPrice > 0n) {
          setLiveStakeValueUsdWei((node.stakedAmount * tokenPrice) / 10n ** 18n)
          return
        }
      } catch {
        // Fall back to on-chain snapshot value for this node
      }

      if (!cancelled) {
        setLiveStakeValueUsdWei(null)
      }
    }

    void loadLiveStakeValueUsd()

    return () => {
      cancelled = true
    }
  }, [nodeInfo, publicClient])

  if (!nodeInfo && isNodeInfoLoading) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', background: 'var(--surface-hover)' }}
      >
        <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading node...</p>
      </div>
    )
  }

  if (!nodeInfo) {
    return (
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'start',
            marginBottom: '0.75rem',
          }}
        >
          <div>
            <h3 style={{ fontSize: '1rem', margin: 0 }}>
              Node {nodeId.slice(0, 10)}...
            </h3>
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                margin: '0.25rem 0 0',
              }}
            >
              On-chain node found, richer metadata is still syncing.
            </p>
          </div>
          <span className="badge badge-warning">Metadata pending</span>
        </div>
        <code style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          {nodeId}
        </code>
      </div>
    )
  }

  const [node, perf] = nodeInfo
  const displayStakedValueUsdWei = liveStakeValueUsdWei ?? node.stakedValueUSD
  const stakingTokenInfo = getToken(node.stakedToken)
  const rewardTokenInfo = getToken(node.rewardToken)

  const pendingRewardAmount =
    rewardTokenInfo && pendingRewardsUSD
      ? (pendingRewardsUSD * BigInt(1e18)) /
        BigInt(Math.floor(rewardTokenInfo.priceUSD * 1e18))
      : 0n

  const canClaim = pendingRewardAmount > 0n
  const daysSinceRegistration = Math.floor(
    (Date.now() / 1000 - Number(node.registrationTime)) / 86400,
  )
  const canDeregister = daysSinceRegistration >= 7
  const normalizedOperator = node.operator.toLowerCase()
  const normalizedEoaOwner = gasless.ownerAddress?.toLowerCase()
  const normalizedSmartOwner = gasless.smartAccountAddress?.toLowerCase()
  const isSmartAccountOperator =
    normalizedSmartOwner === normalizedOperator && Boolean(normalizedSmartOwner)
  const canManageNode =
    normalizedOperator === normalizedEoaOwner || isSmartAccountOperator

  const runNodeMutation = async (params: {
    action: () => Promise<Hex>
    submittedTitle: string
    submittedMessage: string
    successTitle: string
    successMessage: string
    errorTitle: string
  }) => {
    try {
      const txHash = await params.action()
      markSubmitted(params.submittedTitle, params.submittedMessage, txHash)

      if (!publicClient) {
        markSuccess(
          params.successTitle,
          `${params.successMessage} (Awaiting confirmation in wallet activity.)`,
          txHash,
        )
        return
      }

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })
      if (receipt.status === 'success') {
        markSuccess(params.successTitle, params.successMessage, txHash)
        await Promise.all([
          refetchNodeInfo(),
          refetchNodes(),
          gasless.refreshState(),
        ])
        return
      }

      markError(
        params.errorTitle,
        'Transaction reverted on-chain during confirmation.',
        txHash,
      )
    } catch (error) {
      markError(params.errorTitle, getErrorMessage(error))
    }
  }

  const handleIncreaseStake = async () => {
    if (!canManageNode) {
      markError(
        'Increase stake failed',
        'Connected wallet does not match the node operator.',
      )
      return
    }

    if (!stakingTokenInfo) {
      markError('Increase stake failed', 'Unable to resolve staking token.')
      return
    }

    let amount: bigint
    try {
      amount = parseUnits(stakeIncreaseInput, stakingTokenInfo.decimals)
    } catch {
      markError(
        'Increase stake failed',
        `Invalid amount: "${stakeIncreaseInput}".`,
      )
      return
    }

    if (amount <= 0n) {
      markError('Increase stake failed', 'Amount must be greater than zero.')
      return
    }

    await runNodeMutation({
      action: () =>
        increaseNodeStake(nodeId, node.stakedToken, amount, {
          gasless: isSmartAccountOperator,
        }),
      submittedTitle: 'Stake increase submitted',
      submittedMessage: `Increasing stake by ${stakeIncreaseInput} ${stakingTokenInfo.symbol}.`,
      successTitle: 'Stake increased',
      successMessage: 'Node stake amount was updated on-chain.',
      errorTitle: 'Increase stake failed',
    })
    setStakeIncreaseInput('0')
  }

  const handleUpdateConfig = async () => {
    if (!canManageNode) {
      markError(
        'Config update failed',
        'Connected wallet does not match the node operator.',
      )
      return
    }

    const rpcUrl = editRpcUrl.trim()
    if (!rpcUrl) {
      markError('Config update failed', 'RPC URL is required.')
      return
    }

    await runNodeMutation({
      action: () =>
        updateNodeConfig(nodeId, rpcUrl, editRegion as Region, {
          gasless: isSmartAccountOperator,
        }),
      submittedTitle: 'Node config update submitted',
      submittedMessage: 'Updating endpoint and region on-chain.',
      successTitle: 'Node config updated',
      successMessage: 'Endpoint and region were updated on-chain.',
      errorTitle: 'Config update failed',
    })
  }

  const handleUpdateServices = async () => {
    if (!canManageNode) {
      markError(
        'Service update failed',
        'Connected wallet does not match the node operator.',
      )
      return
    }

    if (!servicesHash) {
      markError(
        'Service update failed',
        'Select at least one service before updating.',
      )
      return
    }

    await runNodeMutation({
      action: () =>
        updateNodeServices(nodeId, servicesHash, {
          gasless: isSmartAccountOperator,
        }),
      submittedTitle: 'Service update submitted',
      submittedMessage: 'Updating service set hash on-chain.',
      successTitle: 'Services updated',
      successMessage: 'Service hash was updated on-chain.',
      errorTitle: 'Service update failed',
    })
  }

  const handleUpdateMetadataUri = async () => {
    if (!canManageNode) {
      markError(
        'Metadata update failed',
        'Connected wallet does not match the node operator.',
      )
      return
    }

    const trimmedMetadataUri = metadataUri.trim()
    if (!trimmedMetadataUri) {
      markError('Metadata update failed', 'Metadata URI is required.')
      return
    }

    await runNodeMutation({
      action: () =>
        updateNodeMetadataURI(nodeId, trimmedMetadataUri, {
          gasless: isSmartAccountOperator,
        }),
      submittedTitle: 'Metadata update submitted',
      submittedMessage: 'Writing metadata URI pointer on-chain.',
      successTitle: 'Metadata URI updated',
      successMessage: 'Metadata URI pointer was updated on-chain.',
      errorTitle: 'Metadata update failed',
    })
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'start',
          marginBottom: '1rem',
        }}
      >
        <div>
          <h3 style={{ fontSize: '1.125rem', margin: 0 }}>{node.rpcUrl}</h3>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              margin: '0.25rem 0',
            }}
          >
            Node ID: {nodeId.slice(0, 10)}...
          </p>
        </div>
        {node.isActive ? (
          <span className="badge badge-success">Active</span>
        ) : node.isSlashed ? (
          <span className="badge badge-error">Slashed</span>
        ) : (
          <span className="badge">Inactive</span>
        )}
      </div>

      <div className="grid grid-2" style={{ marginBottom: '1rem' }}>
        <div>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              margin: 0,
            }}
          >
            Staked
          </p>
          <p
            style={{ fontSize: '1rem', fontWeight: '600', margin: '0.25rem 0' }}
          >
            {stakingTokenInfo &&
              formatTokenAmount(
                node.stakedAmount,
                stakingTokenInfo.decimals,
                2,
              )}{' '}
            {stakingTokenInfo?.symbol}
          </p>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              margin: 0,
            }}
          >
            ≈ {formatUSD(Number(displayStakedValueUsdWei) / 1e18)}
          </p>
        </div>

        <div>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              margin: 0,
            }}
          >
            Pending Rewards
          </p>
          <p
            style={{
              fontSize: '1rem',
              fontWeight: '600',
              margin: '0.25rem 0',
              color: 'var(--success)',
            }}
          >
            {rewardTokenInfo &&
              formatTokenAmount(
                pendingRewardAmount,
                rewardTokenInfo.decimals,
                2,
              )}{' '}
            {rewardTokenInfo?.symbol}
          </p>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              margin: 0,
            }}
          >
            ≈ {formatUSD(Number(pendingRewardsUSD ?? 0n) / 1e18)}
          </p>
        </div>
      </div>

      <div
        className="grid grid-3"
        style={{ marginBottom: '1rem', gap: '0.75rem' }}
      >
        <div>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              margin: 0,
            }}
          >
            Uptime
          </p>
          <p
            style={{ fontSize: '1rem', fontWeight: '600', margin: '0.25rem 0' }}
          >
            {formatUptimeScore(perf.uptimeScore)}
          </p>
        </div>
        <div>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              margin: 0,
            }}
          >
            Requests
          </p>
          <p
            style={{ fontSize: '1rem', fontWeight: '600', margin: '0.25rem 0' }}
          >
            {Number(perf.requestsServed).toLocaleString()}
          </p>
        </div>
        <div>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              margin: 0,
            }}
          >
            Response
          </p>
          <p
            style={{ fontSize: '1rem', fontWeight: '600', margin: '0.25rem 0' }}
          >
            {Number(perf.avgResponseTime)}ms
          </p>
        </div>
      </div>

      <p
        style={{
          fontSize: '0.875rem',
          color: 'var(--text-secondary)',
          marginBottom: '1rem',
        }}
      >
        📍 {REGION_NAMES[node.geographicRegion as keyof typeof REGION_NAMES]} •
        Registered {daysSinceRegistration} days ago
      </p>

      {isClaimSuccess && (
        <div
          style={{
            padding: '1rem',
            background: 'var(--success-soft)',
            borderRadius: '8px',
            marginBottom: '1rem',
          }}
        >
          <p style={{ color: 'var(--success)', margin: 0 }}>
            ✅ Rewards claimed successfully!
          </p>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="button"
          onClick={() => claimRewards(nodeId)}
          disabled={!canClaim || isClaiming || !node.isActive}
          style={{ flex: 1 }}
        >
          {isClaiming
            ? 'Claiming...'
            : `Claim ${rewardTokenInfo?.symbol ?? 'Rewards'}`}
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => deregisterNode(nodeId)}
          disabled={!canDeregister || isDeregistering}
          style={{ flex: 1 }}
        >
          {isDeregistering ? 'Deregistering...' : 'Deregister'}
        </button>
      </div>

      {!canDeregister && (
        <p
          style={{
            fontSize: '0.75rem',
            color: 'var(--warning)',
            marginTop: '0.5rem',
          }}
        >
          ⏱️ Can deregister in {7 - daysSinceRegistration} days (minimum 7-day
          period)
        </p>
      )}

      <div
        style={{
          marginTop: '1rem',
          borderTop: '1px solid var(--border)',
          paddingTop: '1rem',
          display: 'grid',
          gap: '0.9rem',
        }}
      >
        <h4 style={{ margin: 0, fontSize: '0.95rem' }}>Manage Node</h4>

        {!canManageNode ? (
          <p
            style={{
              margin: 0,
              fontSize: '0.8rem',
              color: 'var(--warning)',
            }}
          >
            Connected wallet is not the on-chain operator for this node.
          </p>
        ) : null}

        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Increase Stake ({stakingTokenInfo?.symbol ?? 'token'})
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="number"
              min="0"
              step="0.000001"
              value={stakeIncreaseInput}
              onChange={(event) => setStakeIncreaseInput(event.target.value)}
              className="input"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="button button-secondary"
              disabled={isMutatingNode || !canManageNode}
              onClick={handleIncreaseStake}
            >
              Increase Stake
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Endpoint / Region
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 180px auto',
              gap: '0.5rem',
            }}
          >
            <input
              type="text"
              value={editRpcUrl}
              onChange={(event) => setEditRpcUrl(event.target.value)}
              className="input"
              placeholder="https://node.example.com/"
            />
            <select
              value={editRegion}
              onChange={(event) => setEditRegion(Number(event.target.value))}
              className="input"
            >
              {Object.entries(REGION_NAMES).map(([regionId, label]) => (
                <option key={regionId} value={regionId}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button button-secondary"
              disabled={isMutatingNode || !canManageNode}
              onClick={handleUpdateConfig}
            >
              Save Config
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Services
            </div>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <button
                type="button"
                className="button button-secondary"
                style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem' }}
                onClick={() =>
                  setSelectedServices(
                    NODE_SERVICE_DEFINITIONS.map((service) => service.id),
                  )
                }
              >
                Pick all
              </button>
              <button
                type="button"
                className="button button-secondary"
                style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem' }}
                onClick={() => setSelectedServices([])}
              >
                Unpick all
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {NODE_SERVICE_DEFINITIONS.map((service) => {
              const selected = selectedServices.includes(service.id)
              return (
                <button
                  key={service.id}
                  type="button"
                  className="button button-secondary"
                  style={{
                    padding: '0.25rem 0.5rem',
                    fontSize: '0.75rem',
                    borderColor: selected ? 'var(--accent)' : undefined,
                    color: selected ? 'var(--accent)' : undefined,
                  }}
                  onClick={() => toggleService(service.id)}
                >
                  {service.id}
                </button>
              )
            })}
          </div>
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              fontFamily: 'monospace',
              wordBreak: 'break-all',
            }}
          >
            New hash: {servicesHash ?? 'not set'} <br />
            Current hash: {storedServicesHash ?? 'unknown'}
          </div>
          <button
            type="button"
            className="button button-secondary"
            disabled={isMutatingNode || !canManageNode || !servicesHash}
            onClick={handleUpdateServices}
          >
            Save Services
          </button>
        </div>

        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Metadata URI
          </div>
          <input
            type="text"
            value={metadataUri}
            onChange={(event) => setMetadataUri(event.target.value)}
            className="input"
            placeholder="ipfs://... or https://..."
          />
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Current metadata URI: {storedMetadataUri || 'not set'}
          </div>
          <button
            type="button"
            className="button button-secondary"
            disabled={isMutatingNode || !canManageNode}
            onClick={handleUpdateMetadataUri}
          >
            Save Metadata
          </button>
        </div>
      </div>

      {actionResult ? (
        <TransactionStatusModal
          result={actionResult}
          onClose={() => setActionResult(null)}
        />
      ) : null}
    </div>
  )
}

export default function MyNodesCard() {
  const { operatorNodeIds, operatorStats } = useNodeStaking()
  const hasStakingActivity = Number(operatorStats?.totalNodesActive ?? 0n) > 0

  if (!operatorNodeIds || operatorNodeIds.length === 0) {
    return (
      <div
        className="card"
        style={{ textAlign: 'center', padding: '3rem 1rem' }}
      >
        <ServerIcon
          size={48}
          style={{ margin: '0 auto 1rem', color: 'var(--text-muted)' }}
        />
        <h3 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
          No Nodes Yet
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          {hasStakingActivity
            ? 'On-chain node activity exists for this operator, but node details are still syncing.'
            : 'Stake tokens and register a node to start earning rewards'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>
        My Nodes ({operatorNodeIds.length})
      </h2>

      {operatorNodeIds.map((nodeId) => (
        <NodeCard key={nodeId} nodeId={nodeId} />
      ))}
    </div>
  )
}
