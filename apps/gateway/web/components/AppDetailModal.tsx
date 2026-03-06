import { AuthProvider, useJejuAuth, useOAuth3 } from '@jejunetwork/auth/react'
import {
  getConfiguredAddress,
  predictSimpleAccountAddress,
} from '@jejunetwork/shared/gasless'
import {
  Edit,
  ExternalLink,
  Github,
  Loader2,
  type LucideProps,
  Plus,
  Save,
  Trash2,
  Wallet,
  X,
} from 'lucide-react'
import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react'
import { type Address, getAddress, isAddress } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { CONTRACTS } from '../../lib/config'
import { useGaslessBootstrap } from '../hooks/useGaslessBootstrap'
import {
  IDENTITY_REGISTRY_ADDRESS,
  StakeTier,
  type StakeTierValue,
  useRegistry,
  useRegistryAppDetails,
  useStakeAmount,
} from '../hooks/useRegistry'
import GitHubReputationPanel from './GitHubReputationPanel'

const XIcon = X as ComponentType<LucideProps>
const ExternalLinkIcon = ExternalLink as ComponentType<LucideProps>
const Trash2Icon = Trash2 as ComponentType<LucideProps>
const EditIcon = Edit as ComponentType<LucideProps>
const SaveIcon = Save as ComponentType<LucideProps>
const PlusIcon = Plus as ComponentType<LucideProps>
const WalletIcon = Wallet as ComponentType<LucideProps>
const Loader2Icon = Loader2 as ComponentType<LucideProps>
const GithubIcon = Github as ComponentType<LucideProps>

const CATEGORY_LABELS: Record<string, string> = {
  developer: 'Developer',
  agent: 'AI Agent',
  app: 'Application',
  game: 'Game',
  marketplace: 'Marketplace',
  defi: 'DeFi',
  social: 'Social',
  'info-provider': 'Information Provider',
  service: 'Service',
  mcp: 'MCP',
}

const STAKE_TIER_OPTIONS: Array<{ value: StakeTierValue; label: string }> = [
  { value: StakeTier.SMALL, label: 'Small' },
  { value: StakeTier.MEDIUM, label: 'Medium' },
  { value: StakeTier.HIGH, label: 'High' },
]

const STAKE_TIER_LABELS: Record<number, string> = {
  [StakeTier.NONE]: 'None',
  [StakeTier.SMALL]: 'Small',
  [StakeTier.MEDIUM]: 'Medium',
  [StakeTier.HIGH]: 'High',
}

function formatCategoryLabel(value?: string): string {
  if (!value) return ''

  return (
    CATEGORY_LABELS[value.toLowerCase()] ??
    value
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ')
  )
}

function toShortAddress(value: string | null | undefined): string {
  if (!value) return 'Not set'
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function normalizeWalletAddressInput(value: string): string {
  return value.trim().replace(/[.,;:]+$/g, '')
}

function formatTokenAmount(raw: bigint): string {
  if (raw <= 0n) return '0'
  const asFloat = Number(raw) / 1e18
  if (!Number.isFinite(asFloat)) return raw.toString()
  return asFloat.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function buildUpdatedTokenUri(params: {
  currentTokenURI: string
  fallbackName: string
  owner: string
  description: string
}): string {
  const { currentTokenURI, fallbackName, owner, description } = params

  let payload: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(currentTokenURI) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') {
      payload = parsed
    }
  } catch {
    payload = {}
  }

  payload.name =
    typeof payload.name === 'string' && payload.name.length > 0
      ? payload.name
      : fallbackName
  payload.owner =
    typeof payload.owner === 'string' && payload.owner.length > 0
      ? payload.owner
      : owner
  payload.description = description
  payload.updatedAt = new Date().toISOString()

  return JSON.stringify(payload)
}

interface AppDetailModalProps {
  agentId: bigint
  onClose: () => void
}

export default function AppDetailModal({
  agentId,
  onClose,
}: AppDetailModalProps) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { authenticated, getAccessToken, linkedAccounts, walletAddress } =
    useJejuAuth()
  const { linkProvider } = useOAuth3()
  const { app, isLoading, refetch } = useRegistryAppDetails(agentId)
  const {
    withdrawStake,
    increaseAgentStake,
    setAgentWallet,
    updateAgentCategory,
    updateAgentTags,
    updateAgentUri,
    gasless,
  } = useRegistry()
  const gaslessBootstrap = useGaslessBootstrap({ gasless })

  const [isWithdrawing, setIsWithdrawing] = useState(false)
  const [isSavingWallet, setIsSavingWallet] = useState(false)
  const [isSavingCategory, setIsSavingCategory] = useState(false)
  const [isSavingDescription, setIsSavingDescription] = useState(false)
  const [isIncreasingStake, setIsIncreasingStake] = useState(false)

  const [walletInput, setWalletInput] = useState('')
  const [categoryInput, setCategoryInput] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [descriptionInput, setDescriptionInput] = useState('')
  const [targetTier, setTargetTier] = useState<StakeTierValue>(StakeTier.SMALL)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSuccess, setFormSuccess] = useState<string | null>(null)
  const [githubToken, setGithubToken] = useState<string>()
  const [isLinkingGithub, setIsLinkingGithub] = useState(false)
  const [githubLinkError, setGithubLinkError] = useState<string | null>(null)
  const [githubLinkSuccess, setGithubLinkSuccess] = useState<string | null>(
    null,
  )
  const [sessionSmartAccountAddress, setSessionSmartAccountAddress] =
    useState<Address | null>(null)
  const lastHydratedSnapshotRef = useRef<string | null>(null)

  const targetTierStake = useStakeAmount(targetTier)
  const connectedAddress = useMemo<Address | undefined>(() => {
    if (address && isAddress(address)) return getAddress(address)
    if (walletAddress && isAddress(walletAddress)) {
      return getAddress(walletAddress)
    }
    return undefined
  }, [address, walletAddress])
  const effectiveSmartAccountAddress =
    gasless.smartAccountAddress ?? sessionSmartAccountAddress ?? undefined

  const categoryTags = useMemo(() => {
    if (!app) return []
    return [
      ...new Set(
        [app.category, ...(app.tags ?? [])].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ]
  }, [app])

  const isOwner =
    app &&
    connectedAddress &&
    app.owner.toLowerCase() === connectedAddress.toLowerCase()
  const isSmartAccountOwner =
    app &&
    effectiveSmartAccountAddress &&
    app.owner.toLowerCase() === effectiveSmartAccountAddress.toLowerCase()
  const canEdit = Boolean(isOwner || isSmartAccountOwner)
  const useGaslessOwnerPath = Boolean(!isOwner && isSmartAccountOwner)

  const currentTier = (app?.stakeTier ?? StakeTier.NONE) as StakeTierValue
  const upgradeTiers = STAKE_TIER_OPTIONS.filter(
    (tier) => tier.value > currentTier,
  )

  const additionalStake = useMemo(() => {
    if (!app || targetTierStake === undefined) return 0n
    if (targetTierStake <= app.stakeAmountRaw) return 0n
    return targetTierStake - app.stakeAmountRaw
  }, [app, targetTierStake])
  const linkedGitHubAccount = useMemo(
    () => linkedAccounts.find((account) => account.type === 'github'),
    [linkedAccounts],
  )

  useEffect(() => {
    let cancelled = false

    async function resolveSessionSmartAccount() {
      if (gasless.smartAccountAddress) {
        setSessionSmartAccountAddress(null)
        return
      }
      if (!publicClient || !connectedAddress) {
        setSessionSmartAccountAddress(null)
        return
      }

      const factory = getConfiguredAddress(CONTRACTS.simpleAccountFactory)
      if (!factory) {
        setSessionSmartAccountAddress(null)
        return
      }

      try {
        const predictedAddress = await predictSimpleAccountAddress({
          publicClient,
          factoryAddress: factory,
          ownerAddress: connectedAddress,
        })
        if (!cancelled && isAddress(predictedAddress)) {
          setSessionSmartAccountAddress(getAddress(predictedAddress))
        }
      } catch {
        if (!cancelled) {
          setSessionSmartAccountAddress(null)
        }
      }
    }

    void resolveSessionSmartAccount()
    return () => {
      cancelled = true
    }
  }, [connectedAddress, gasless.smartAccountAddress, publicClient])

  useEffect(() => {
    if (!app) return

    const tags = [
      ...new Set(
        [app.category, ...(app.tags ?? [])].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ]
    const preferredUpgrade = STAKE_TIER_OPTIONS.find(
      (tier) => tier.value > (app.stakeTier ?? StakeTier.NONE),
    )
    const nextWallet = app.agentWallet ?? ''
    const nextCategory = app.category ?? tags[0] ?? ''
    const nextTags = tags.join(', ')
    const nextDescription = app.description ?? ''
    const nextTargetTier = preferredUpgrade?.value ?? StakeTier.HIGH
    const snapshot = JSON.stringify({
      wallet: nextWallet,
      category: nextCategory,
      tags: nextTags,
      description: nextDescription,
      targetTier: nextTargetTier,
    })

    if (lastHydratedSnapshotRef.current === snapshot) return
    lastHydratedSnapshotRef.current = snapshot

    setWalletInput(nextWallet)
    setCategoryInput(nextCategory)
    setTagsInput(nextTags)
    setDescriptionInput(nextDescription)
    setTargetTier(nextTargetTier)
  }, [app])

  useEffect(() => {
    let cancelled = false

    const loadAuthToken = async () => {
      if (!authenticated) {
        setGithubToken(undefined)
        return
      }

      const token = await getAccessToken()
      if (!cancelled) {
        setGithubToken(token ?? undefined)
      }
    }

    void loadAuthToken()

    return () => {
      cancelled = true
    }
  }, [authenticated, getAccessToken])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const clearMessages = () => {
    setFormError(null)
    setFormSuccess(null)
  }

  const handleLinkGithubSession = async () => {
    setGithubLinkError(null)
    setGithubLinkSuccess(null)
    setIsLinkingGithub(true)
    try {
      await linkProvider(AuthProvider.GITHUB)
      const token = await getAccessToken()
      setGithubToken(token ?? undefined)
      setGithubLinkSuccess(
        'GitHub sign-in linked to this wallet session. Continue in GitHub Reputation below.',
      )
    } catch (error) {
      setGithubLinkError(
        error instanceof Error
          ? error.message
          : 'Failed to link GitHub to this session.',
      )
    } finally {
      setIsLinkingGithub(false)
    }
  }

  const handleWithdraw = async () => {
    if (!canEdit) return
    clearMessages()
    setIsWithdrawing(true)
    try {
      const result = await withdrawStake(agentId, {
        gasless: useGaslessOwnerPath,
      })
      if (!result.success) {
        setFormError(result.error ?? 'Failed to unstake agent.')
        return
      }
      onClose()
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'Failed to unstake agent.',
      )
    } finally {
      setIsWithdrawing(false)
    }
  }

  const handleSetWallet = async () => {
    if (!app || !canEdit) return
    clearMessages()

    const normalizedWalletInput = normalizeWalletAddressInput(walletInput)
    if (normalizedWalletInput !== walletInput) {
      setWalletInput(normalizedWalletInput)
    }
    if (!isAddress(normalizedWalletInput)) {
      setFormError('Enter a valid wallet address.')
      return
    }

    setIsSavingWallet(true)
    try {
      if (useGaslessOwnerPath) {
        if (!connectedAddress || !effectiveSmartAccountAddress) {
          throw new Error('Smart account owner mode is not ready yet.')
        }

        const readiness = gasless.getReadiness()
        if (!readiness.isReady) {
          await gaslessBootstrap.bootstrap({
            purpose: 'registry',
            requiredStakeAmount: 0n,
            ownerAddress: connectedAddress,
            smartAccountAddress: effectiveSmartAccountAddress,
          })
        }
      }

      const result = await setAgentWallet(
        agentId,
        getAddress(normalizedWalletInput) as Address,
        {
          gasless: useGaslessOwnerPath,
        },
      )
      if (!result.success) {
        setFormError(result.error ?? 'Failed to update delegated wallet.')
        return
      }
      setFormSuccess('Delegated wallet updated on-chain.')
      await refetch()
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'Failed to update delegated wallet.',
      )
    } finally {
      setIsSavingWallet(false)
    }
  }

  const handleSaveCategories = async () => {
    if (!app || !canEdit) return
    clearMessages()

    const normalizedTags = Array.from(
      new Set(
        tagsInput
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    )
    const resolvedCategory = categoryInput.trim() || normalizedTags[0] || ''

    if (!resolvedCategory) {
      setFormError('Category is required.')
      return
    }

    setIsSavingCategory(true)
    try {
      const categoryResult = await updateAgentCategory(
        agentId,
        resolvedCategory,
        {
          gasless: useGaslessOwnerPath,
        },
      )
      if (!categoryResult.success) {
        setFormError(categoryResult.error ?? 'Failed to update category.')
        return
      }

      const tagsResult = await updateAgentTags(agentId, normalizedTags, {
        gasless: useGaslessOwnerPath,
      })
      if (!tagsResult.success) {
        setFormError(tagsResult.error ?? 'Failed to update tags.')
        return
      }

      setFormSuccess('Category and tags updated on-chain.')
      await refetch()
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'Failed to update category and tags.',
      )
    } finally {
      setIsSavingCategory(false)
    }
  }

  const handleSaveDescription = async () => {
    if (!app || !canEdit) return
    clearMessages()

    setIsSavingDescription(true)
    try {
      const nextTokenURI = buildUpdatedTokenUri({
        currentTokenURI: app.tokenURI,
        fallbackName: app.name,
        owner: app.owner,
        description: descriptionInput.trim(),
      })

      const result = await updateAgentUri(agentId, nextTokenURI, {
        gasless: useGaslessOwnerPath,
      })
      if (!result.success) {
        setFormError(result.error ?? 'Failed to update description.')
        return
      }

      setFormSuccess('Description updated on-chain.')
      await refetch()
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'Failed to update description.',
      )
    } finally {
      setIsSavingDescription(false)
    }
  }

  const handleIncreaseStake = async () => {
    if (!app || !canEdit) return
    clearMessages()

    if (targetTier <= currentTier) {
      setFormError('Select a stake tier above your current tier.')
      return
    }
    if (targetTierStake === undefined) {
      setFormError('Unable to load target tier stake requirement.')
      return
    }
    if (additionalStake <= 0n) {
      setFormError('No additional stake required for this tier.')
      return
    }

    setIsIncreasingStake(true)
    try {
      const result = await increaseAgentStake({
        agentId,
        newTier: targetTier,
        stakeToken: app.stakeTokenAddress,
        additionalStake,
        gasless: useGaslessOwnerPath,
      })
      if (!result.success) {
        setFormError(result.error ?? 'Failed to increase stake.')
        return
      }

      setFormSuccess(
        `Stake increased to ${STAKE_TIER_LABELS[targetTier] ?? targetTier}.`,
      )
      await refetch()
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'Failed to increase stake.',
      )
    } finally {
      setIsIncreasingStake(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
    >
      <button
        type="button"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          border: 'none',
          cursor: 'default',
        }}
        onClick={onClose}
        aria-label="Close"
      />
      <div
        className="card"
        role="dialog"
        aria-modal="true"
        style={{
          maxWidth: '680px',
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          position: 'relative',
        }}
      >
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '3rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⏳</div>
            <p>Loading app details...</p>
          </div>
        )}

        {!isLoading && app && (
          <div>
            <div
              style={{
                marginBottom: '1.5rem',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '1rem',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <h2
                  style={{
                    fontSize: 'clamp(1.25rem, 4vw, 1.75rem)',
                    marginBottom: '0.5rem',
                    wordBreak: 'break-word',
                  }}
                >
                  {app.name}
                </h2>
                <p
                  style={{
                    color: 'var(--text-secondary)',
                    fontSize: '0.875rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Agent ID: {agentId.toString()}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="button button-ghost"
                style={{ padding: '0.5rem', flexShrink: 0 }}
              >
                <XIcon size={18} />
              </button>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <h3
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                }}
              >
                Description
              </h3>
              <p style={{ color: 'var(--text-secondary)' }}>
                {app.description || 'No description set.'}
              </p>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <h3
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                }}
              >
                Categories
              </h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {categoryTags.length > 0 ? (
                  categoryTags.map((tag) => (
                    <span key={tag} className="pill">
                      {formatCategoryLabel(tag)}
                    </span>
                  ))
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>None</span>
                )}
              </div>
            </div>

            {app.a2aEndpoint && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h3
                  style={{
                    fontSize: '1rem',
                    fontWeight: 600,
                    marginBottom: '0.5rem',
                  }}
                >
                  A2A Endpoint
                </h3>
                <div
                  style={{
                    padding: '0.75rem',
                    background: 'var(--surface-hover)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                  }}
                >
                  <code
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-secondary)',
                      wordBreak: 'break-all',
                      minWidth: 0,
                    }}
                  >
                    {app.a2aEndpoint}
                  </code>
                  <a
                    href={app.a2aEndpoint}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent-primary)', flexShrink: 0 }}
                  >
                    <ExternalLinkIcon size={16} />
                  </a>
                </div>
              </div>
            )}

            <div style={{ marginBottom: '1.5rem' }}>
              <h3
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                }}
              >
                Stake Information
              </h3>
              <div
                style={{
                  padding: '1rem',
                  background: 'var(--surface-hover)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.875rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>Token:</span>
                  <span style={{ fontWeight: 600 }}>{app.stakeToken}</span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Amount:
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {app.stakeAmount}{' '}
                    {app.stakeToken !== 'None' ? app.stakeToken : ''}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>Tier:</span>
                  <span className="badge badge-info">
                    {STAKE_TIER_LABELS[app.stakeTier ?? 0] ?? 'Unknown'}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Deposited:
                  </span>
                  <span>
                    {new Date(
                      Number(app.depositedAt) * 1000,
                    ).toLocaleDateString()}
                  </span>
                </div>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between' }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Status:
                  </span>
                  <span className="badge badge-success">Active</span>
                </div>
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <h3
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                }}
              >
                Owner
              </h3>
              <code
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                  padding: '0.75rem',
                  background: 'var(--surface-hover)',
                  borderRadius: 'var(--radius-md)',
                  display: 'block',
                  wordBreak: 'break-all',
                }}
              >
                {app.owner}
              </code>
            </div>

            <div
              style={{
                marginBottom: '1.5rem',
                padding: '0.85rem',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                background: 'var(--surface-hover)',
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
              }}
            >
              GitHub Reputation links a developer profile to this identity and
              can power stake discounts/verification when the reputation
              contracts and leaderboard attestation are configured.
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <h3
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <GithubIcon size={18} />
                Developer Reputation
              </h3>
              <div
                style={{
                  marginBottom: '0.75rem',
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)',
                  background: 'var(--surface-hover)',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                <div style={{ marginBottom: '0.5rem' }}>
                  Auth status:{' '}
                  {linkedGitHubAccount ? (
                    <>
                      GitHub linked as{' '}
                      <strong>
                        {linkedGitHubAccount.handle ??
                          linkedGitHubAccount.identifier}
                      </strong>
                      .
                    </>
                  ) : (
                    <>wallet session only (GitHub not linked yet).</>
                  )}
                </div>
                {!linkedGitHubAccount && (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void handleLinkGithubSession()}
                    disabled={!authenticated || isLinkingGithub}
                    style={{ marginBottom: '0.5rem' }}
                  >
                    {isLinkingGithub
                      ? 'Linking GitHub...'
                      : 'Link GitHub Session'}
                  </button>
                )}
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  If you signed in with Ledger/Rabby first, link GitHub here,
                  then use the reputation actions below.
                </div>
              </div>
              {githubLinkError && (
                <div
                  className="banner banner-error"
                  style={{ marginBottom: '0.75rem' }}
                >
                  {githubLinkError}
                </div>
              )}
              {githubLinkSuccess && (
                <div
                  className="banner banner-success"
                  style={{ marginBottom: '0.75rem' }}
                >
                  {githubLinkSuccess}
                </div>
              )}
              <GitHubReputationPanel
                agentId={agentId}
                registryAddress={IDENTITY_REGISTRY_ADDRESS}
                githubToken={githubToken}
              />
            </div>

            <div
              className="banner banner-warning"
              style={{
                flexDirection: 'column',
                alignItems: 'stretch',
                marginBottom: 0,
              }}
            >
              <h3
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  marginBottom: '1rem',
                  color: 'var(--warning)',
                }}
              >
                Owner Actions
              </h3>

              {!canEdit && (
                <div
                  className="banner banner-error"
                  style={{ marginBottom: '1rem' }}
                >
                  Owner actions are locked for this session. Connected:{' '}
                  <code>{connectedAddress ?? 'Not connected'}</code> • Owner:{' '}
                  <code>{app.owner}</code>
                </div>
              )}
              {!canEdit && gasless.smartAccountDerivationError && (
                <div
                  className="banner banner-warning"
                  style={{ marginBottom: '1rem' }}
                >
                  Smart account detection warning:{' '}
                  <code>{gasless.smartAccountDerivationError}</code>
                </div>
              )}
              {!canEdit &&
                connectedAddress &&
                app.agentWallet &&
                app.agentWallet.toLowerCase() ===
                  connectedAddress.toLowerCase() && (
                  <div
                    className="banner banner-info"
                    style={{ marginBottom: '1rem' }}
                  >
                    You are connected with the delegated KMS wallet. Delegated
                    wallet can sign runtime operations, but only the agent owner
                    account can execute owner actions.
                  </div>
                )}
              {isSmartAccountOwner && !isOwner && (
                <div
                  className="banner banner-info"
                  style={{ marginBottom: '1rem' }}
                >
                  Smart account owner mode enabled. Smart account:{' '}
                  <code>{effectiveSmartAccountAddress}</code>
                </div>
              )}

              {canEdit ? (
                <>
                  <div style={{ display: 'grid', gap: '0.9rem' }}>
                    <div
                      style={{
                        display: 'grid',
                        gap: '0.5rem',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontWeight: 600,
                        }}
                      >
                        <WalletIcon size={15} />
                        Delegated Wallet
                      </div>
                      <div
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        Current: <code>{toShortAddress(app.agentWallet)}</code>
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                        }}
                      >
                        Use your KMS key wallet from <code>/security/keys</code>
                        .
                      </div>
                      <input
                        className="input"
                        type="text"
                        placeholder="0x..."
                        value={walletInput}
                        onChange={(event) => setWalletInput(event.target.value)}
                        disabled={isSavingWallet || !canEdit}
                      />
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void handleSetWallet()}
                        disabled={
                          isSavingWallet ||
                          gaslessBootstrap.isBootstrapping ||
                          !canEdit
                        }
                      >
                        {gaslessBootstrap.isBootstrapping ? (
                          <>
                            <Loader2Icon size={14} className="animate-spin" />
                            Preparing...
                          </>
                        ) : isSavingWallet ? (
                          <>
                            <Loader2Icon size={14} className="animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <WalletIcon size={14} />
                            Set Agent Wallet
                          </>
                        )}
                      </button>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gap: '0.5rem',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontWeight: 600,
                        }}
                      >
                        <EditIcon size={15} />
                        Categories
                      </div>
                      <input
                        className="input"
                        type="text"
                        placeholder="Primary category (e.g. agent)"
                        value={categoryInput}
                        onChange={(event) =>
                          setCategoryInput(event.target.value)
                        }
                        disabled={isSavingCategory || !canEdit}
                      />
                      <input
                        className="input"
                        type="text"
                        placeholder="Tags (comma-separated)"
                        value={tagsInput}
                        onChange={(event) => setTagsInput(event.target.value)}
                        disabled={isSavingCategory || !canEdit}
                      />
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void handleSaveCategories()}
                        disabled={isSavingCategory || !canEdit}
                      >
                        {isSavingCategory ? (
                          <>
                            <Loader2Icon size={14} className="animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <SaveIcon size={14} />
                            Save Categories
                          </>
                        )}
                      </button>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gap: '0.5rem',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontWeight: 600,
                        }}
                      >
                        <EditIcon size={15} />
                        Description
                      </div>
                      <textarea
                        className="input"
                        rows={3}
                        value={descriptionInput}
                        onChange={(event) =>
                          setDescriptionInput(event.target.value)
                        }
                        disabled={isSavingDescription || !canEdit}
                      />
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void handleSaveDescription()}
                        disabled={isSavingDescription || !canEdit}
                      >
                        {isSavingDescription ? (
                          <>
                            <Loader2Icon size={14} className="animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <SaveIcon size={14} />
                            Save Description
                          </>
                        )}
                      </button>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gap: '0.5rem',
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          fontWeight: 600,
                        }}
                      >
                        <PlusIcon size={15} />
                        Increase Stake
                      </div>
                      {upgradeTiers.length === 0 ? (
                        <span
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: '0.85rem',
                          }}
                        >
                          Already at highest tier.
                        </span>
                      ) : (
                        <>
                          <select
                            className="input"
                            value={targetTier}
                            onChange={(event) =>
                              setTargetTier(
                                Number(event.target.value) as StakeTierValue,
                              )
                            }
                            disabled={isIncreasingStake || !canEdit}
                          >
                            {upgradeTiers.map((tier) => (
                              <option key={tier.value} value={tier.value}>
                                {tier.label}
                              </option>
                            ))}
                          </select>
                          <div
                            style={{
                              fontSize: '0.8rem',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            Additional required:{' '}
                            {formatTokenAmount(additionalStake)}{' '}
                            {app.stakeToken !== 'None' ? app.stakeToken : 'ETH'}
                          </div>
                          <button
                            type="button"
                            className="button"
                            onClick={() => void handleIncreaseStake()}
                            disabled={isIncreasingStake || !canEdit}
                          >
                            {isIncreasingStake ? (
                              <>
                                <Loader2Icon
                                  size={14}
                                  className="animate-spin"
                                />
                                Processing...
                              </>
                            ) : (
                              <>
                                <PlusIcon size={14} />
                                Increase Stake
                              </>
                            )}
                          </button>
                        </>
                      )}
                    </div>

                    <button
                      type="button"
                      className="button"
                      onClick={() => void handleWithdraw()}
                      disabled={isWithdrawing || !canEdit}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.5rem',
                        background: 'var(--error)',
                      }}
                    >
                      <Trash2Icon size={16} />
                      {isWithdrawing ? 'Unstaking...' : 'Unstake & Burn Agent'}
                    </button>

                    <p
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--warning)',
                        marginTop: 0,
                      }}
                    >
                      Unstaking withdraws stake and de-registers this agent NFT.
                    </p>
                  </div>

                  {formError && (
                    <div className="banner banner-error">{formError}</div>
                  )}
                  {formSuccess && (
                    <div className="banner banner-success">{formSuccess}</div>
                  )}
                </>
              ) : (
                <div className="banner banner-info">
                  <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
                    View-only mode
                  </div>
                  <div style={{ fontSize: '0.85rem' }}>
                    This wallet can inspect agent settings but cannot execute
                    owner transactions.
                  </div>
                  <div
                    style={{
                      fontSize: '0.8rem',
                      marginTop: '0.5rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Owner-only actions: set delegated wallet, edit categories,
                    edit description, increase stake, and unstake.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
