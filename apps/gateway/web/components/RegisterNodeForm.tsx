import {
  calculateUsdValue as calculateUSDValue,
  formatTokenUsd as formatUSD,
  parseTokenAmount,
} from '@jejunetwork/shared'
import { useMemo, useState } from 'react'
import { formatUnits, parseEther } from 'viem'
import {
  calculateMonthlyRewardEstimate,
  REGION_NAMES,
  Region,
} from '../../lib/nodeStaking'
import { CONTRACTS } from '../../lib/config'
import { useGaslessBootstrap } from '../hooks/useGaslessBootstrap'
import { useNodeStaking } from '../hooks/useNodeStaking'
import { useProtocolTokens } from '../hooks/useProtocolTokens'
import type { TokenOption } from './TokenSelector'
import TokenSelector from './TokenSelector'

export default function RegisterNodeForm() {
  const { tokens } = useProtocolTokens()
  const {
    registerNode,
    isRegistering,
    isRegisterSuccess,
    operatorStats,
    gasless,
  } = useNodeStaking()
  const gaslessBootstrap = useGaslessBootstrap({ gasless })

  const [stakingToken, setStakingToken] = useState<TokenOption | null>(null)
  const [stakeAmount, setStakeAmount] = useState('')
  const [rewardToken, setRewardToken] = useState<TokenOption | null>(null)
  const [rpcUrl, setRpcUrl] = useState('')
  const [region, setRegion] = useState<Region>(Region.NorthAmerica)
  const [operatorAgentId, setOperatorAgentId] = useState('')
  const [useGasless, setUseGasless] = useState(true)

  const tokenOptions = tokens.map((t) => ({
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    priceUSD: t.priceUSD,
    logoUrl: t.logoUrl,
  }))

  const stakeValueUSD = useMemo(() => {
    if (!stakingToken || !stakeAmount) return 0
    const amount = parseTokenAmount(stakeAmount, stakingToken.decimals)
    return calculateUSDValue(
      amount,
      stakingToken.decimals,
      stakingToken.priceUSD,
    )
  }, [stakingToken, stakeAmount])

  const parsedStakeAmount = useMemo(() => {
    if (!stakingToken || !stakeAmount) return 0n
    return parseTokenAmount(stakeAmount, stakingToken.decimals)
  }, [stakingToken, stakeAmount])

  const estimatedMonthlyUSD = useMemo(() => {
    if (!rewardToken) return 0n
    const baseReward = parseEther('100') // $100 base
    return calculateMonthlyRewardEstimate(
      baseReward,
      10000n,
      region,
      region === Region.Africa || region === Region.SouthAmerica,
    )
  }, [rewardToken, region])

  const minStakeUSD = 1000
  const parsedOperatorAgentId = useMemo(() => {
    const trimmed = operatorAgentId.trim()
    if (!trimmed) return undefined

    try {
      return BigInt(trimmed)
    } catch {
      return null
    }
  }, [operatorAgentId])

  const isValid =
    stakeValueUSD >= minStakeUSD &&
    rpcUrl.startsWith('http') &&
    stakingToken &&
    rewardToken &&
    parsedOperatorAgentId !== null

  const gaslessSupportsSelectedToken =
    !stakingToken ||
    stakingToken.address.toLowerCase() === CONTRACTS.jeju.toLowerCase()

  const gaslessReadiness = gasless.getReadiness(parsedStakeAmount)

  const currentNodes = Number(operatorStats?.totalNodesActive ?? 0n)
  const maxNodes = 5
  const canAddMore = currentNodes < maxNodes

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stakingToken || !rewardToken) return
    if (useGasless && !gaslessSupportsSelectedToken) return
    if (useGasless && gasless.smartAccountDerivationError) return
    if (useGasless && !gaslessReadiness.isReady) return

    await registerNode(
      stakingToken.address as `0x${string}`,
      parsedStakeAmount,
      rewardToken.address as `0x${string}`,
      rpcUrl,
      region,
      parsedOperatorAgentId ?? undefined,
      { gasless: useGasless },
    )
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>
        Register New Node
      </h2>

      {!canAddMore && (
        <div
          style={{
            padding: '1rem',
            background: 'var(--error-soft)',
            borderRadius: '8px',
            marginBottom: '1rem',
          }}
        >
          <p style={{ color: 'var(--error)', margin: 0 }}>
            ⚠️ You've reached the maximum of {maxNodes} nodes per operator.
            Deregister a node before adding more.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div
          style={{
            padding: '1rem',
            background: 'var(--surface-hover)',
            borderRadius: '8px',
            marginBottom: '1.5rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '1rem',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>
                JEJU gasless node registration
              </p>
              <p
                style={{
                  margin: '0.25rem 0 0 0',
                  fontSize: '0.875rem',
                  color: 'var(--text-secondary)',
                }}
              >
                The first pass uses JEJU on your SimpleAccount for both gas and
                stake.
              </p>
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontWeight: 600,
              }}
            >
              <input
                type="checkbox"
                checked={useGasless}
                onChange={(e) => setUseGasless(e.target.checked)}
              />
              Use JEJU gasless flow
            </label>
          </div>

          <div
            style={{
              marginTop: '1rem',
              fontSize: '0.875rem',
              display: 'grid',
              gap: '0.5rem',
            }}
          >
            <div>
              <strong>Smart account:</strong>{' '}
              {gasless.isLoadingSmartAccount
                ? 'Deriving...'
                : gasless.smartAccountAddress ?? 'Unavailable'}
            </div>
            {gasless.smartAccountDerivationError && (
              <div style={{ color: 'var(--error)' }}>
                <strong>Derivation error:</strong>{' '}
                {gasless.smartAccountDerivationError}
              </div>
            )}
            <div>
              <strong>JEJU balance:</strong>{' '}
              {gasless.smartAccountJejuBalance !== undefined
                ? `${formatUnits(gasless.smartAccountJejuBalance, 18)} JEJU`
                : 'Loading...'}
            </div>
            <div>
              <strong>JEJU credit:</strong>{' '}
              {gasless.smartAccountJejuCredit !== undefined
                ? `${formatUnits(gasless.smartAccountJejuCredit, 18)} JEJU`
                : 'Loading...'}
            </div>
            <div>
              <strong>Paymaster allowance:</strong>{' '}
              {gasless.smartAccountPaymasterAllowance !== undefined
                ? `${formatUnits(gasless.smartAccountPaymasterAllowance, 18)} JEJU`
                : 'Loading...'}
            </div>
            {useGasless && !gaslessSupportsSelectedToken && (
              <p style={{ margin: 0, color: 'var(--warning)' }}>
                Gasless node registration currently supports JEJU staking only.
              </p>
            )}
            {useGasless && gaslessSupportsSelectedToken && (
              <div
                style={{
                  marginTop: '0.25rem',
                  padding: '0.75rem',
                  borderRadius: '8px',
                  background: gaslessReadiness.isReady
                    ? 'var(--success-soft)'
                    : 'var(--warning-soft)',
                  border: `1px solid ${
                    gaslessReadiness.isReady
                      ? 'var(--success)'
                      : 'var(--warning)'
                  }`,
                }}
              >
                {gaslessReadiness.isReady ? (
                  <p style={{ margin: 0, color: 'var(--success)' }}>
                    Ready for JEJU gasless node registration via{' '}
                    {gaslessReadiness.readyViaCredit
                      ? 'existing credit'
                      : 'existing paymaster allowance'}
                    .
                  </p>
                ) : (
                  <div style={{ color: 'var(--warning)' }}>
                    <p style={{ margin: 0 }}>
                      Prepare this smart account with enough JEJU for the node
                      stake plus JEJU credit before using the gasless path.
                    </p>
                    <p style={{ margin: '0.5rem 0 0 0' }}>
                      Recommended JEJU on smart account:{' '}
                      {formatUnits(
                        gaslessReadiness.recommendedJejuBalance,
                        18,
                      )}{' '}
                      JEJU
                    </p>
                    <button
                      type="button"
                      className="button"
                      style={{ marginTop: '0.75rem' }}
                      disabled={
                        gaslessBootstrap.isBootstrapping ||
                        !gasless.smartAccountAddress ||
                        !!gasless.smartAccountDerivationError
                      }
                      onClick={async () => {
                        try {
                          await gaslessBootstrap.bootstrap({
                            purpose: 'node',
                            requiredStakeAmount: parsedStakeAmount,
                          })
                        } catch {
                          // bootstrapError is rendered below
                        }
                      }}
                    >
                      {gaslessBootstrap.isBootstrapping
                        ? 'Preparing Smart Account...'
                        : 'Prepare Smart Account'}
                    </button>
                    {gaslessBootstrap.bootstrapError && (
                      <p
                        style={{
                          margin: '0.5rem 0 0 0',
                          color: 'var(--error)',
                        }}
                      >
                        {gaslessBootstrap.bootstrapError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <TokenSelector
            tokens={tokenOptions}
            selectedToken={stakingToken?.symbol}
            onSelect={setStakingToken}
            label="Staking Token (what you'll lock up)"
            placeholder="Choose token to stake..."
            showBalances={true}
            disabled={isRegistering || !canAddMore}
          />
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label
            htmlFor="stake-amount"
            style={{
              display: 'block',
              marginBottom: '0.5rem',
              fontWeight: '600',
            }}
          >
            Amount to Stake
          </label>
          <input
            id="stake-amount"
            className="input"
            type="number"
            step="any"
            placeholder="Amount"
            value={stakeAmount}
            onChange={(e) => setStakeAmount(e.target.value)}
            disabled={isRegistering || !stakingToken || !canAddMore}
          />
          {stakingToken && stakeAmount && (
            <div style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
              {stakeValueUSD >= minStakeUSD ? (
                <span style={{ color: 'var(--success)' }}>
                  ✅ {formatUSD(stakeValueUSD)} (meets $
                  {minStakeUSD.toLocaleString()} minimum)
                </span>
              ) : (
                <span style={{ color: 'var(--error)' }}>
                  ❌ {formatUSD(stakeValueUSD)} (need $
                  {minStakeUSD.toLocaleString()} minimum)
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <TokenSelector
            tokens={tokenOptions}
            selectedToken={rewardToken?.symbol}
            onSelect={setRewardToken}
            label="Reward Token (what you want to earn - can be different!)"
            placeholder="Choose reward token..."
            showBalances={false}
            disabled={isRegistering || !canAddMore}
          />
          {rewardToken && (
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginTop: '0.5rem',
              }}
            >
              Estimated: ~
              {(
                Number(estimatedMonthlyUSD) /
                1e18 /
                rewardToken.priceUSD
              ).toFixed(2)}{' '}
              {rewardToken.symbol}/month (≈{' '}
              {formatUSD(Number(estimatedMonthlyUSD) / 1e18)}/month)
            </p>
          )}
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label
            htmlFor="operator-agent-id"
            style={{
              display: 'block',
              marginBottom: '0.5rem',
              fontWeight: '600',
            }}
          >
            Operator Agent ID{' '}
            <span style={{ color: 'var(--text-secondary)', fontWeight: '400' }}>
              (recommended)
            </span>
          </label>
          <input
            id="operator-agent-id"
            className="input"
            type="number"
            min="1"
            step="1"
            placeholder="ERC-8004 agent ID"
            value={operatorAgentId}
            onChange={(e) => setOperatorAgentId(e.target.value)}
            disabled={isRegistering || !canAddMore}
          />
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              marginTop: '0.25rem',
            }}
          >
            Links this node stake to an ERC-8004 operator identity instead of
            leaving it as a wallet-only registration.
          </p>
          {parsedOperatorAgentId === null && (
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--error)',
                marginTop: '0.25rem',
              }}
            >
              Enter a whole-number ERC-8004 agent ID or leave this blank.
            </p>
          )}
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label
            htmlFor="rpc-url"
            style={{
              display: 'block',
              marginBottom: '0.5rem',
              fontWeight: '600',
            }}
          >
            RPC URL
          </label>
          <input
            id="rpc-url"
            className="input"
            type="url"
            placeholder="https://your-node-ip:8545"
            value={rpcUrl}
            onChange={(e) => setRpcUrl(e.target.value)}
            disabled={isRegistering || !canAddMore}
          />
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              marginTop: '0.25rem',
            }}
          >
            Your node's publicly accessible RPC endpoint
          </p>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label
            htmlFor="region"
            style={{
              display: 'block',
              marginBottom: '0.5rem',
              fontWeight: '600',
            }}
          >
            Geographic Region
          </label>
          <select
            id="region"
            className="input"
            value={region}
            onChange={(e) => setRegion(Number(e.target.value) as Region)}
            disabled={isRegistering || !canAddMore}
          >
            {Object.entries(REGION_NAMES).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
                {(value === String(Region.Africa) ||
                  value === String(Region.SouthAmerica)) &&
                  ' (+50% bonus)'}
              </option>
            ))}
          </select>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              marginTop: '0.25rem',
            }}
          >
            Underserved regions earn geographic bonuses
          </p>
        </div>

        <div
          style={{
            padding: '1rem',
            background: 'var(--surface-hover)',
            borderRadius: '8px',
            marginBottom: '1rem',
          }}
        >
          <p style={{ fontSize: '0.875rem', margin: '0.5rem 0' }}>
            <strong>⏱️ Minimum staking period:</strong> 7 days
          </p>
          <p style={{ fontSize: '0.875rem', margin: '0.5rem 0' }}>
            <strong>🎯 Performance requirement:</strong> 99%+ uptime for full
            rewards
          </p>
          <p style={{ fontSize: '0.875rem', margin: '0.5rem 0' }}>
            <strong>💰 Paymaster fees:</strong> 7% of rewards go to paymasters
            (in ETH)
          </p>
        </div>

        {isRegisterSuccess && (
          <div
            style={{
              padding: '1rem',
              background: 'var(--success-soft)',
              borderRadius: '8px',
              marginBottom: '1rem',
            }}
          >
            <p style={{ color: 'var(--success)', margin: 0 }}>
              ✅ Node registered successfully! Check "My Nodes" to see details.
            </p>
          </div>
        )}

        <button
          type="submit"
          className="button"
          style={{ width: '100%' }}
          disabled={
            !isValid ||
            isRegistering ||
            !canAddMore ||
            (useGasless &&
              (!gaslessSupportsSelectedToken ||
                !gaslessReadiness.isReady ||
                !!gasless.smartAccountDerivationError))
          }
        >
          {isRegistering
            ? 'Staking & Registering...'
            : useGasless
              ? 'Stake & Register Node (JEJU gasless)'
              : 'Stake & Register Node'}
        </button>
      </form>
    </div>
  )
}
