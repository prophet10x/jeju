import { useEffect, useState } from 'react'
import {
  TransactionStatusModal,
  type TransactionStatusResult,
} from './TransactionStatusModal'

export interface WalletInfoCard {
  label: string
  address?: string | null
  jejuBalance?: string | null
  ethBalance?: string | null
  jejuCredit?: string | null
  paymasterAllowance?: string | null
}

export type WalletMoveResult = TransactionStatusResult

export interface WalletManagementMenuProps {
  connectedLabel: string
  ownerWallet: WalletInfoCard
  smartWallet: WalletInfoCard
  smartAccountError?: string | null
  movePending?: boolean
  moveDisabledReason?: string | null
  moveStatusMessage?: string | null
  moveErrorMessage?: string | null
  moveResult?: WalletMoveResult | null
  onDismissMoveResult?: () => void
  onMoveAllToSmart?: () => void | Promise<void>
  onMoveCustomToSmart?: (amount: string) => void | Promise<void>
  onDisconnect: () => void | Promise<void>
}

function truncateAddress(address?: string | null) {
  if (!address) return 'Unavailable'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function CopyButton({ value }: { value?: string | null }) {
  return (
    <button
      type="button"
      disabled={!value}
      onClick={async () => {
        if (!value) return
        await navigator.clipboard.writeText(value)
      }}
      style={{
        padding: '0.35rem 0.6rem',
        borderRadius: '8px',
        border: '1px solid var(--border, #374151)',
        background: 'var(--surface-hover, rgba(255,255,255,0.04))',
        color: 'var(--text-secondary, #cbd5e1)',
        fontSize: '0.75rem',
        cursor: value ? 'pointer' : 'not-allowed',
      }}
    >
      Copy
    </button>
  )
}

function WalletCard({ info }: { info: WalletInfoCard }) {
  return (
    <div
      style={{
        border: '1px solid var(--border, #374151)',
        borderRadius: '12px',
        padding: '0.9rem',
        display: 'grid',
        gap: '0.55rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
        }}
      >
        <div>
          <div
            style={{
              color: 'var(--text-secondary, #94a3b8)',
              fontSize: '0.75rem',
              marginBottom: '0.2rem',
            }}
          >
            {info.label}
          </div>
          <div
            style={{
              color: 'var(--text-primary, #f8fafc)',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
            }}
          >
            {truncateAddress(info.address)}
          </div>
        </div>
        <CopyButton value={info.address} />
      </div>

      <div
        style={{
          display: 'grid',
          gap: '0.35rem',
          fontSize: '0.8rem',
          color: 'var(--text-secondary, #cbd5e1)',
        }}
      >
        <div>
          <strong style={{ color: 'var(--text-primary, #f8fafc)' }}>JEJU:</strong>{' '}
          {info.jejuBalance ?? '0'}
        </div>
        <div>
          <strong style={{ color: 'var(--text-primary, #f8fafc)' }}>ETH:</strong>{' '}
          {info.ethBalance ?? '0'}
        </div>
        {info.jejuCredit !== undefined && (
          <div>
            <strong style={{ color: 'var(--text-primary, #f8fafc)' }}>
              JEJU credit:
            </strong>{' '}
            {info.jejuCredit ?? '0'}
          </div>
        )}
        {info.paymasterAllowance !== undefined && (
          <div>
            <strong style={{ color: 'var(--text-primary, #f8fafc)' }}>
              Paymaster allowance:
            </strong>{' '}
            {info.paymasterAllowance ?? '0'}
          </div>
        )}
      </div>
    </div>
  )
}

export function WalletManagementMenu({
  connectedLabel,
  ownerWallet,
  smartWallet,
  smartAccountError,
  movePending = false,
  moveDisabledReason,
  moveStatusMessage,
  moveErrorMessage,
  moveResult,
  onDismissMoveResult,
  onMoveAllToSmart,
  onMoveCustomToSmart,
  onDisconnect,
}: WalletManagementMenuProps) {
  const [open, setOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')

  useEffect(() => {
    if (!open) return
    const onClick = () => setOpen(false)
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [open])

  return (
    <>
      <div
        style={{ position: 'relative', display: 'inline-block' }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.55rem 0.85rem',
            borderRadius: '10px',
            border: '1px solid var(--border, #374151)',
            background: 'var(--surface-hover, rgba(255,255,255,0.04))',
            color: 'var(--text-primary, #f8fafc)',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '999px',
              background: '#22c55e',
            }}
          />
          <span style={{ fontFamily: 'monospace', fontSize: '0.875rem' }}>
            {connectedLabel}
          </span>
        </button>

        {open && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 10px)',
              right: 0,
              width: 'min(420px, 92vw)',
              borderRadius: '16px',
              border: '1px solid var(--border, #374151)',
              background: 'var(--surface, #111827)',
              boxShadow: '0 22px 50px rgba(0,0,0,0.35)',
              padding: '1rem',
              zIndex: 1000,
              display: 'grid',
              gap: '0.85rem',
            }}
          >
          <WalletCard info={ownerWallet} />
          <WalletCard info={smartWallet} />

          {smartAccountError ? (
            <div
              style={{
                color: '#fca5a5',
                fontSize: '0.8rem',
                padding: '0.75rem',
                borderRadius: '10px',
                background: 'rgba(127, 29, 29, 0.25)',
              }}
            >
              {smartAccountError}
            </div>
          ) : null}

          <div
            style={{
              border: '1px solid var(--border, #374151)',
              borderRadius: '12px',
              padding: '0.9rem',
              display: 'grid',
              gap: '0.6rem',
            }}
          >
            <div
              style={{
                color: 'var(--text-primary, #f8fafc)',
                fontSize: '0.85rem',
                fontWeight: 600,
              }}
            >
              Move JEJU to SimpleAccount
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '0.5rem',
              }}
            >
              <input
                value={customAmount}
                onChange={(event) => setCustomAmount(event.target.value)}
                placeholder="Custom JEJU amount"
                style={{
                  minWidth: 0,
                  padding: '0.7rem 0.8rem',
                  borderRadius: '10px',
                  border: '1px solid var(--border, #374151)',
                  background: 'var(--surface-hover, rgba(255,255,255,0.04))',
                  color: 'var(--text-primary, #f8fafc)',
                }}
              />
              <button
                type="button"
                disabled={movePending || Boolean(moveDisabledReason) || !customAmount}
                onClick={() => onMoveCustomToSmart?.(customAmount)}
                style={{
                  padding: '0.7rem 0.9rem',
                  borderRadius: '10px',
                  border: 'none',
                  background:
                    movePending || moveDisabledReason || !customAmount
                      ? 'rgba(148, 163, 184, 0.2)'
                      : 'var(--primary, #2563eb)',
                  color: 'white',
                  cursor:
                    movePending || moveDisabledReason || !customAmount
                      ? 'not-allowed'
                      : 'pointer',
                }}
              >
                {movePending ? 'Moving...' : 'Move'}
              </button>
            </div>
            <button
              type="button"
              disabled={movePending || Boolean(moveDisabledReason)}
              onClick={() => onMoveAllToSmart?.()}
              style={{
                padding: '0.7rem 0.9rem',
                borderRadius: '10px',
                border: '1px solid var(--border, #374151)',
                background: 'var(--surface-hover, rgba(255,255,255,0.04))',
                color: 'var(--text-primary, #f8fafc)',
                cursor:
                  movePending || moveDisabledReason ? 'not-allowed' : 'pointer',
              }}
            >
              Move all JEJU
            </button>
            {moveDisabledReason ? (
              <div style={{ color: '#fca5a5', fontSize: '0.8rem' }}>
                {moveDisabledReason}
              </div>
            ) : (
              <div
                style={{ color: 'var(--text-secondary, #94a3b8)', fontSize: '0.8rem' }}
              >
                Use this if JEJU lands in the EOA instead of the gasless wallet.
              </div>
            )}
            {moveStatusMessage ? (
              <div
                style={{
                  color: '#86efac',
                  fontSize: '0.8rem',
                }}
              >
                {moveStatusMessage}
              </div>
            ) : null}
            {moveErrorMessage ? (
              <div
                style={{
                  color: '#fca5a5',
                  fontSize: '0.8rem',
                }}
              >
                {moveErrorMessage}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => onDisconnect()}
            style={{
              padding: '0.8rem 1rem',
              borderRadius: '10px',
              border: '1px solid rgba(248, 113, 113, 0.35)',
              background: 'rgba(127, 29, 29, 0.2)',
              color: '#fca5a5',
              cursor: 'pointer',
            }}
          >
            Disconnect
          </button>
          </div>
        )}
      </div>

      {moveResult && onDismissMoveResult ? (
        <TransactionStatusModal result={moveResult} onClose={onDismissMoveResult} />
      ) : null}
    </>
  )
}
