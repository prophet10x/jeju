import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { TOKENS } from '../config'
import {
  StakeTier,
  type StakeTierValue,
  useAgentRegistration,
  useStakeAmount,
} from '../hooks/useAgentRegistration'
import { useGaslessBootstrap } from '../hooks/useGaslessBootstrap'

const TIER_OPTIONS: Array<{
  value: StakeTierValue
  label: string
  description: string
}> = [
  { value: StakeTier.NONE, label: 'Free', description: 'No stake required' },
  { value: StakeTier.SMALL, label: 'Small', description: 'Low stake' },
  { value: StakeTier.MEDIUM, label: 'Medium', description: 'Mid stake' },
  { value: StakeTier.HIGH, label: 'High', description: 'High stake' },
]

const AVAILABLE_TAGS = [
  'agent',
  'developer',
  'service',
  'marketplace',
  'defi',
  'social',
  'infrastructure',
]

interface RegisterAgentFormProps {
  onRegistered?: () => void
}

export default function RegisterAgentForm({
  onRegistered,
}: RegisterAgentFormProps) {
  const { address } = useAccount()
  const { registerAgent, gasless } = useAgentRegistration()
  const gaslessBootstrap = useGaslessBootstrap({ gasless })

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [a2aEndpoint, setA2aEndpoint] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>(['agent'])
  const [selectedTier, setSelectedTier] = useState<StakeTierValue>(
    StakeTier.NONE,
  )
  const [useGasless, setUseGasless] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const stakeAmount = useStakeAmount(selectedTier)
  const gaslessReadiness =
    selectedTier === StakeTier.NONE || stakeAmount !== undefined
      ? gasless.getReadiness(
          selectedTier === StakeTier.NONE ? 0n : (stakeAmount ?? 0n),
        )
      : null

  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag)
        ? current.filter((candidate) => candidate !== tag)
        : [...current, tag],
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setSuccessMessage(null)

    if (!address) {
      setError('Connect your wallet first.')
      return
    }
    if (!name.trim()) {
      setError('Agent name is required.')
      return
    }
    if (selectedTags.length === 0) {
      setError('Pick at least one tag.')
      return
    }
    if (selectedTier !== StakeTier.NONE && stakeAmount === undefined) {
      setError('Unable to load stake amount for selected tier.')
      return
    }
    if (a2aEndpoint.trim().length > 0) {
      try {
        const parsed = new URL(a2aEndpoint.trim())
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          setError('A2A endpoint must start with http:// or https://.')
          return
        }
      } catch {
        setError('A2A endpoint must be a valid URL.')
        return
      }
    }
    if (useGasless && gasless.smartAccountDerivationError) {
      setError(gasless.smartAccountDerivationError)
      return
    }
    if (useGasless && gaslessReadiness && !gaslessReadiness.isReady) {
      setError('Prepare the smart account first so it can pay gasless fees.')
      return
    }

    setIsSubmitting(true)
    try {
      const tokenURI = JSON.stringify({
        name: name.trim(),
        description: description.trim(),
        owner: address,
        registeredAt: new Date().toISOString(),
      })

      const result = await registerAgent(
        {
          tokenURI,
          a2aEndpoint: a2aEndpoint.trim(),
          tier: selectedTier,
          stakeToken:
            selectedTier === StakeTier.NONE
              ? '0x0000000000000000000000000000000000000000'
              : TOKENS.jeju,
          stakeAmount:
            selectedTier === StakeTier.NONE ? 0n : (stakeAmount ?? 0n),
          tags: selectedTags,
          category: selectedTags[0],
          serviceType: a2aEndpoint.trim() ? 'agent' : 'app',
        },
        { gasless: useGasless },
      )

      if (!result.success) {
        setError(result.error ?? 'Registration failed')
        return
      }

      setSuccessMessage(
        result.agentId !== undefined
          ? `Agent #${result.agentId.toString()} registered successfully.`
          : 'Agent registered successfully.',
      )
      setName('')
      setDescription('')
      setA2aEndpoint('')
      setSelectedTags(['agent'])
      setSelectedTier(StakeTier.NONE)
      onRegistered?.()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="card" style={{ display: 'grid', gap: '1rem' }}>
      <div
        style={{
          padding: '0.85rem',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          display: 'flex',
          gap: '0.5rem',
          alignItems: 'flex-start',
        }}
      >
        <Info size={16} style={{ marginTop: '0.1rem' }} />
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          This is the same ERC-8004 registration flow used in Gateway, now
          available directly in DWS.
        </div>
      </div>

      <form onSubmit={submit} style={{ display: 'grid', gap: '0.9rem' }}>
        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span style={{ fontWeight: 600 }}>Name</span>
          <input
            className="form-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My Agent"
            disabled={isSubmitting}
          />
        </label>

        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span style={{ fontWeight: 600 }}>Description</span>
          <textarea
            className="form-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this agent does"
            rows={3}
            disabled={isSubmitting}
          />
        </label>

        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span style={{ fontWeight: 600 }}>A2A Endpoint (optional)</span>
          <input
            className="form-input"
            type="url"
            value={a2aEndpoint}
            onChange={(event) => setA2aEndpoint(event.target.value)}
            placeholder="https://..."
            disabled={isSubmitting}
          />
        </label>

        <div style={{ display: 'grid', gap: '0.35rem' }}>
          <span style={{ fontWeight: 600 }}>Tags</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {AVAILABLE_TAGS.map((tag) => {
              const active = selectedTags.includes(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  className={
                    active
                      ? 'btn btn-primary btn-sm'
                      : 'btn btn-secondary btn-sm'
                  }
                  onClick={() => toggleTag(tag)}
                  disabled={isSubmitting}
                >
                  {tag}
                </button>
              )
            })}
          </div>
        </div>

        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span style={{ fontWeight: 600 }}>Stake Tier</span>
          <select
            className="form-select"
            value={selectedTier}
            onChange={(event) =>
              setSelectedTier(Number(event.target.value) as StakeTierValue)
            }
            disabled={isSubmitting}
          >
            {TIER_OPTIONS.map((tier) => (
              <option key={tier.value} value={tier.value}>
                {tier.label} - {tier.description}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.9rem',
          }}
        >
          <input
            type="checkbox"
            checked={useGasless}
            onChange={(event) => setUseGasless(event.target.checked)}
            disabled={isSubmitting}
          />
          Use gasless transaction path
        </label>

        {useGasless && gaslessReadiness && !gaslessReadiness.isReady && (
          <div
            style={{
              padding: '0.75rem',
              borderRadius: 'var(--radius-md)',
              background: 'var(--warning-soft)',
            }}
          >
            <div style={{ marginBottom: '0.5rem' }}>
              Smart account needs preparation before gasless registration.
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() =>
                void gaslessBootstrap.prepareSmartAccount({
                  ownerAddress: address,
                  purpose: 'registry',
                  requiredStakeAmount:
                    selectedTier === StakeTier.NONE ? 0n : (stakeAmount ?? 0n),
                })
              }
              disabled={gaslessBootstrap.isPreparing || isSubmitting}
            >
              {gaslessBootstrap.isPreparing ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Preparing...
                </>
              ) : (
                'Prepare Smart Account'
              )}
            </button>
            {gaslessBootstrap.error && (
              <div style={{ marginTop: '0.5rem', color: 'var(--danger)' }}>
                {gaslessBootstrap.error}
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 size={16} className="animate-spin" /> Registering...
            </>
          ) : (
            'Register Agent'
          )}
        </button>
      </form>

      {error && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            padding: '0.75rem',
            borderRadius: 'var(--radius-md)',
            background: 'var(--error-soft)',
            color: 'var(--error)',
          }}
        >
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {successMessage && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            padding: '0.75rem',
            borderRadius: 'var(--radius-md)',
            background: 'var(--success-soft)',
            color: 'var(--success)',
          }}
        >
          <CheckCircle2 size={16} />
          {successMessage}
        </div>
      )}
    </div>
  )
}
