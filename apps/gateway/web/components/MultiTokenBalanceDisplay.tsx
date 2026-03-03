import {
  calculateUsdValue as calculateUSDValue,
  formatTokenAmount,
  formatTokenUsd as formatUSD,
} from '@jejunetwork/shared'
import { Coins, type LucideProps, Star } from 'lucide-react'
import { type ComponentType, useMemo, useState } from 'react'
import { erc20Abi, formatEther, parseEther, type Address } from 'viem'
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from 'wagmi'
import { CONTRACTS } from '../../lib/config'
import { useGaslessSmartAccount } from '../hooks/useGaslessSmartAccount'
import { useProtocolTokens } from '../hooks/useProtocolTokens'
import { useTokenBalances } from '../hooks/useTokenBalances'

const CoinsIcon = Coins as ComponentType<LucideProps>
const StarIcon = Star as ComponentType<LucideProps>

export default function MultiTokenBalanceDisplay() {
  const { balances, isLoading } = useTokenBalances()
  const { tokens } = useProtocolTokens()
  const { address: connectedAddress } = useAccount()
  const publicClient = usePublicClient()
  const gasless = useGaslessSmartAccount()
  const { writeContractAsync } = useWriteContract()
  const [movePending, setMovePending] = useState(false)

  const ownerAddress = gasless.ownerAddress as Address | undefined

  const { data: ownerEthBalance, refetch: refetchOwnerEth } = useBalance({
    address: ownerAddress,
    query: { enabled: Boolean(ownerAddress) },
  })

  const { data: smartJejuBalance, refetch: refetchSmartJeju } = useReadContract({
    address: CONTRACTS.jeju,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: gasless.smartAccountAddress ? [gasless.smartAccountAddress] : undefined,
    query: { enabled: Boolean(gasless.smartAccountAddress) },
  })

  const sortedTokens = useMemo(() => {
    return [...tokens].sort((a, b) => {
      if (a.isPreferred && !b.isPreferred) return -1
      if (!a.isPreferred && b.isPreferred) return 1
      return 0
    })
  }, [tokens])

  if (isLoading) {
    return (
      <div className="card" style={{ padding: '2rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.75rem',
          }}
        >
          <div className="spinner spinner-sm" />
          <span style={{ color: 'var(--text-muted)' }}>
            Loading balances...
          </span>
        </div>
      </div>
    )
  }

  const totalUSD = tokens.reduce((sum, token) => {
    const balance = balances[token.symbol]
    if (!balance) return sum
    return sum + calculateUSDValue(balance, token.decimals, token.priceUSD)
  }, 0)

  const ownerJejuBalance = balances.JEJU ?? 0n
  const moveDisabledReason = !connectedAddress || !ownerAddress
    ? 'Connect the owner wallet first.'
    : connectedAddress.toLowerCase() !== ownerAddress.toLowerCase()
      ? 'Reconnect with the owner wallet to move JEJU.'
      : !gasless.smartAccountAddress
        ? 'SimpleAccount is not available yet.'
        : (ownerEthBalance?.value ?? 0n) === 0n
          ? 'This transfer needs L2 ETH on the EOA.'
          : ownerJejuBalance === 0n
            ? 'No JEJU is available on the EOA.'
            : null

  async function moveJejuToSmartAccount(amount: bigint) {
    if (!gasless.smartAccountAddress || amount <= 0n) return
    setMovePending(true)
    try {
      const hash = await writeContractAsync({
        address: CONTRACTS.jeju,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [gasless.smartAccountAddress, amount],
      })
      await publicClient?.waitForTransactionReceipt({ hash })
      await Promise.all([
        gasless.refreshState(),
        refetchOwnerEth(),
        refetchSmartJeju(),
      ])
    } finally {
      setMovePending(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1rem',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              background: 'var(--gradient-brand)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
            }}
          >
            <CoinsIcon size={20} />
          </div>
          <div>
            <h2
              style={{
                fontSize: '1.125rem',
                fontWeight: 700,
                margin: 0,
                color: 'var(--text-primary)',
              }}
            >
              Token Balances
            </h2>
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                margin: 0,
              }}
            >
              {tokens.length} tokens
            </p>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: 800,
              color: 'var(--accent-primary)',
            }}
          >
            {formatUSD(totalUSD)}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Total Value
          </div>
        </div>
      </div>

      <div
        style={{
          marginBottom: '1rem',
          padding: '0.9rem 1rem',
          borderRadius: '12px',
          background: 'var(--surface-hover)',
          border: '1px solid var(--border)',
          display: 'grid',
          gap: '0.5rem',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '1rem',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
              Move JEJU to gasless wallet
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              EOA: {formatTokenAmount(ownerJejuBalance, 18, 4)} JEJU
              {'  '}|{'  '}
              SimpleAccount: {formatTokenAmount((smartJejuBalance as bigint | undefined) ?? 0n, 18, 4)} JEJU
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={movePending || Boolean(moveDisabledReason) || ownerJejuBalance === 0n}
              onClick={() => moveJejuToSmartAccount(ownerJejuBalance)}
            >
              {movePending ? 'Moving...' : 'Move all JEJU'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={movePending || Boolean(moveDisabledReason)}
              onClick={() => moveJejuToSmartAccount(parseEther('100'))}
            >
              Move 100 JEJU
            </button>
          </div>
        </div>
        <div style={{ fontSize: '0.8rem', color: moveDisabledReason ? '#fca5a5' : 'var(--text-secondary)' }}>
          {moveDisabledReason ??
            'Use this when JEJU is in the EOA but gasless staking needs it in the SimpleAccount.'}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
          gap: '0.75rem',
        }}
      >
        {sortedTokens.map((token) => {
          const balance = balances[token.symbol] ?? 0n
          const usdValue = calculateUSDValue(
            balance,
            token.decimals,
            token.priceUSD,
          )
          const isPreferred = token.isPreferred

          return (
            <div
              key={token.symbol}
              className="stat-card"
              style={{
                textAlign: 'left',
                padding: '1rem',
                border: isPreferred
                  ? '2px solid var(--accent-primary)'
                  : undefined,
                position: 'relative',
              }}
            >
              {isPreferred && (
                <div
                  style={{
                    position: 'absolute',
                    top: '-8px',
                    right: '8px',
                    background: 'var(--accent-primary)',
                    color: 'white',
                    fontSize: '0.625rem',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2px',
                  }}
                >
                  <StarIcon size={10} fill="white" />
                  Preferred
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                }}
              >
                {token.logoUrl ? (
                  <img
                    src={token.logoUrl}
                    alt={token.symbol}
                    width={36}
                    height={36}
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '50%',
                      flexShrink: 0,
                    }}
                    onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                      e.currentTarget.style.display = 'none'
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '50%',
                      background: 'var(--gradient-brand)',
                      flexShrink: 0,
                    }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.25rem',
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: '0.9375rem',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {token.symbol}
                    </span>
                    <span
                      style={{
                        fontSize: '0.625rem',
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {formatUSD(token.priceUSD, token.priceUSD < 1 ? 4 : 2)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: '0.25rem',
                      gap: '0.25rem',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '1rem',
                        fontWeight: 700,
                        color: 'var(--accent-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {formatTokenAmount(balance, token.decimals, 2)}
                    </span>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-secondary)',
                        flexShrink: 0,
                      }}
                    >
                      ≈ {formatUSD(usdValue, 2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
