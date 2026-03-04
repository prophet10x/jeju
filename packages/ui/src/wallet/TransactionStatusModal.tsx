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
  const statusColor =
    result.status === 'error'
      ? '#fca5a5'
      : result.status === 'success'
        ? '#86efac'
        : '#bfdbfe'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 2000,
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close transaction status"
        style={{
          position: 'absolute',
          inset: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        style={{
          width: 'min(440px, 100%)',
          borderRadius: '16px',
          border: `1px solid ${statusColor}`,
          background:
            'linear-gradient(180deg, rgba(15,23,42,0.98) 0%, rgba(2,6,23,0.98) 100%)',
          boxShadow: '0 26px 60px rgba(2,6,23,0.6)',
          padding: '1.1rem',
          display: 'grid',
          gap: '0.9rem',
          position: 'relative',
        }}
      >
        <div
          style={{
            color: statusColor,
            fontWeight: 700,
            fontSize: '1rem',
            letterSpacing: '0.01em',
          }}
        >
          {result.title}
        </div>
        <div
          style={{
            color: 'var(--text-secondary, #e2e8f0)',
            fontSize: '0.9rem',
            lineHeight: 1.5,
          }}
        >
          {result.message}
        </div>
        {result.txHash ? (
          <div
            style={{
              color: 'var(--text-primary, #f8fafc)',
              fontFamily: 'monospace',
              fontSize: '0.82rem',
              wordBreak: 'break-all',
              background: 'rgba(15, 23, 42, 0.92)',
              border: '1px solid rgba(148, 163, 184, 0.45)',
              borderRadius: '10px',
              padding: '0.65rem 0.75rem',
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
              color: '#7dd3fc',
              fontSize: '0.87rem',
              fontWeight: 600,
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
            border: '1px solid rgba(148, 163, 184, 0.55)',
            background: 'rgba(148, 163, 184, 0.16)',
            color: 'var(--text-primary, #f8fafc)',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Close
        </button>
      </div>
    </div>
  )
}
