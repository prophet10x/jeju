export interface TransactionStatusResult {
  status: 'info' | 'success' | 'error'
  title: string
  message: string
  txHash?: string | null
  explorerUrl?: string | null
}

interface TransactionStatusModalProps {
  result: TransactionStatusResult
  onClose: () => void
}

export function TransactionStatusModal({
  result,
  onClose,
}: TransactionStatusModalProps) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 2000,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(440px, 100%)',
          borderRadius: '16px',
          border: '1px solid var(--border, #374151)',
          background: 'var(--surface, #111827)',
          boxShadow: '0 22px 50px rgba(0,0,0,0.45)',
          padding: '1rem',
          display: 'grid',
          gap: '0.8rem',
        }}
      >
        <div
          style={{
            color:
              result.status === 'error'
                ? '#fca5a5'
                : result.status === 'success'
                  ? '#86efac'
                  : '#bfdbfe',
            fontWeight: 700,
            fontSize: '1rem',
          }}
        >
          {result.title}
        </div>
        <div
          style={{
            color: 'var(--text-secondary, #cbd5e1)',
            fontSize: '0.9rem',
          }}
        >
          {result.message}
        </div>
        {result.txHash ? (
          <div
            style={{
              color: 'var(--text-primary, #f8fafc)',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              wordBreak: 'break-all',
            }}
          >
            Tx: {result.txHash}
          </div>
        ) : null}
        {result.txHash && result.explorerUrl ? (
          <a
            href={`${result.explorerUrl}/tx/${result.txHash}`}
            target="_blank"
            rel="noreferrer"
            style={{
              color: '#93c5fd',
              fontSize: '0.85rem',
              textDecoration: 'underline',
            }}
          >
            View on explorer
          </a>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          style={{
            justifySelf: 'end',
            padding: '0.7rem 1rem',
            borderRadius: '10px',
            border: '1px solid var(--border, #374151)',
            background: 'var(--surface-hover, rgba(255,255,255,0.04))',
            color: 'var(--text-primary, #f8fafc)',
            cursor: 'pointer',
          }}
        >
          Close
        </button>
      </div>
    </div>
  )
}
