import { formatUnits } from 'viem'
import { AlertCircle, CheckCircle, Info, type LucideProps } from 'lucide-react'
import { type ComponentType, useState } from 'react'
import { useAccount } from 'wagmi'
import { z } from 'zod'
import {
  StakeTier,
  type StakeTierValue,
  useRegistry,
  useStakeAmount,
} from '../hooks/useRegistry'
import { useGaslessBootstrap } from '../hooks/useGaslessBootstrap'
import { CONTRACTS } from '../../lib/config'

const InfoIcon = Info as ComponentType<LucideProps>
const AlertCircleIcon = AlertCircle as ComponentType<LucideProps>
const CheckCircleIcon = CheckCircle as ComponentType<LucideProps>

// JEJU token address from centralized config (network-aware)
const JEJU_TOKEN = CONTRACTS.jeju

const TIER_OPTIONS = [
  {
    value: StakeTier.NONE,
    label: 'Free',
    description: 'No stake required',
  },
  {
    value: StakeTier.SMALL,
    label: 'Small',
    description: '1 JEJU',
  },
  {
    value: StakeTier.MEDIUM,
    label: 'Medium',
    description: '10 JEJU',
  },
  {
    value: StakeTier.HIGH,
    label: 'High',
    description: '100 JEJU',
  },
] as const

// Zod schema for registration form validation
const RegistrationFormSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or less')
    .regex(
      /^[\w\s\-_.]+$/,
      'Name can only contain letters, numbers, spaces, hyphens, underscores, and periods',
    ),
  description: z
    .string()
    .max(500, 'Description must be 500 characters or less')
    .optional()
    .default(''),
  a2aEndpoint: z
    .string()
    .url('Must be a valid URL')
    .or(z.literal(''))
    .optional()
    .default(''),
  tags: z.array(z.string()).min(1, 'Please select at least one category'),
})

const AVAILABLE_TAGS = [
  { value: 'developer', label: 'Developer', icon: '👨‍💻' },
  { value: 'agent', label: 'AI Agent', icon: '🤖' },
  { value: 'app', label: 'Application', icon: '📱' },
  { value: 'game', label: 'Game', icon: '🎮' },
  { value: 'marketplace', label: 'Marketplace', icon: '🏪' },
  { value: 'defi', label: 'DeFi', icon: '💰' },
  { value: 'social', label: 'Social', icon: '💬' },
  { value: 'info-provider', label: 'Information Provider', icon: '📊' },
  { value: 'service', label: 'Service', icon: '⚙️' },
]

export default function RegisterAppForm() {
  const { address } = useAccount()
  const { registerApp, gasless } = useRegistry()
  const gaslessBootstrap = useGaslessBootstrap({ gasless })

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [a2aEndpoint, setA2aEndpoint] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [selectedTier, setSelectedTier] = useState<StakeTierValue>(
    StakeTier.NONE,
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [useGasless, setUseGasless] = useState(true)

  const stakeAmount = useStakeAmount(selectedTier)
  const gaslessReadiness =
    selectedTier === StakeTier.NONE || stakeAmount !== undefined
      ? gasless.getReadiness(
          selectedTier === StakeTier.NONE ? 0n : (stakeAmount ?? 0n),
        )
      : null

  const handleTagToggle = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    if (!address) {
      setError('Please connect your wallet')
      return
    }

    // Validate form data with Zod
    const formData = {
      name: name.trim(),
      description: description.trim(),
      a2aEndpoint: a2aEndpoint.trim(),
      tags: selectedTags,
    }

    const validation = RegistrationFormSchema.safeParse(formData)
    if (!validation.success) {
      const firstError = validation.error.issues[0]
      setError(firstError.message)
      return
    }

    if (selectedTier !== StakeTier.NONE && stakeAmount === undefined) {
      setError('Unable to determine stake amount')
      return
    }

    if (useGasless && gasless.smartAccountDerivationError) {
      setError(gasless.smartAccountDerivationError)
      return
    }

    if (useGasless && gaslessReadiness && !gaslessReadiness.isReady) {
      setError(
        'Prepare your smart account first so it has enough JEJU and either paymaster allowance or JEJU credit.',
      )
      return
    }

    setIsSubmitting(true)

    try {
      const tokenURI = JSON.stringify({
        name: validation.data.name,
        description: validation.data.description,
        owner: address,
        registeredAt: new Date().toISOString(),
      })

      const result = await registerApp({
        tokenURI,
        a2aEndpoint: validation.data.a2aEndpoint,
        tier: selectedTier,
        stakeToken:
          selectedTier === StakeTier.NONE
            ? '0x0000000000000000000000000000000000000000'
            : JEJU_TOKEN,
        stakeAmount: stakeAmount ?? 0n,
      }, { gasless: useGasless })

      setIsSubmitting(false)

      if (result.success) {
        setSuccess(true)
        setName('')
        setDescription('')
        setA2aEndpoint('')
        setSelectedTags([])
        setSelectedTier(StakeTier.NONE)
      } else {
        setError(result.error ?? 'Registration failed')
      }
    } catch (err) {
      setIsSubmitting(false)
      setError(
        err instanceof Error ? err.message : 'Transaction failed',
      )
    }
  }

  return (
    <div>
      <div
        className="card"
        style={{
          marginBottom: '1rem',
          background: 'var(--primary-soft)',
          border: '1px solid var(--primary)',
        }}
      >
        <div
          style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}
        >
          <InfoIcon
            size={20}
            style={{ color: 'var(--primary)', flexShrink: 0, marginTop: '2px' }}
          />
          <div>
            <p
              style={{
                fontWeight: 600,
                color: 'var(--primary)',
                marginBottom: '0.25rem',
              }}
            >
              ERC-8004 Identity Registry
            </p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Register your identity to access the <strong>JEJU Faucet</strong>,
              participate in governance, and list your apps. Your stake is
              refundable when you unregister.
            </p>
          </div>
        </div>
      </div>

        <div className="card">
        <h2 style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>
          Register Identity
        </h2>

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
                JEJU gasless smart account
              </p>
              <p
                style={{
                  margin: '0.25rem 0 0 0',
                  fontSize: '0.875rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Stake and pay L2 gas from your SimpleAccount instead of your
                connected wallet.
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
              <strong>Owner wallet (EOA):</strong>{' '}
              {gasless.ownerAddress ?? 'Unavailable'}
            </div>
            <div>
              <strong>Gasless wallet (SimpleAccount):</strong>{' '}
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
              <strong>SimpleAccount balance:</strong>{' '}
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
            {gaslessReadiness && (
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
                    Ready for JEJU gasless registration via{' '}
                    {gaslessReadiness.preferredPath === 'allowance'
                      ? 'direct paymaster pull'
                      : 'existing credit'}
                    .
                  </p>
                ) : (
                  <div style={{ color: 'var(--warning)' }}>
                    <p style={{ margin: 0 }}>
                      Prepare this smart account with enough JEJU and either
                      paymaster allowance or JEJU credit before using the gasless path.
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
                          setError(null)
                          await gaslessBootstrap.bootstrap({
                            purpose: 'registry',
                            requiredStakeAmount:
                              selectedTier === StakeTier.NONE
                                ? 0n
                                : (stakeAmount ?? 0n),
                          })
                        } catch (err) {
                          setError(
                            err instanceof Error
                              ? err.message
                              : 'Failed to prepare smart account',
                          )
                        }
                      }}
                    >
                      {gaslessBootstrap.isBootstrapping
                        ? 'Preparing Smart Account...'
                        : 'Prepare Smart Account'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: '1rem',
              background: 'var(--error-soft)',
              border: '1px solid var(--error)',
              borderRadius: '8px',
              marginBottom: '1.5rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <AlertCircleIcon size={20} style={{ color: 'var(--error)' }} />
            <span style={{ color: 'var(--error)' }}>{error}</span>
          </div>
        )}

        {success && (
          <div
            style={{
              padding: '1rem',
              background: 'var(--success-soft)',
              border: '1px solid var(--success)',
              borderRadius: '8px',
              marginBottom: '1.5rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.5rem',
              }}
            >
              <CheckCircleIcon
                size={20}
                style={{
                  color: 'var(--success)',
                  flexShrink: 0,
                  marginTop: '2px',
                }}
              />
              <div>
                <span style={{ color: 'var(--success)', fontWeight: 600 }}>
                  Registration successful!
                </span>
                <p
                  style={{
                    fontSize: '0.875rem',
                    color: 'var(--text-secondary)',
                    marginTop: '0.25rem',
                  }}
                >
                  You can now claim from the JEJU Faucet and access all protocol
                  features.
                </p>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1.5rem' }}>
            <label htmlFor="app-name" className="input-label">
              Name <span style={{ color: 'var(--error)' }}>*</span>
            </label>
            <input
              id="app-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Agent / My App / My Name"
              className="input"
              required
            />
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                marginTop: '0.25rem',
              }}
            >
              This can be your name, your agent's name, or your app name
            </p>
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label htmlFor="app-description-display" className="input-label">
              Description{' '}
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  fontWeight: 'normal',
                }}
              >
                (optional)
              </span>
            </label>
            <textarea
              id="app-description-display"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What you're building or working on..."
              className="input"
              rows={2}
              style={{ resize: 'vertical' }}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label htmlFor="app-a2a-endpoint-display" className="input-label">
              A2A Endpoint URL
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  marginLeft: '0.5rem',
                }}
              >
                (Optional - for agent discovery)
              </span>
            </label>
            <input
              id="app-a2a-endpoint-display"
              type="url"
              value={a2aEndpoint}
              onChange={(e) => setA2aEndpoint(e.target.value)}
              placeholder="https://myapp.com/a2a"
              className="input"
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <span className="input-label">
              Category <span style={{ color: 'var(--error)' }}>*</span>
            </span>
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '0.75rem',
              }}
            >
              What best describes you? Select one or more.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {AVAILABLE_TAGS.map((tag) => (
                <button
                  key={tag.value}
                  type="button"
                  onClick={() => handleTagToggle(tag.value)}
                  className={`pill ${selectedTags.includes(tag.value) ? 'pill-active' : ''}`}
                >
                  {tag.icon} {tag.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <span className="input-label">Stake Tier</span>
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '0.75rem',
              }}
            >
              Higher tiers increase visibility and trust. Stake is paid in
              JEJU tokens and fully refundable.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {TIER_OPTIONS.map((tier) => (
                <button
                  key={tier.value}
                  type="button"
                  onClick={() => setSelectedTier(tier.value)}
                  className={`pill ${selectedTier === tier.value ? 'pill-active' : ''}`}
                  style={{ minWidth: '100px' }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{tier.label}</div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                      {tier.description}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {selectedTier !== StakeTier.NONE && stakeAmount !== undefined && (
            <div
              style={{
                padding: '1rem',
                background: 'var(--surface-hover)',
                border: '1px solid var(--border-strong)',
                borderRadius: '8px',
                marginBottom: '1.5rem',
              }}
            >
              <p
                style={{
                  fontSize: '0.875rem',
                  color: 'var(--text-secondary)',
                  marginBottom: '0.5rem',
                }}
              >
                Required Stake:
              </p>
              <p
                style={{
                  fontSize: '1.25rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                }}
              >
                {formatUnits(stakeAmount, 18)} JEJU
              </p>
            </div>
          )}

          <button
            type="submit"
            className="button"
            disabled={
              isSubmitting ||
              !name.trim() ||
              selectedTags.length === 0 ||
              (useGasless && Boolean(gaslessReadiness && !gaslessReadiness.isReady))
            }
            style={{
              width: '100%',
              padding: '1rem',
              fontSize: '1rem',
              fontWeight: 600,
            }}
          >
            {isSubmitting
              ? 'Registering...'
              : useGasless
                ? selectedTier === StakeTier.NONE
                  ? 'Register (JEJU gasless)'
                  : 'Register & Stake (JEJU gasless)'
                : selectedTier === StakeTier.NONE
                  ? 'Register (Free)'
                  : 'Register & Stake'}
          </button>
          <p
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              marginTop: '0.75rem',
              textAlign: 'center',
            }}
          >
            {selectedTier === StakeTier.NONE
              ? 'Free registration with no stake'
              : 'Your JEJU stake is fully refundable when you unregister'}
          </p>
        </form>
      </div>
    </div>
  )
}
