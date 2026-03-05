import {
  NODE_SERVICE_DEFINITIONS,
  type NodeServiceId,
} from "@jejunetwork/shared";
import {
  TransactionStatusModal,
  type TransactionStatusResult,
} from "@jejunetwork/ui";
import { WalletButton } from "@jejunetwork/ui/wallet";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Award,
  Clock,
  Cpu,
  DollarSign,
  Globe,
  HardDrive,
  RefreshCw,
  Server,
  TrendingUp,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { type Address, type Hex, keccak256, parseUnits, toBytes } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { SkeletonStatCard } from "../../components/Skeleton";
import { CONTRACTS, EXPLORER_URL, NETWORK } from "../../config";
import { useConfirm, useToast } from "../../context/AppContext";
import {
  useClaimRewards,
  useDeregisterNode,
  useNodeManagement,
  useUpdateNodePerformance,
} from "../../hooks";
import {
  type EarningsHistoryItem,
  type NodeInfo,
  useAggregateStats,
  useEarningsHistory,
  useOperatorStats,
} from "../../hooks/useStaking";

const REGION_TO_VALUE = {
  NorthAmerica: 0,
  SouthAmerica: 1,
  Europe: 2,
  Asia: 3,
  Africa: 4,
  Oceania: 5,
  Global: 6,
} as const;

const REGION_OPTIONS = [
  { value: REGION_TO_VALUE.NorthAmerica, label: "North America" },
  { value: REGION_TO_VALUE.SouthAmerica, label: "South America" },
  { value: REGION_TO_VALUE.Europe, label: "Europe" },
  { value: REGION_TO_VALUE.Asia, label: "Asia" },
  { value: REGION_TO_VALUE.Africa, label: "Africa" },
  { value: REGION_TO_VALUE.Oceania, label: "Oceania" },
  { value: REGION_TO_VALUE.Global, label: "Global" },
] as const;

const PRICE_ORACLE_ABI = [
  {
    type: "function",
    name: "getPrice",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "price", type: "uint256" },
      { name: "decimals", type: "uint8" },
    ],
    stateMutability: "view",
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function formatNodeVersionLabel(node: NodeInfo): string {
  if (typeof node.stateVersion === "number" && node.stateVersion > 0) {
    return `V${node.stateVersion}`;
  }
  return node.isLegacy ? "Legacy" : "Unknown";
}

export default function NodeOperatorDashboard() {
  const { isConnected, address } = useAccount();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showSuccess, showError } = useToast();
  const confirm = useConfirm();
  const claimRewards = useClaimRewards();
  const deregisterNode = useDeregisterNode();
  const updatePerformance = useUpdateNodePerformance();
  const {
    data: operatorStats,
    isLoading: statsLoading,
    refetch: refetchStats,
  } = useOperatorStats();
  const { isLoading: aggregateLoading, data: stats } = useAggregateStats();
  const { data: earningsHistory } = useEarningsHistory();
  const publicClient = usePublicClient();
  const [tokenPricesUsd, setTokenPricesUsd] = useState<Record<string, number>>(
    {},
  );
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [claimingNode, setClaimingNode] = useState<string | null>(null);
  const [updatingNode, setUpdatingNode] = useState<string | null>(null);
  const [deregisteringNode, setDeregisteringNode] = useState<string | null>(
    null,
  );
  const requestedNodeParam = searchParams.get("node")?.toLowerCase() ?? null;

  const updateSelectedNode = (nodeId: string | null) => {
    setSelectedNode(nodeId);
    const nextParams = new URLSearchParams(searchParams);
    if (nodeId) {
      nextParams.set("node", nodeId);
    } else {
      nextParams.delete("node");
    }
    setSearchParams(nextParams, { replace: true });
  };

  const handleClaimRewards = async (nodeId: string, nodeName: string) => {
    const confirmed = await confirm({
      title: "Claim Rewards",
      message: `Claim all pending rewards for node ${nodeName}? This will transfer the rewards to your wallet.`,
      confirmText: "Claim",
      cancelText: "Cancel",
    });

    if (!confirmed) return;

    setClaimingNode(nodeId);
    try {
      const result = await claimRewards.mutateAsync(nodeId);
      showSuccess(
        "Rewards claimed",
        `Successfully claimed ${result.claimed} tokens`,
      );
      refetchStats();
    } catch (error) {
      showError(
        "Claim failed",
        error instanceof Error ? error.message : "Failed to claim rewards",
      );
    } finally {
      setClaimingNode(null);
    }
  };

  const handleClaimAllRewards = async () => {
    const nodes = operatorStats?.nodes ?? [];
    const nodesWithRewards = nodes.filter(
      (n) => parseFloat(n.pendingRewards) > 0,
    );

    if (nodesWithRewards.length === 0) {
      showError("No rewards", "No pending rewards to claim");
      return;
    }

    const confirmed = await confirm({
      title: "Claim All Rewards",
      message: `Claim rewards from ${nodesWithRewards.length} node(s)? This will transfer all pending rewards to your wallet.`,
      confirmText: "Claim All",
      cancelText: "Cancel",
    });

    if (!confirmed) return;

    let successCount = 0;
    let failCount = 0;

    for (const node of nodesWithRewards) {
      try {
        await claimRewards.mutateAsync(node.nodeId);
        successCount++;
      } catch {
        failCount++;
      }
    }

    if (successCount > 0) {
      showSuccess(
        "Rewards claimed",
        `Successfully claimed from ${successCount} node(s)`,
      );
      refetchStats();
    }

    if (failCount > 0) {
      showError("Partial failure", `Failed to claim from ${failCount} node(s)`);
    }
  };

  const handleDeregisterNode = async (nodeId: string, nodeName: string) => {
    const confirmed = await confirm({
      title: "Deregister Node",
      message: `Are you sure you want to deregister node ${nodeName}? Your stake will be returned after a cooldown period.`,
      confirmText: "Deregister",
      cancelText: "Cancel",
      destructive: true,
    });

    if (!confirmed) return;

    setDeregisteringNode(nodeId);
    try {
      await deregisterNode.mutateAsync(nodeId);
      showSuccess(
        "Node deregistered",
        `Node ${nodeName} has been deregistered`,
      );
      refetchStats();
      updateSelectedNode(null);
    } catch (error) {
      showError(
        "Deregistration failed",
        error instanceof Error ? error.message : "Failed to deregister node",
      );
    } finally {
      setDeregisteringNode(null);
    }
  };

  const handleUpdatePerformance = async (nodeId: string, nodeName: string) => {
    setUpdatingNode(nodeId);
    try {
      await updatePerformance.mutateAsync(nodeId);
      showSuccess(
        "Performance updated",
        `Node ${nodeName} performance metrics refreshed`,
      );
      refetchStats();
    } catch (error) {
      showError(
        "Update failed",
        error instanceof Error ? error.message : "Failed to update performance",
      );
    } finally {
      setUpdatingNode(null);
    }
  };

  const isLoading = statsLoading || aggregateLoading;
  const nodes = operatorStats?.nodes ?? [];
  const hasStakingActivity = (operatorStats?.totalNodesActive ?? 0) > 0;
  const selectedNodeData = selectedNode
    ? nodes.find((node) => node.nodeId === selectedNode)
    : undefined;

  useEffect(() => {
    if (!requestedNodeParam || nodes.length === 0) return;
    const requestedNode = nodes.find(
      (node) => node.nodeId.toLowerCase() === requestedNodeParam,
    );
    if (!requestedNode || selectedNode === requestedNode.nodeId) return;
    setSelectedNode(requestedNode.nodeId);
  }, [requestedNodeParam, nodes, selectedNode]);

  useEffect(() => {
    if (!selectedNodeData && selectedNode) {
      updateSelectedNode(null);
    }
  }, [selectedNode, selectedNodeData]);

  useEffect(() => {
    let cancelled = false;

    async function loadTokenPrices() {
      if (!publicClient || CONTRACTS.priceOracle === ZERO_ADDRESS) return;

      const uniqueTokenAddresses = Array.from(
        new Set(
          nodes
            .map((node) => node.stakedToken?.toLowerCase())
            .filter((tokenAddress): tokenAddress is string =>
              Boolean(tokenAddress && tokenAddress !== ZERO_ADDRESS),
            ),
        ),
      );

      if (uniqueTokenAddresses.length === 0) return;

      const results = await Promise.all(
        uniqueTokenAddresses.map(async (tokenAddress) => {
          try {
            const [price] = (await publicClient.readContract({
              address: CONTRACTS.priceOracle,
              abi: PRICE_ORACLE_ABI,
              functionName: "getPrice",
              args: [tokenAddress as Address],
            })) as readonly [bigint, number];

            return [tokenAddress, Number(price) / 1e18] as const;
          } catch {
            return null;
          }
        }),
      );

      if (cancelled) return;

      const nextPrices: Record<string, number> = {};
      for (const result of results) {
        if (!result) continue;
        const [tokenAddress, priceUsd] = result;
        if (
          NETWORK === "testnet" &&
          tokenAddress === CONTRACTS.jeju.toLowerCase()
        ) {
          nextPrices[tokenAddress] = 1;
          continue;
        }
        if (Number.isFinite(priceUsd) && priceUsd > 0) {
          nextPrices[tokenAddress] = priceUsd;
        }
      }

      setTokenPricesUsd(nextPrices);
    }

    void loadTokenPrices();

    return () => {
      cancelled = true;
    };
  }, [nodes, publicClient]);

  const getDisplayStakedUsd = (node: NodeInfo) => {
    const snapshotUsd = Number(node.stakedValueUSD);
    const tokenAddress = node.stakedToken?.toLowerCase();
    const livePriceUsd = tokenAddress
      ? tokenPricesUsd[tokenAddress]
      : undefined;
    const stakedAmount = Number(node.stakedAmount);

    if (
      livePriceUsd &&
      Number.isFinite(stakedAmount) &&
      Number.isFinite(livePriceUsd) &&
      stakedAmount > 0
    ) {
      return stakedAmount * livePriceUsd;
    }

    return Number.isFinite(snapshotUsd) ? snapshotUsd : 0;
  };

  const operatorDisplayTotalStakedUsd = nodes.reduce(
    (sum, node) => sum + getDisplayStakedUsd(node),
    0,
  );
  const networkSnapshotTotalStakedUsd = Number(
    stats?.network.totalStakedUSD ?? "0",
  );
  const networkDisplayTotalStakedUsd = Math.max(
    networkSnapshotTotalStakedUsd,
    operatorDisplayTotalStakedUsd,
  );
  const networkSnapshotTotalNodes = Number(stats?.network.totalNodes ?? 0);
  const networkDisplayTotalNodes = Math.max(networkSnapshotTotalNodes, nodes.length);
  const operatorDisplayNetworkSharePercent =
    networkDisplayTotalNodes > 0
      ? (nodes.length / networkDisplayTotalNodes) * 100
      : Number(stats?.operator.networkSharePercent ?? "0");

  if (!isConnected || !address) {
    return (
      <div className="empty-state" style={{ paddingTop: "4rem" }}>
        <Server size={64} />
        <h3>Connect wallet to view your nodes</h3>
        <p style={{ marginBottom: "1rem" }}>
          View your registered nodes, earnings, and performance
        </p>
        <WalletButton />
      </div>
    );
  }

  return (
    <div>
      <div
        className="page-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <h1 className="page-title">Node Operator Dashboard</h1>
          <p className="page-subtitle">
            Manage your nodes, track earnings, and claim rewards
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => refetchStats()}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* Stats Overview */}
      <div className="stats-grid">
        {isLoading ? (
          <>
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
          </>
        ) : (
          <>
            <StatCard
              icon={<Server size={24} />}
              iconClass="compute"
              label="Active Nodes"
              value={stats?.operator.nodesActive.toString() ?? "0"}
              change={`${operatorDisplayNetworkSharePercent.toFixed(2)}% of network`}
              changeType="neutral"
            />
            <StatCard
              icon={<DollarSign size={24} />}
              iconClass="storage"
              label="Total Staked"
              value={`$${formatNumber(operatorDisplayTotalStakedUsd)}`}
              change="USD value"
              changeType="neutral"
            />
            <StatCard
              icon={<TrendingUp size={24} />}
              iconClass="network"
              label="Est. Monthly"
              value={`$${stats?.earnings.estimatedMonthlyUSD ?? "0"}`}
              change={`$${stats?.earnings.estimatedDailyUSD ?? "0"}/day`}
              changeType="positive"
            />
            <StatCard
              icon={<Award size={24} />}
              iconClass="ai"
              label="Pending Rewards"
              value={`$${stats?.earnings.totalPendingUSD ?? "0"}`}
              change="Claimable now"
              changeType="positive"
            />
          </>
        )}
      </div>

      <div
        className="node-dashboard-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(300px, 1fr)",
          gap: "1.5rem",
          marginTop: "1.5rem",
        }}
      >
        {/* Nodes List */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <HardDrive size={18} /> Your Nodes
            </h3>
            <a
              href="/provider/node/register"
              className="btn btn-sm btn-primary"
            >
              <Server size={14} /> Register Node
            </a>
          </div>

          {nodes.length === 0 ? (
            <div className="empty-state" style={{ padding: "2rem" }}>
              <Server size={48} />
              <h4>
                {hasStakingActivity
                  ? "Node metadata pending"
                  : "No nodes registered"}
              </h4>
              <p>
                {hasStakingActivity
                  ? "On-chain node activity exists for this operator, but details are still syncing."
                  : "Register a node to start earning rewards"}
              </p>
              <a
                href="/provider/node/register"
                className="btn btn-primary"
                style={{ marginTop: "1rem" }}
              >
                {hasStakingActivity
                  ? "Register another node"
                  : "Register Your First Node"}
              </a>
            </div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Node ID</th>
                    <th>Region</th>
                    <th>Status</th>
                    <th>Uptime</th>
                    <th>Staked</th>
                    <th>Pending</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((node) => (
                    <NodeRow
                      key={node.nodeId}
                      node={node}
                      displayStakedUsd={getDisplayStakedUsd(node)}
                      isSelected={selectedNode === node.nodeId}
                      isClaiming={claimingNode === node.nodeId}
                      onSelect={() =>
                        updateSelectedNode(
                          selectedNode === node.nodeId ? null : node.nodeId,
                        )
                      }
                      onClaim={() =>
                        handleClaimRewards(
                          node.nodeId,
                          node.nodeId.slice(0, 10),
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right Sidebar */}
        <div
          style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
        >
          {/* Earnings Summary */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Wallet size={18} /> Earnings
              </h3>
            </div>
            <div style={{ display: "grid", gap: "1rem" }}>
              <EarningsRow
                label="Lifetime Earned"
                value={`$${formatNumber(stats?.operator.lifetimeRewardsUSD ?? "0")}`}
              />
              <EarningsRow
                label="Pending Rewards"
                value={`$${stats?.earnings.totalPendingUSD ?? "0"}`}
                highlight
              />
              <EarningsRow
                label="Est. Monthly"
                value={`$${stats?.earnings.estimatedMonthlyUSD ?? "0"}`}
              />
              <EarningsRow
                label="Est. Daily"
                value={`$${stats?.earnings.estimatedDailyUSD ?? "0"}`}
              />
              {nodes.length > 0 &&
                parseFloat(stats?.earnings.totalPendingUSD ?? "0") > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ marginTop: "0.5rem" }}
                    onClick={handleClaimAllRewards}
                    disabled={claimRewards.isPending}
                  >
                    {claimRewards.isPending ? (
                      "Claiming..."
                    ) : (
                      <>
                        <DollarSign size={16} /> Claim All Rewards
                      </>
                    )}
                  </button>
                )}
            </div>
          </div>

          {/* Performance Summary */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Activity size={18} /> Performance
              </h3>
            </div>
            <div style={{ display: "grid", gap: "1rem" }}>
              <PerformanceMetric
                label="Avg. Uptime"
                value={`${stats?.operator.avgUptimePercent ?? "0"}%`}
                icon={<Clock size={16} />}
                status={
                  parseFloat(stats?.operator.avgUptimePercent ?? "0") >= 99
                    ? "good"
                    : parseFloat(stats?.operator.avgUptimePercent ?? "0") >= 95
                      ? "warning"
                      : "bad"
                }
              />
              <PerformanceMetric
                label="Requests Served"
                value={formatNumber(
                  stats?.operator.totalRequestsServed?.toString() ?? "0",
                )}
                icon={<Zap size={16} />}
                status="neutral"
              />
              <PerformanceMetric
                label="Network Share"
                value={`${stats?.operator.networkSharePercent ?? "0"}%`}
                icon={<Globe size={16} />}
                status="neutral"
              />
            </div>
          </div>

          {/* Network Stats */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Users size={18} /> Network
              </h3>
            </div>
            <div style={{ display: "grid", gap: "0.75rem" }}>
              <NetworkStat
                label="Total Nodes"
                value={networkDisplayTotalNodes.toString()}
              />
              <NetworkStat
                label="Total Staked"
                value={`$${formatNumber(networkDisplayTotalStakedUsd)}`}
              />
              <NetworkStat
                label="Min. Stake"
                value={`$${formatNumber(stats?.network.minStakeUSD ?? "0")}`}
              />
              <NetworkStat
                label="Base Reward"
                value={`$${formatNumber(stats?.network.baseRewardPerMonthUSD ?? "0")}/mo`}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Selected Node Details */}
      {selectedNode && (
        <NodeDetailsPanel
          node={selectedNodeData}
          displayStakedUsd={
            selectedNodeData ? getDisplayStakedUsd(selectedNodeData) : 0
          }
          onClose={() => updateSelectedNode(null)}
          onClaim={handleClaimRewards}
          onDeregister={handleDeregisterNode}
          onUpdatePerformance={handleUpdatePerformance}
          isClaiming={claimingNode === selectedNode}
          isDeregistering={deregisteringNode === selectedNode}
          isUpdating={updatingNode === selectedNode}
        />
      )}

      {/* Recent Activity */}
      {earningsHistory && earningsHistory.history.length > 0 && (
        <div className="card" style={{ marginTop: "1.5rem" }}>
          <div className="card-header">
            <h3 className="card-title">
              <RefreshCw size={18} /> Recent Activity
            </h3>
          </div>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Node</th>
                  <th>Amount</th>
                  <th>Block</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {earningsHistory.history.slice(0, 10).map((item) => (
                  <ActivityRow
                    key={`${item.nodeId}-${item.blockNumber}`}
                    item={item}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper Components

function StatCard({
  icon,
  iconClass,
  label,
  value,
  change,
  changeType,
}: {
  icon: React.ReactNode;
  iconClass: string;
  label: string;
  value: string;
  change: string;
  changeType: "positive" | "negative" | "neutral";
}) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${iconClass}`}>{icon}</div>
      <div className="stat-content">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        <div className={`stat-change ${changeType}`}>{change}</div>
      </div>
    </div>
  );
}

function NodeRow({
  node,
  displayStakedUsd,
  isSelected,
  isClaiming,
  onSelect,
  onClaim,
}: {
  node: NodeInfo;
  displayStakedUsd: number;
  isSelected: boolean;
  isClaiming: boolean;
  onSelect: () => void;
  onClaim: () => void;
}) {
  const hasPendingRewards = parseFloat(node.pendingRewards) > 0;

  const handleRowClick = (e: React.MouseEvent) => {
    // Don't trigger row click when clicking buttons
    if ((e.target as HTMLElement).closest("button")) return;
    onSelect();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <tr
      style={{
        cursor: "pointer",
        background: isSelected ? "var(--bg-tertiary)" : undefined,
      }}
      onClick={handleRowClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-selected={isSelected}
    >
      <td>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
          {node.nodeId.slice(0, 10)}...
        </div>
        <div style={{ marginTop: "0.25rem" }}>
          <span
            className={`badge ${node.isLegacy ? "badge-warning" : "badge-info"}`}
          >
            {formatNodeVersionLabel(node)}
          </span>
        </div>
      </td>
      <td>{node.region}</td>
      <td>
        {node.metadataPending ? (
          <span className="badge badge-warning">Metadata pending</span>
        ) : (
          <span
            className={`badge ${node.isActive ? "badge-success" : node.isSlashed ? "badge-error" : "badge-warning"}`}
          >
            {node.isActive ? "Active" : node.isSlashed ? "Slashed" : "Inactive"}
          </span>
        )}
      </td>
      <td>
        <span
          style={{
            color:
              node.performance.uptimeScore >= 9900
                ? "var(--success)"
                : node.performance.uptimeScore >= 9500
                  ? "var(--warning)"
                  : "var(--error)",
          }}
        >
          {(node.performance.uptimeScore / 100).toFixed(1)}%
        </span>
      </td>
      <td>${formatNumber(displayStakedUsd)}</td>
      <td style={{ color: "var(--success)" }}>
        ${formatNumber(node.pendingRewards)}
      </td>
      <td>
        {hasPendingRewards ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onClaim();
            }}
            disabled={isClaiming}
            title="Claim rewards"
          >
            {isClaiming ? "..." : <DollarSign size={14} />}
          </button>
        ) : (
          <ArrowUpRight
            size={16}
            style={{ color: "var(--text-muted)", cursor: "pointer" }}
            onClick={onSelect}
          />
        )}
      </td>
    </tr>
  );
}

function EarningsRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "0.75rem",
        background: highlight ? "rgba(34, 197, 94, 0.1)" : "var(--bg-tertiary)",
        borderRadius: "var(--radius-md)",
        border: highlight ? "1px solid var(--success)" : undefined,
      }}
    >
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          color: highlight ? "var(--success)" : "var(--text)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function PerformanceMetric({
  label,
  value,
  icon,
  status,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  status: "good" | "warning" | "bad" | "neutral";
}) {
  const statusColors = {
    good: "var(--success)",
    warning: "var(--warning)",
    bad: "var(--error)",
    neutral: "var(--text-secondary)",
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.5rem 0",
      }}
    >
      <div style={{ color: statusColors[status] }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
          {label}
        </div>
        <div
          style={{
            fontWeight: 600,
            color: statusColors[status],
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function NetworkStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
        {label}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>
        {value}
      </span>
    </div>
  );
}

function NodeDetailsPanel({
  node,
  displayStakedUsd,
  onClose,
  onClaim,
  onDeregister,
  onUpdatePerformance,
  isClaiming,
  isDeregistering,
  isUpdating,
}: {
  node: NodeInfo | undefined;
  displayStakedUsd: number;
  onClose: () => void;
  onClaim: (nodeId: string, nodeName: string) => void;
  onDeregister: (nodeId: string, nodeName: string) => void;
  onUpdatePerformance: (nodeId: string, nodeName: string) => void;
  isClaiming: boolean;
  isDeregistering: boolean;
  isUpdating: boolean;
}) {
  const publicClient = usePublicClient();
  const {
    increaseNodeStake,
    updateNodeConfig,
    updateNodeServices,
    updateNodeMetadataURI,
    isMutatingNode,
    gasless,
  } = useNodeManagement();

  const [stakeIncreaseInput, setStakeIncreaseInput] = useState("0");
  const [editRpcUrl, setEditRpcUrl] = useState(node?.rpcUrl ?? "");
  const [editRegion, setEditRegion] = useState<number>(
    node
      ? (REGION_TO_VALUE[node.region] ?? REGION_TO_VALUE.Global)
      : REGION_TO_VALUE.Global,
  );
  const [metadataUri, setMetadataUri] = useState("");
  const [selectedServices, setSelectedServices] = useState<NodeServiceId[]>([]);
  const [actionResult, setActionResult] =
    useState<TransactionStatusResult | null>(null);

  const servicesHash = useMemo(() => {
    if (selectedServices.length === 0) return null;
    const normalized = [...selectedServices].sort();
    return keccak256(toBytes(JSON.stringify(normalized)));
  }, [selectedServices]);

  useEffect(() => {
    if (!node) return;
    setEditRpcUrl(node.rpcUrl);
    setEditRegion(REGION_TO_VALUE[node.region] ?? REGION_TO_VALUE.Global);
  }, [node]);

  if (!node) return null;

  const hasPendingRewards = parseFloat(node.pendingRewards) > 0;
  const metadataPending = Boolean(node.metadataPending);
  const nodeName = node.nodeId.slice(0, 10);
  const normalizedOperator = node.operator?.toLowerCase();
  const normalizedOwner = gasless.ownerAddress?.toLowerCase();
  const normalizedSmartOwner = gasless.smartAccountAddress?.toLowerCase();
  const isSmartAccountOperator =
    Boolean(normalizedSmartOwner) &&
    normalizedOperator === normalizedSmartOwner;
  const canManageNode = Boolean(
    normalizedOperator &&
      (normalizedOperator === normalizedOwner || isSmartAccountOperator),
  );

  const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Unknown transaction failure";

  const runNodeMutation = async (params: {
    action: () => Promise<Hex>;
    submittedTitle: string;
    submittedMessage: string;
    successTitle: string;
    successMessage: string;
    errorTitle: string;
  }) => {
    try {
      const txHash = await params.action();
      setActionResult({
        status: "info",
        title: params.submittedTitle,
        message: params.submittedMessage,
        txHash,
        explorerUrl: EXPLORER_URL,
      });

      if (!publicClient) return;

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      if (receipt.status === "success") {
        setActionResult({
          status: "success",
          title: params.successTitle,
          message: params.successMessage,
          txHash,
          explorerUrl: EXPLORER_URL,
        });
        return;
      }

      setActionResult({
        status: "error",
        title: params.errorTitle,
        message: "Transaction reverted on-chain during confirmation.",
        txHash,
        explorerUrl: EXPLORER_URL,
      });
    } catch (error) {
      setActionResult({
        status: "error",
        title: params.errorTitle,
        message: getErrorMessage(error),
        explorerUrl: EXPLORER_URL,
      });
    }
  };

  const handleIncreaseStake = async () => {
    if (!canManageNode) {
      setActionResult({
        status: "error",
        title: "Increase stake failed",
        message: "Connected wallet does not match this node operator.",
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    let amount: bigint;
    try {
      amount = parseUnits(stakeIncreaseInput, 18);
    } catch {
      setActionResult({
        status: "error",
        title: "Increase stake failed",
        message: `Invalid amount: "${stakeIncreaseInput}".`,
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    if (amount <= 0n) {
      setActionResult({
        status: "error",
        title: "Increase stake failed",
        message: "Amount must be greater than zero.",
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    await runNodeMutation({
      action: () =>
        increaseNodeStake(
          node.nodeId as Hex,
          node.stakedToken as Address,
          amount,
          { gasless: isSmartAccountOperator },
        ),
      submittedTitle: "Stake increase submitted",
      submittedMessage: "Increasing node stake on-chain.",
      successTitle: "Stake increased",
      successMessage: "Node stake amount updated on-chain.",
      errorTitle: "Increase stake failed",
    });
  };

  const handleUpdateConfig = async () => {
    if (!canManageNode) {
      setActionResult({
        status: "error",
        title: "Config update failed",
        message: "Connected wallet does not match this node operator.",
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    if (!editRpcUrl.trim()) {
      setActionResult({
        status: "error",
        title: "Config update failed",
        message: "RPC URL is required.",
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    await runNodeMutation({
      action: () =>
        updateNodeConfig(node.nodeId as Hex, editRpcUrl.trim(), editRegion, {
          gasless: isSmartAccountOperator,
        }),
      submittedTitle: "Node config update submitted",
      submittedMessage: "Updating endpoint and region on-chain.",
      successTitle: "Node config updated",
      successMessage: "Node endpoint and region updated on-chain.",
      errorTitle: "Config update failed",
    });
  };

  const handleUpdateServices = async () => {
    if (!canManageNode) {
      setActionResult({
        status: "error",
        title: "Service update failed",
        message: "Connected wallet does not match this node operator.",
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    if (!servicesHash) {
      setActionResult({
        status: "error",
        title: "Service update failed",
        message: "Select at least one service before saving.",
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    await runNodeMutation({
      action: () =>
        updateNodeServices(node.nodeId as Hex, servicesHash, {
          gasless: isSmartAccountOperator,
        }),
      submittedTitle: "Service update submitted",
      submittedMessage: "Updating service hash on-chain.",
      successTitle: "Services updated",
      successMessage: "Node service hash updated on-chain.",
      errorTitle: "Service update failed",
    });
  };

  const handleUpdateMetadata = async () => {
    if (!canManageNode) {
      setActionResult({
        status: "error",
        title: "Metadata update failed",
        message: "Connected wallet does not match this node operator.",
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    if (!metadataUri.trim()) {
      setActionResult({
        status: "error",
        title: "Metadata update failed",
        message: "Metadata URI is required.",
        explorerUrl: EXPLORER_URL,
      });
      return;
    }

    await runNodeMutation({
      action: () =>
        updateNodeMetadataURI(node.nodeId as Hex, metadataUri.trim(), {
          gasless: isSmartAccountOperator,
        }),
      submittedTitle: "Metadata update submitted",
      submittedMessage: "Updating metadata URI pointer on-chain.",
      successTitle: "Metadata URI updated",
      successMessage: "Metadata URI pointer updated on-chain.",
      errorTitle: "Metadata update failed",
    });
  };

  return (
    <div
      className="card"
      style={{
        marginTop: "1.5rem",
        border: "1px solid var(--accent)",
        position: "relative",
      }}
    >
      <button
        type="button"
        onClick={onClose}
        style={{
          position: "absolute",
          top: "1rem",
          right: "1rem",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: "1.25rem",
        }}
      >
        ×
      </button>

      <div className="card-header">
        <h3 className="card-title">
          <Cpu size={18} /> Node Details
        </h3>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          gap: "1.5rem",
        }}
      >
        <div>
          <h4 style={{ marginBottom: "1rem", color: "var(--text-secondary)" }}>
            General
          </h4>
          <DetailRow label="Node ID" value={node.nodeId} mono />
          <DetailRow
            label="Protocol Version"
            value={formatNodeVersionLabel(node)}
          />
          <DetailRow label="Region" value={node.region} />
          <DetailRow
            label="Status"
            value={
              metadataPending
                ? "Metadata pending"
                : node.isActive
                  ? "Active"
                  : node.isSlashed
                    ? "Slashed"
                    : "Inactive"
            }
          />
          <DetailRow label="RPC URL" value={node.rpcUrl} mono small />
          <DetailRow
            label="Registered"
            value={
              metadataPending || node.registrationTime === 0
                ? "Pending metadata"
                : new Date(node.registrationTime * 1000).toLocaleDateString()
            }
          />
        </div>

        <div>
          <h4 style={{ marginBottom: "1rem", color: "var(--text-secondary)" }}>
            Staking
          </h4>
          <DetailRow
            label="Staked Amount"
            value={`${node.stakedAmount} tokens`}
          />
          <DetailRow
            label="Staked Value"
            value={`$${formatNumber(displayStakedUsd)}`}
          />
          <DetailRow label="Reward Token" value={node.rewardToken} mono small />
          <DetailRow
            label="Last Claim"
            value={
              metadataPending || node.lastClaimTime === 0
                ? "Pending metadata"
                : new Date(node.lastClaimTime * 1000).toLocaleDateString()
            }
          />
          <DetailRow
            label="Total Claimed"
            value={`$${formatNumber(node.totalRewardsClaimed)}`}
          />
        </div>

        <div>
          <h4 style={{ marginBottom: "1rem", color: "var(--text-secondary)" }}>
            Performance
          </h4>
          <DetailRow
            label="Uptime Score"
            value={`${(node.performance.uptimeScore / 100).toFixed(2)}%`}
          />
          <DetailRow
            label="Requests Served"
            value={formatNumber(node.performance.requestsServed.toString())}
          />
          <DetailRow
            label="Avg Response Time"
            value={`${node.performance.avgResponseTime}ms`}
          />
          <DetailRow
            label="Last Update"
            value={
              metadataPending || node.performance.lastUpdateTime === 0
                ? "Pending metadata"
                : new Date(
                    node.performance.lastUpdateTime * 1000,
                  ).toLocaleString()
            }
          />
          <DetailRow
            label="Pending Rewards"
            value={`$${formatNumber(node.pendingRewards)}`}
            highlight
          />
        </div>
      </div>

      <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.75rem" }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onClaim(node.nodeId, nodeName)}
          disabled={!hasPendingRewards || isClaiming || metadataPending}
        >
          {isClaiming ? (
            "Claiming..."
          ) : (
            <>
              <DollarSign size={16} /> Claim Rewards
            </>
          )}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onUpdatePerformance(node.nodeId, nodeName)}
          disabled={isUpdating || metadataPending}
        >
          {isUpdating ? (
            "Updating..."
          ) : (
            <>
              <RefreshCw size={16} /> Update Performance
            </>
          )}
        </button>
        {!node.isSlashed && !metadataPending && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ color: "var(--warning)" }}
            onClick={() => onDeregister(node.nodeId, nodeName)}
            disabled={isDeregistering}
          >
            {isDeregistering ? (
              "Deregistering..."
            ) : (
              <>
                <AlertTriangle size={16} /> Deregister Node
              </>
            )}
          </button>
        )}
      </div>

      <div
        style={{
          marginTop: "1rem",
          borderTop: "1px solid var(--border)",
          paddingTop: "1rem",
          display: "grid",
          gap: "0.9rem",
        }}
      >
        <h4 style={{ margin: 0, color: "var(--text-secondary)" }}>
          Manage Node
        </h4>

        {!canManageNode ? (
          <p
            style={{ margin: 0, color: "var(--warning)", fontSize: "0.85rem" }}
          >
            Connected wallet is not authorized to edit this node.
          </p>
        ) : null}

        <div style={{ display: "grid", gap: "0.5rem" }}>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Increase Stake (token units)
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input
              className="input"
              type="number"
              min="0"
              step="0.000001"
              value={stakeIncreaseInput}
              onChange={(event) => setStakeIncreaseInput(event.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={isMutatingNode || !canManageNode}
              onClick={handleIncreaseStake}
            >
              Increase Stake
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gap: "0.5rem" }}>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Endpoint / Region
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) 180px auto",
              gap: "0.5rem",
            }}
          >
            <input
              className="input"
              type="text"
              value={editRpcUrl}
              onChange={(event) => setEditRpcUrl(event.target.value)}
              placeholder="https://node.example.com/"
            />
            <select
              className="input"
              value={editRegion}
              onChange={(event) => setEditRegion(Number(event.target.value))}
            >
              {REGION_OPTIONS.map((regionOption) => (
                <option key={regionOption.value} value={regionOption.value}>
                  {regionOption.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={isMutatingNode || !canManageNode}
              onClick={handleUpdateConfig}
            >
              Save Config
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gap: "0.5rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              Services
            </div>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
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
                className="btn btn-secondary btn-sm"
                onClick={() => setSelectedServices([])}
              >
                Unpick all
              </button>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {NODE_SERVICE_DEFINITIONS.map((service) => {
              const selected = selectedServices.includes(service.id);
              return (
                <button
                  key={service.id}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{
                    borderColor: selected ? "var(--accent)" : undefined,
                    color: selected ? "var(--accent)" : undefined,
                  }}
                  onClick={() =>
                    setSelectedServices((current) =>
                      current.includes(service.id)
                        ? current.filter((value) => value !== service.id)
                        : [...current, service.id],
                    )
                  }
                >
                  {service.id}
                </button>
              );
            })}
          </div>

          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--text-muted)",
              wordBreak: "break-all",
            }}
          >
            New hash: {servicesHash ?? "not set"}
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            disabled={isMutatingNode || !canManageNode || !servicesHash}
            onClick={handleUpdateServices}
          >
            Save Services
          </button>
        </div>

        <div style={{ display: "grid", gap: "0.5rem" }}>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Metadata URI
          </div>
          <input
            className="input"
            type="text"
            value={metadataUri}
            onChange={(event) => setMetadataUri(event.target.value)}
            placeholder="ipfs://... or https://..."
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={isMutatingNode || !canManageNode}
            onClick={handleUpdateMetadata}
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
  );
}

function DetailRow({
  label,
  value,
  mono,
  small,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  highlight?: boolean;
}) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? "var(--font-mono)" : undefined,
          fontSize: small ? "0.8rem" : "0.9rem",
          color: highlight ? "var(--success)" : "var(--text)",
          fontWeight: highlight ? 600 : undefined,
          wordBreak: "break-all",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: EarningsHistoryItem }) {
  return (
    <tr>
      <td>
        <span
          className={`badge ${item.type === "claim" ? "badge-success" : "badge-info"}`}
        >
          {item.type === "claim" ? "Reward Claim" : "Node Registered"}
        </span>
      </td>
      <td style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
        {item.nodeId.slice(0, 10)}...
      </td>
      <td>
        {item.type === "claim"
          ? `$${formatNumber(item.amount ?? "0")}`
          : `$${formatNumber(item.stakedValueUSD ?? "0")} staked`}
      </td>
      <td style={{ fontFamily: "var(--font-mono)" }}>{item.blockNumber}</td>
      <td>
        <a
          href={`https://etherscan.io/tx/${item.transactionHash}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent)" }}
        >
          {item.transactionHash.slice(0, 10)}...
        </a>
      </td>
    </tr>
  );
}

// Utility functions

function formatNumber(value: string | number): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(num)) return "0";

  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(2)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(2)}K`;
  }
  return num.toFixed(2);
}
