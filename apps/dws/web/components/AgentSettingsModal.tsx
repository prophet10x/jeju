import {
  JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
  JEJU_AGENT_REGISTRATION_SERVICE,
} from '@jejunetwork/shared'
import { useEffect, useMemo, useState } from 'react'
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
} from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from 'wagmi'
import { CONTRACTS, TOKENS } from '../config'
import type { GaslessCall } from '../hooks/useGaslessSmartAccount'
import { useGaslessSmartAccount } from '../hooks/useGaslessSmartAccount'

const REGISTRY_ABI = [
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'getCategory',
    outputs: [{ name: 'category', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'getAgentTags',
    outputs: [{ name: 'tags', type: 'string[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'getAgentWallet',
    outputs: [{ name: 'wallet', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'agents',
    outputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'owner', type: 'address' },
      { name: 'tier', type: 'uint8' },
      { name: 'stakedToken', type: 'address' },
      { name: 'stakedAmount', type: 'uint256' },
      { name: 'registeredAt', type: 'uint256' },
      { name: 'lastActivityAt', type: 'uint256' },
      { name: 'isBanned', type: 'bool' },
      { name: 'isSlashed', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'tier', type: 'uint8' }],
    name: 'getStakeAmount',
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'wallet', type: 'address' },
    ],
    name: 'setAgentWallet',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'category', type: 'string' },
    ],
    name: 'setCategory',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'tags_', type: 'string[]' },
    ],
    name: 'updateTags',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newTokenURI', type: 'string' },
    ],
    name: 'setAgentUri',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newTier', type: 'uint8' },
    ],
    name: 'increaseStake',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [{ name: 'agentId', type: 'uint256' }],
    name: 'withdrawStake',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const STAKE_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Small',
  2: 'Medium',
  3: 'High',
}

interface AgentSettingsModalProps {
  agentId: string
  fallbackName: string
  fallbackOwner: string
  onClose: () => void
  onUpdated?: () => void
}

function parseTokenUri(tokenURI: string | undefined): {
  name: string
  description: string
} {
  if (!tokenURI) return { name: '', description: '' }
  try {
    const parsed = JSON.parse(tokenURI) as {
      name?: unknown
      description?: unknown
    }
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description:
        typeof parsed.description === 'string' ? parsed.description : '',
    }
  } catch {
    return { name: '', description: '' }
  }
}

function buildUpdatedTokenUri(params: {
  currentTokenURI: string | undefined
  fallbackName: string
  owner: string
  description: string
}): string {
  const current = params.currentTokenURI ?? ''
  let parsed: Record<string, unknown> = {}
  try {
    const maybe = JSON.parse(current) as Record<string, unknown>
    if (maybe && typeof maybe === 'object') parsed = maybe
  } catch {
    parsed = {}
  }

  parsed.name =
    typeof parsed.name === 'string' && parsed.name.length > 0
      ? parsed.name
      : params.fallbackName
  parsed.owner =
    typeof parsed.owner === 'string' && parsed.owner.length > 0
      ? parsed.owner
      : params.owner
  parsed.description = params.description
  parsed.updatedAt = new Date().toISOString()

  return JSON.stringify(parsed)
}

function formatTokenAmount(raw: bigint): string {
  if (raw <= 0n) return '0'
  const asFloat = Number(raw) / 1e18
  if (!Number.isFinite(asFloat)) return raw.toString()
  return asFloat.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

export default function AgentSettingsModal({
  agentId,
  fallbackName,
  fallbackOwner,
  onClose,
  onUpdated,
}: AgentSettingsModalProps) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const gasless = useGaslessSmartAccount()

  const id = BigInt(agentId)
  const registryAddress = CONTRACTS.identityRegistry

  const { data: tokenURI, refetch: refetchTokenURI } = useReadContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'tokenURI',
    args: [id],
    query: { enabled: registryAddress !== ZERO_ADDRESS },
  })

  const { data: category, refetch: refetchCategory } = useReadContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'getCategory',
    args: [id],
    query: { enabled: registryAddress !== ZERO_ADDRESS },
  })

  const { data: tags, refetch: refetchTags } = useReadContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'getAgentTags',
    args: [id],
    query: { enabled: registryAddress !== ZERO_ADDRESS },
  })

  const { data: agentWallet, refetch: refetchWallet } = useReadContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'getAgentWallet',
    args: [id],
    query: { enabled: registryAddress !== ZERO_ADDRESS },
  })

  const { data: agentData, refetch: refetchAgentData } = useReadContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'agents',
    args: [id],
    query: { enabled: registryAddress !== ZERO_ADDRESS },
  })

  const tier = agentData ? Number((agentData as readonly unknown[])[2]) : 0
  const stakedToken = agentData
    ? (String((agentData as readonly unknown[])[3]) as Address)
    : (ZERO_ADDRESS as Address)
  const stakedAmount = agentData
    ? BigInt(String((agentData as readonly unknown[])[4]))
    : 0n
  const owner = agentData
    ? String((agentData as readonly unknown[])[1])
    : fallbackOwner

  const tokenUriData = parseTokenUri(tokenURI as string | undefined)
  const displayName = tokenUriData.name || fallbackName || `Agent #${agentId}`
  const onChainCategory = (category as string | undefined) ?? ''
  const onChainTags = (tags as string[] | undefined) ?? []
  const onChainDescription = tokenUriData.description ?? ''

  const [walletInput, setWalletInput] = useState('')
  const [categoryInput, setCategoryInput] = useState(onChainCategory)
  const [tagsInput, setTagsInput] = useState(onChainTags.join(', '))
  const [descriptionInput, setDescriptionInput] = useState(onChainDescription)
  const [targetTier, setTargetTier] = useState(1)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const { data: targetTierStake } = useReadContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'getStakeAmount',
    args: [targetTier],
    query: { enabled: registryAddress !== ZERO_ADDRESS },
  })

  const additionalStake = useMemo(() => {
    if (!targetTierStake) return 0n
    const nextStake = targetTierStake as bigint
    return nextStake > stakedAmount ? nextStake - stakedAmount : 0n
  }, [targetTierStake, stakedAmount])

  const canUpgrade = tier < 3
  const isOwner = Boolean(
    address && owner && address.toLowerCase() === owner.toLowerCase(),
  )
  const isSmartAccountOwner = Boolean(
    gasless.smartAccountAddress &&
      owner &&
      gasless.smartAccountAddress.toLowerCase() === owner.toLowerCase(),
  )
  const canEdit = Boolean(isOwner || isSmartAccountOwner)
  const useGaslessOwnerPath = Boolean(!isOwner && isSmartAccountOwner)
  const registryConfigured = registryAddress !== ZERO_ADDRESS

  useEffect(() => {
    setWalletInput((agentWallet as string | undefined) ?? '')
  }, [agentWallet])

  useEffect(() => {
    setCategoryInput(onChainCategory)
  }, [onChainCategory])

  useEffect(() => {
    setTagsInput(onChainTags.join(', '))
  }, [onChainTags])

  useEffect(() => {
    setDescriptionInput(onChainDescription)
  }, [onChainDescription])

  useEffect(() => {
    setTargetTier(tier >= 3 ? 3 : tier + 1)
  }, [tier])

  const refetchAll = async () => {
    await Promise.all([
      refetchTokenURI(),
      refetchCategory(),
      refetchTags(),
      refetchWallet(),
      refetchAgentData(),
    ])
    onUpdated?.()
  }

  const submitTx = async (fn: () => Promise<`0x${string}`>) => {
    if (!publicClient) throw new Error('Public client unavailable')
    if (!registryConfigured) throw new Error('IdentityRegistry not configured')
    const hash = await fn()
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      throw new Error('Transaction reverted on-chain')
    }
    return hash
  }

  const submitGaslessTx = async (params: {
    serviceName: string
    calls: GaslessCall[]
    requiredJejuBalance?: bigint
  }) => {
    if (!publicClient) throw new Error('Public client unavailable')
    if (!registryConfigured) throw new Error('IdentityRegistry not configured')
    const hash = await gasless.executeGaslessCalls(params)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      throw new Error('Transaction reverted on-chain')
    }
    return hash
  }

  const runAction = async (label: string, action: () => Promise<void>) => {
    setError(null)
    setSuccess(null)
    setIsBusy(true)
    try {
      await action()
      await refetchAll()
      setSuccess(label)
      return true
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : 'Transaction failed',
      )
      return false
    } finally {
      setIsBusy(false)
    }
  }

  const setDelegatedWallet = async () => {
    if (!isAddress(walletInput.trim())) {
      throw new Error('Enter a valid wallet address')
    }
    const resolvedWallet = getAddress(walletInput.trim())
    if (useGaslessOwnerPath) {
      await submitGaslessTx({
        serviceName: JEJU_AGENT_REGISTRATION_SERVICE,
        calls: [
          {
            to: registryAddress,
            data: encodeFunctionData({
              abi: REGISTRY_ABI,
              functionName: 'setAgentWallet',
              args: [id, resolvedWallet],
            }),
          },
        ],
      })
      return
    }

    await submitTx(() =>
      writeContractAsync({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: 'setAgentWallet',
        args: [id, resolvedWallet],
      }),
    )
  }

  const saveCategoryAndTags = async () => {
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
      throw new Error('Category is required')
    }

    if (useGaslessOwnerPath) {
      await submitGaslessTx({
        serviceName: JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
        calls: [
          {
            to: registryAddress,
            data: encodeFunctionData({
              abi: REGISTRY_ABI,
              functionName: 'setCategory',
              args: [id, resolvedCategory],
            }),
          },
          {
            to: registryAddress,
            data: encodeFunctionData({
              abi: REGISTRY_ABI,
              functionName: 'updateTags',
              args: [id, normalizedTags],
            }),
          },
        ],
      })
      return
    }

    await submitTx(() =>
      writeContractAsync({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: 'setCategory',
        args: [id, resolvedCategory],
      }),
    )

    await submitTx(() =>
      writeContractAsync({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: 'updateTags',
        args: [id, normalizedTags],
      }),
    )
  }

  const saveDescription = async () => {
    const nextTokenUri = buildUpdatedTokenUri({
      currentTokenURI: tokenURI as string | undefined,
      fallbackName: displayName,
      owner,
      description: descriptionInput.trim(),
    })

    if (useGaslessOwnerPath) {
      await submitGaslessTx({
        serviceName: JEJU_AGENT_REGISTRATION_METADATA_SERVICE,
        calls: [
          {
            to: registryAddress,
            data: encodeFunctionData({
              abi: REGISTRY_ABI,
              functionName: 'setAgentUri',
              args: [id, nextTokenUri],
            }),
          },
        ],
      })
      return
    }

    await submitTx(() =>
      writeContractAsync({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: 'setAgentUri',
        args: [id, nextTokenUri],
      }),
    )
  }

  const increaseStake = async () => {
    if (!canUpgrade) {
      throw new Error('Agent is already at the highest stake tier')
    }
    if (targetTier <= tier) {
      throw new Error('Select a tier above current tier')
    }
    if (additionalStake <= 0n) {
      throw new Error('No additional stake required for selected tier')
    }

    if (useGaslessOwnerPath) {
      const calls: GaslessCall[] = []
      if (stakedToken !== ZERO_ADDRESS) {
        calls.push({
          to: stakedToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [registryAddress, additionalStake],
          }),
        })
      }
      calls.push({
        to: registryAddress,
        data: encodeFunctionData({
          abi: REGISTRY_ABI,
          functionName: 'increaseStake',
          args: [id, targetTier],
        }),
        value: stakedToken === ZERO_ADDRESS ? additionalStake : 0n,
      })

      await submitGaslessTx({
        serviceName: JEJU_AGENT_REGISTRATION_SERVICE,
        calls,
        requiredJejuBalance:
          stakedToken.toLowerCase() === TOKENS.jeju.toLowerCase()
            ? additionalStake
            : 0n,
      })
      return
    }

    if (stakedToken !== ZERO_ADDRESS) {
      await submitTx(() =>
        writeContractAsync({
          address: stakedToken,
          abi: erc20Abi,
          functionName: 'approve',
          args: [registryAddress, additionalStake],
        }),
      )
    }

    await submitTx(() =>
      writeContractAsync({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: 'increaseStake',
        args: [id, targetTier],
        value: stakedToken === ZERO_ADDRESS ? additionalStake : 0n,
      }),
    )
  }

  const unstake = async () => {
    if (useGaslessOwnerPath) {
      await submitGaslessTx({
        serviceName: JEJU_AGENT_REGISTRATION_SERVICE,
        calls: [
          {
            to: registryAddress,
            data: encodeFunctionData({
              abi: REGISTRY_ABI,
              functionName: 'withdrawStake',
              args: [id],
            }),
          },
        ],
      })
      return
    }

    await submitTx(() =>
      writeContractAsync({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: 'withdrawStake',
        args: [id],
      }),
    )
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          border: 'none',
          background: 'rgba(0, 0, 0, 0.55)',
        }}
      />
      <div
        className="card"
        role="dialog"
        aria-modal="true"
        style={{
          width: 'min(720px, 100%)',
          maxHeight: '90vh',
          overflow: 'auto',
          zIndex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'start',
            gap: '1rem',
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>{displayName}</h3>
            <p
              style={{
                margin: '0.35rem 0 0',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              Agent ID: {agentId}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div
          style={{
            marginTop: '1rem',
            padding: '0.85rem',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            fontSize: '0.9rem',
          }}
        >
          <div>
            Owner: <code>{owner}</code>
          </div>
          <div style={{ marginTop: '0.35rem' }}>
            Current tier: <strong>{STAKE_LABELS[tier] ?? 'Unknown'}</strong>
          </div>
          <div style={{ marginTop: '0.35rem' }}>
            Current stake: <strong>{formatTokenAmount(stakedAmount)}</strong>
          </div>
          <div style={{ marginTop: '0.35rem' }}>
            Delegated wallet:{' '}
            <code>{(agentWallet as string) || 'Not set'}</code>
          </div>
        </div>

        {!canEdit && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              borderRadius: 'var(--radius-md)',
              background: 'var(--warning-soft)',
              color: 'var(--warning)',
            }}
          >
            Owner actions are locked for this session. Connected:{' '}
            <code>{address ?? 'Not connected'}</code> • Owner:{' '}
            <code>{owner}</code>
          </div>
        )}
        {useGaslessOwnerPath && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              borderRadius: 'var(--radius-md)',
              background: 'var(--info-soft)',
              color: 'var(--info)',
            }}
          >
            Smart account owner mode enabled. Smart account:{' '}
            <code>{gasless.smartAccountAddress}</code>
          </div>
        )}

        <div style={{ display: 'grid', gap: '0.85rem', marginTop: '1rem' }}>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <label htmlFor="wallet-input" style={{ fontWeight: 600 }}>
              Set delegated wallet
            </label>
            <input
              id="wallet-input"
              className="form-input"
              value={walletInput}
              onChange={(event) => setWalletInput(event.target.value)}
              placeholder="0x..."
              disabled={isBusy || !canEdit}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={isBusy || !canEdit}
              onClick={() =>
                void runAction('Delegated wallet updated.', setDelegatedWallet)
              }
            >
              Save Wallet
            </button>
          </div>

          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <label htmlFor="category-input" style={{ fontWeight: 600 }}>
              Categories
            </label>
            <input
              id="category-input"
              className="form-input"
              value={categoryInput}
              onChange={(event) => setCategoryInput(event.target.value)}
              placeholder="Primary category"
              disabled={isBusy || !canEdit}
            />
            <input
              className="form-input"
              value={tagsInput}
              onChange={(event) => setTagsInput(event.target.value)}
              placeholder="Tags (comma-separated)"
              disabled={isBusy || !canEdit}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={isBusy || !canEdit}
              onClick={() =>
                void runAction('Category/tags updated.', saveCategoryAndTags)
              }
            >
              Save Categories
            </button>
          </div>

          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <label htmlFor="description-input" style={{ fontWeight: 600 }}>
              Description
            </label>
            <textarea
              id="description-input"
              className="form-input"
              rows={3}
              value={descriptionInput}
              onChange={(event) => setDescriptionInput(event.target.value)}
              disabled={isBusy || !canEdit}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={isBusy || !canEdit}
              onClick={() =>
                void runAction('Description updated.', saveDescription)
              }
            >
              Save Description
            </button>
          </div>

          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <label htmlFor="tier-input" style={{ fontWeight: 600 }}>
              Increase stake
            </label>
            <select
              id="tier-input"
              className="form-select"
              value={targetTier}
              onChange={(event) => setTargetTier(Number(event.target.value))}
              disabled={isBusy || !canUpgrade || !canEdit}
            >
              <option value={1}>Small</option>
              <option value={2}>Medium</option>
              <option value={3}>High</option>
            </select>
            <small style={{ color: 'var(--text-muted)' }}>
              Additional required: {formatTokenAmount(additionalStake)}
            </small>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isBusy || !canUpgrade || !canEdit}
              onClick={() => void runAction('Stake increased.', increaseStake)}
            >
              Increase Stake
            </button>
          </div>

          <div
            style={{
              borderTop: '1px solid var(--border)',
              paddingTop: '0.75rem',
            }}
          >
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={isBusy || !canEdit}
              onClick={() => {
                void runAction('Agent unstaked and removed.', unstake).then(
                  (ok) => {
                    if (ok) onClose()
                  },
                )
              }}
            >
              Unstake & Burn Agent
            </button>
            <p
              style={{
                marginTop: '0.5rem',
                color: 'var(--text-muted)',
                fontSize: '0.8rem',
              }}
            >
              This withdraws stake and de-registers the ERC-8004 identity.
            </p>
          </div>
        </div>

        {error && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              borderRadius: 'var(--radius-md)',
              background: 'var(--error-soft)',
              color: 'var(--error)',
            }}
          >
            {error}
          </div>
        )}
        {success && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              borderRadius: 'var(--radius-md)',
              background: 'var(--success-soft)',
              color: 'var(--success)',
            }}
          >
            {success}
          </div>
        )}
      </div>
    </div>
  )
}
