import {
  calculateUsdValue as calculateUSDValue,
  fetchAgentWallet,
  formatTokenUsd as formatUSD,
  getNodeServiceMinimumStakeUsd,
  getNodeRegisteredIdFromReceipt,
  NODE_SERVICE_DEFINITIONS,
  type NodeIdentityMetadata,
  type NodeRegistrationDraft,
  type NodeRegistrationResult,
  type NodeServiceId,
  parseTokenAmount,
  waitForAgentWallet,
} from '@jejunetwork/shared'
import { ZERO_ADDRESS } from '@jejunetwork/types'
import { useEffect, useMemo, useState } from 'react'
import { type Address, encodeFunctionData, formatUnits, parseEther } from 'viem'
import {
  calculateMonthlyRewardEstimate,
  REGION_NAMES,
  Region,
} from '../../lib/nodeStaking'
import { CONTRACTS, EXPLORER_URL } from '../../lib/config'
import { useAgentId } from '../hooks/useAgentId'
import { useNodeIdentityRegistry } from '../hooks/useNodeIdentityRegistry'
import { useNodeStaking } from '../hooks/useNodeStaking'
import { useProtocolTokens } from '../hooks/useProtocolTokens'
import {
  TransactionStatusModal,
  type TransactionStatusResult,
} from '@jejunetwork/ui/wallet'
import {
  usePublicClient,
  useSignMessage,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import type { TokenOption } from './TokenSelector'
import TokenSelector from './TokenSelector'

const IDENTITY_REGISTRY_ABI = [
  {
    name: 'setAgentWallet',
    type: 'function',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'wallet', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

interface NodeProofChallenge {
  challengeId: string
  expiresAt: number
  endpoint: string
  endpointOrigin: string
  proofUrl: string
  nodeWalletAddress: Address
  currentAgentWallet: Address | null
  delegatedWalletContractReady: boolean
  requiresDelegatedWalletUpdate: boolean
  operatorMessage: string
  nodeMessage: string
}

interface NodeProofVerification {
  verified: boolean
  challengeId: string
  nodeWalletAddress: Address
  endpointOrigin: string
  proofUrl: string
  verifiedAt: number
}

type RegistrationStep =
  | 'identity'
  | 'services'
  | 'stake'
  | 'confirm'
  | 'complete'

export default function RegisterNodeForm() {
  const publicClient = usePublicClient()
  const { tokens } = useProtocolTokens()
  const {
    registerNode,
    isRegistering,
    registrationHash,
    registrationReceipt,
    operatorStats,
    gasless,
  } = useNodeStaking()
  const { registerNodeIdentity } = useNodeIdentityRegistry()
  const { agents, agentId, hasAgent, isLoading: isAgentLoading } = useAgentId()

  const [stakingToken, setStakingToken] = useState<TokenOption | null>(null)
  const [stakeAmount, setStakeAmount] = useState('')
  const [rewardToken, setRewardToken] = useState<TokenOption | null>(null)
  const [rpcUrl, setRpcUrl] = useState('')
  const [region, setRegion] = useState<Region>(Region.NorthAmerica)
  const [nodeName, setNodeName] = useState('')
  const [zone, setZone] = useState('')
  const [cpuCores, setCpuCores] = useState('')
  const [memoryGb, setMemoryGb] = useState('')
  const [diskGb, setDiskGb] = useState('')
  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [operatorAgentId, setOperatorAgentId] = useState('')
  const [useGasless, setUseGasless] = useState(true)
  const [step, setStep] = useState<RegistrationStep>('identity')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedDraft, setSubmittedDraft] = useState<NodeRegistrationDraft | null>(
    null,
  )
  const [processedRegistrationHash, setProcessedRegistrationHash] = useState<
    `0x${string}` | null
  >(null)
  const [nodeRegistrationResult, setNodeRegistrationResult] =
    useState<NodeRegistrationResult | null>(null)
  const [nodeIdentityError, setNodeIdentityError] = useState<string | null>(null)
  const [isRegisteringNodeIdentity, setIsRegisteringNodeIdentity] = useState(false)
  const [proofChallenge, setProofChallenge] = useState<NodeProofChallenge | null>(
    null,
  )
  const [proofVerification, setProofVerification] =
    useState<NodeProofVerification | null>(null)
  const [isPreparingProof, setIsPreparingProof] = useState(false)
  const [isVerifyingProof, setIsVerifyingProof] = useState(false)
  const [isAuthorizingNodeWallet, setIsAuthorizingNodeWallet] = useState(false)
  const [authorizeResult, setAuthorizeResult] =
    useState<TransactionStatusResult | null>(null)

  const { signMessageAsync, isPending: isSigningOperatorMessage } = useSignMessage()
  const {
    writeContract: writeSetAgentWallet,
    data: setAgentWalletHash,
    isPending: isSetAgentWalletPending,
  } = useWriteContract()
  const { isSuccess: isSetAgentWalletSuccess, isLoading: isSetAgentWalletConfirming } =
    useWaitForTransactionReceipt({ hash: setAgentWalletHash })

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

  const minStakeUSD = getNodeServiceMinimumStakeUsd(selectedServices.length)
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
    selectedServices.length > 0 &&
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

  const selectedOperatorAgent = useMemo(
    () =>
      parsedOperatorAgentId !== null && parsedOperatorAgentId !== undefined
        ? agents.find((candidate) => Number(candidate.id) === Number(parsedOperatorAgentId))
        : undefined,
    [agents, parsedOperatorAgentId],
  )

  const selectedOperatorOwnedBySmartAccount = useMemo(
    () =>
      Boolean(
        selectedOperatorAgent?.owner &&
          gasless.smartAccountAddress &&
          selectedOperatorAgent.owner.toLowerCase() ===
            gasless.smartAccountAddress.toLowerCase(),
      ),
    [gasless.smartAccountAddress, selectedOperatorAgent?.owner],
  )

  const nodeWalletAuthorized = useMemo(
    () =>
      proofChallenge !== null &&
      proofChallenge.currentAgentWallet !== null &&
      proofChallenge.currentAgentWallet.toLowerCase() ===
        proofChallenge.nodeWalletAddress.toLowerCase(),
    [proofChallenge],
  )

  const isOwnershipVerified = useMemo(
    () =>
      proofVerification !== null &&
      proofVerification.challengeId === proofChallenge?.challengeId,
    [proofChallenge?.challengeId, proofVerification],
  )

  const disabledReason = useMemo(() => {
    if (!canAddMore) return `Maximum of ${maxNodes} nodes reached`
    if (selectedServices.length === 0) return 'Select at least one service'
    if (!stakingToken) return 'Select a staking token'
    if (!stakeAmount || parsedStakeAmount <= 0n) return 'Enter a stake amount'
    if (stakeValueUSD < minStakeUSD) {
      return `Stake must be at least $${minStakeUSD.toLocaleString()}`
    }
    if (!rewardToken) return 'Select a reward token'
    if (!rpcUrl.startsWith('http')) return 'Enter a valid RPC URL'
    if (hasAgent && !operatorAgentId.trim()) return 'Select an operator identity'
    if (parsedOperatorAgentId === null) return 'Operator agent ID must be a number'
    if (!isOwnershipVerified) return 'Verify endpoint ownership before registering'
    if (useGasless && !gaslessSupportsSelectedToken) {
      return 'Gasless node registration currently supports JEJU staking only'
    }
    if (useGasless && gasless.smartAccountDerivationError) {
      return gasless.smartAccountDerivationError
    }
    if (useGasless && !gaslessReadiness.isReady) {
      return 'Prepare the smart account first'
    }
    return null
  }, [
    canAddMore,
    gasless.smartAccountDerivationError,
    gaslessReadiness.isReady,
    gaslessSupportsSelectedToken,
    maxNodes,
    minStakeUSD,
    hasAgent,
    operatorAgentId,
    parsedOperatorAgentId,
    parsedStakeAmount,
    rewardToken,
    rpcUrl,
    stakeAmount,
    stakeValueUSD,
    stakingToken,
    useGasless,
    selectedServices.length,
    isOwnershipVerified,
  ])

  const toggleService = (serviceId: string) => {
    setSelectedServices((current) =>
      current.includes(serviceId)
        ? current.filter((candidate) => candidate !== serviceId)
        : [...current, serviceId],
    )
  }

  useEffect(() => {
    if (!hasAgent) return

    setOperatorAgentId((current) => {
      if (current && agents.some((candidate) => candidate.id === current)) {
        return current
      }

      return agentId ? String(agentId) : agents[0]?.id ?? ''
    })
  }, [agentId, agents, hasAgent])

  useEffect(() => {
    setProofChallenge(null)
    setProofVerification(null)
  }, [rpcUrl, parsedOperatorAgentId])

  useEffect(() => {
    if (!setAgentWalletHash || selectedOperatorOwnedBySmartAccount) return

    setAuthorizeResult((current) => {
      if (
        current?.status === 'success' ||
        (current?.status === 'info' && current.txHash === setAgentWalletHash)
      ) {
        return current
      }

      return {
        status: 'info',
        title: 'Authorization submitted',
        message: 'Waiting for on-chain confirmation.',
        txHash: setAgentWalletHash,
        explorerUrl: EXPLORER_URL,
      }
    })
  }, [selectedOperatorOwnedBySmartAccount, setAgentWalletHash])

  useEffect(() => {
    if (
      !isSetAgentWalletSuccess ||
      !publicClient ||
      parsedOperatorAgentId === undefined ||
      !proofChallenge ||
      selectedOperatorOwnedBySmartAccount
    ) {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        const resolvedWallet = await waitForAgentWallet({
          publicClient,
          registryAddress: CONTRACTS.identityRegistry,
          agentId: parsedOperatorAgentId,
          expectedWallet: proofChallenge.nodeWalletAddress,
        })

        if (
          cancelled ||
          !resolvedWallet ||
          resolvedWallet.toLowerCase() !==
            proofChallenge.nodeWalletAddress.toLowerCase()
        ) {
          throw new Error('Delegated node wallet was not updated on-chain')
        }

        setProofChallenge((current) =>
          current
            ? {
                ...current,
                currentAgentWallet: resolvedWallet,
                requiresDelegatedWalletUpdate: false,
              }
            : current,
        )

        if (setAgentWalletHash) {
          setAuthorizeResult({
            status: 'success',
            title: 'Node wallet authorized',
            message: 'The delegated node wallet was authorized on-chain.',
            txHash: setAgentWalletHash,
            explorerUrl: EXPLORER_URL,
          })
        }
      } catch (error) {
        if (cancelled) return
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to confirm delegated wallet authorization'
        setAuthorizeResult({
          status: 'error',
          title: 'Authorization failed',
          message,
          txHash: setAgentWalletHash,
          explorerUrl: EXPLORER_URL,
        })
        setSubmitError(message)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    isSetAgentWalletSuccess,
    parsedOperatorAgentId,
    proofChallenge,
    publicClient,
    selectedOperatorOwnedBySmartAccount,
    setAgentWalletHash,
  ])

  const prepareOwnershipProof = async () => {
    if (!gasless.ownerAddress || parsedOperatorAgentId === undefined) {
      setSubmitError('Connect the operator wallet and select an agent first.')
      return
    }
    if (!rpcUrl.startsWith('http')) {
      setSubmitError('Enter the node endpoint URL before preparing proof.')
      return
    }

    setSubmitError(null)
    setIsPreparingProof(true)
    setProofVerification(null)

    try {
      const response = await fetch('/gateway/api/node-registration/challenge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: rpcUrl,
          operatorAddress: gasless.ownerAddress,
          operatorAgentId: Number(parsedOperatorAgentId),
        }),
      })

      const payload = (await response.json()) as NodeProofChallenge | { error?: string }
      if (!response.ok || 'error' in payload) {
        throw new Error(payload.error ?? 'Failed to prepare node proof')
      }

      setProofChallenge(payload)
    } catch (error) {
      setProofChallenge(null)
      setSubmitError(
        error instanceof Error ? error.message : 'Failed to prepare proof',
      )
    } finally {
      setIsPreparingProof(false)
    }
  }

  const authorizeNodeWallet = async () => {
    if (!proofChallenge || parsedOperatorAgentId === undefined) {
      setSubmitError('Prepare the node proof challenge first.')
      return
    }
    if (CONTRACTS.identityRegistry === ZERO_ADDRESS) {
      setSubmitError('Identity registry not configured for this network.')
      return
    }

    setSubmitError(null)
    if (selectedOperatorOwnedBySmartAccount) {
      if (!publicClient) {
        setSubmitError('Public client is not available.')
        return
      }

      setIsAuthorizingNodeWallet(true)

      try {
        const hash = await gasless.executeGaslessCalls({
          serviceName: 'Jeju Node Registration',
          calls: [
            {
              to: CONTRACTS.identityRegistry,
              data: encodeFunctionData({
                abi: IDENTITY_REGISTRY_ABI,
                functionName: 'setAgentWallet',
                args: [parsedOperatorAgentId, proofChallenge.nodeWalletAddress],
              }),
            },
          ],
        })
        setAuthorizeResult({
          status: 'info',
          title: 'Authorization submitted',
          message: 'Waiting for on-chain confirmation.',
          txHash: hash,
          explorerUrl: EXPLORER_URL,
        })
        const resolvedWallet = await waitForAgentWallet({
          publicClient,
          registryAddress: CONTRACTS.identityRegistry,
          agentId: parsedOperatorAgentId,
          expectedWallet: proofChallenge.nodeWalletAddress,
        })

        if (
          !resolvedWallet ||
          resolvedWallet.toLowerCase() !==
            proofChallenge.nodeWalletAddress.toLowerCase()
        ) {
          throw new Error('Delegated node wallet was not updated on-chain')
        }

        setProofChallenge((current) =>
          current
            ? {
                ...current,
                currentAgentWallet: resolvedWallet,
                requiresDelegatedWalletUpdate: false,
              }
            : current,
        )
        setAuthorizeResult({
          status: 'success',
          title: 'Node wallet authorized',
          message: 'The delegated node wallet was authorized on-chain.',
          txHash: hash,
          explorerUrl: EXPLORER_URL,
        })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to authorize node wallet'
        setAuthorizeResult({
          status: 'error',
          title: 'Authorization failed',
          message,
          explorerUrl: EXPLORER_URL,
        })
        setSubmitError(
          message,
        )
      } finally {
        setIsAuthorizingNodeWallet(false)
      }
      return
    }

    writeSetAgentWallet({
      address: CONTRACTS.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setAgentWallet',
      args: [parsedOperatorAgentId, proofChallenge.nodeWalletAddress],
    })
  }

  const verifyOwnershipProof = async () => {
    if (!proofChallenge || parsedOperatorAgentId === undefined || !publicClient) {
      setSubmitError('Prepare the node proof challenge first.')
      return
    }

    setSubmitError(null)
    setIsVerifyingProof(true)

    try {
      const operatorSignature = await signMessageAsync({
        message: proofChallenge.operatorMessage,
      })

      const response = await fetch('/gateway/api/node-registration/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          challengeId: proofChallenge.challengeId,
          operatorSignature,
        }),
      })

      const payload = (await response.json()) as
        | NodeProofVerification
        | { error?: string }

      if (!response.ok || 'error' in payload) {
        throw new Error(payload.error ?? 'Failed to verify node proof')
      }

      const onChainAgentWallet = await fetchAgentWallet({
        publicClient,
        registryAddress: CONTRACTS.identityRegistry,
        agentId: parsedOperatorAgentId,
      })

      setProofVerification(payload)
      setProofChallenge((current) =>
        current
          ? {
              ...current,
              currentAgentWallet: onChainAgentWallet,
              requiresDelegatedWalletUpdate:
                !onChainAgentWallet ||
                onChainAgentWallet.toLowerCase() !==
                  payload.nodeWalletAddress.toLowerCase(),
            }
          : current,
      )
    } catch (error) {
      setProofVerification(null)
      setSubmitError(
        error instanceof Error ? error.message : 'Failed to verify proof',
      )
    } finally {
      setIsVerifyingProof(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError(null)

    if (disabledReason || !stakingToken || !rewardToken) {
      if (disabledReason) setSubmitError(disabledReason)
      return
    }

    try {
      const nextDraft: NodeRegistrationDraft = {
        operatorAgentId: String(parsedOperatorAgentId ?? ''),
        services: selectedServices as NodeServiceId[],
        stakeAmount: parsedStakeAmount.toString(),
        stakingToken: stakingToken.address,
        rewardToken: rewardToken.address,
        rpcUrl,
        region: REGION_NAMES[region] ?? 'Unknown',
        nodeName: nodeName.trim() || undefined,
        zone: zone.trim() || undefined,
        cpuCores: cpuCores ? Number(cpuCores) : undefined,
        memoryGb: memoryGb ? Number(memoryGb) : undefined,
        diskGb: diskGb ? Number(diskGb) : undefined,
      }

      setSubmittedDraft(nextDraft)
      setNodeIdentityError(null)
      setNodeRegistrationResult(null)
      await registerNode(
        stakingToken.address as `0x${string}`,
        parsedStakeAmount,
        rewardToken.address as `0x${string}`,
        rpcUrl,
        region,
        parsedOperatorAgentId ?? undefined,
        { gasless: useGasless },
      )
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : 'Node registration failed',
      )
    }
  }

  useEffect(() => {
    if (!registrationHash || !registrationReceipt || !submittedDraft) return
    if (processedRegistrationHash === registrationHash) return

    const nodeId = getNodeRegisteredIdFromReceipt(registrationReceipt)
    setProcessedRegistrationHash(registrationHash)

    if (!nodeId) {
      setNodeIdentityError('Node registered, but the node ID could not be decoded.')
      return
    }

    const metadata: NodeIdentityMetadata = {
      nodeName: submittedDraft.nodeName,
      operatorAgentId: submittedDraft.operatorAgentId,
      nodeId,
      rpcUrl: submittedDraft.rpcUrl,
      region: submittedDraft.region,
      services: submittedDraft.services,
      serviceTags: [...submittedDraft.services],
      cpuCores: submittedDraft.cpuCores,
      memoryGb: submittedDraft.memoryGb,
      diskGb: submittedDraft.diskGb,
      zone: submittedDraft.zone,
      stakingToken: submittedDraft.stakingToken,
      stakeAmount: submittedDraft.stakeAmount,
      rewardToken: submittedDraft.rewardToken,
      status: 'active',
    }

    setIsRegisteringNodeIdentity(true)
    void registerNodeIdentity(metadata, { gasless: useGasless }).then((result) => {
      setIsRegisteringNodeIdentity(false)
      if (!result.success) {
        setNodeIdentityError(
          result.error ?? 'Node identity registration failed after staking succeeded.',
        )
        return
      }

      setNodeRegistrationResult({
        operatorAgentId: submittedDraft.operatorAgentId,
        nodeId,
        nodeIdentityId: result.agentId?.toString(),
        txHash: registrationHash,
      })
    })
  }, [
    processedRegistrationHash,
    registerNodeIdentity,
    registrationHash,
    registrationReceipt,
    submittedDraft,
    useGasless,
  ])

  useEffect(() => {
    if (nodeRegistrationResult) {
      setStep('complete')
    }
  }, [nodeRegistrationResult])

  const steps: Array<{ key: RegistrationStep; label: string }> = [
    { key: 'identity', label: 'Identity' },
    { key: 'services', label: 'Services' },
    { key: 'stake', label: 'Stake & Node Details' },
    { key: 'confirm', label: 'Confirm' },
    { key: 'complete', label: 'Complete' },
  ]

  const currentStepIndex = steps.findIndex(({ key }) => key === step)
  const selectedOperatorReady =
    parsedOperatorAgentId !== null && parsedOperatorAgentId !== undefined
  const identityStepReady = Boolean(gasless.ownerAddress) && selectedOperatorReady
  const stakeStepReady =
    Boolean(stakingToken) &&
    Boolean(rewardToken) &&
    parsedStakeAmount > 0n &&
    stakeValueUSD >= minStakeUSD &&
    rpcUrl.startsWith('http') &&
    isOwnershipVerified

  const handleNextStep = () => {
    setSubmitError(null)

    if (step === 'identity') {
      if (!identityStepReady) {
        setSubmitError('Connect the operator wallet and select an identity first.')
        return
      }
      setStep('services')
      return
    }

    if (step === 'services') {
      if (selectedServices.length === 0) {
        setSubmitError('Select at least one service before continuing.')
        return
      }
      setStep('stake')
      return
    }

    if (step === 'stake') {
      if (!stakeStepReady) {
        setSubmitError(disabledReason ?? 'Complete the node details before continuing.')
        return
      }
      setStep('confirm')
    }
  }

  const handlePreviousStep = () => {
    setSubmitError(null)
    if (step === 'services') setStep('identity')
    if (step === 'stake') setStep('services')
    if (step === 'confirm') setStep('stake')
  }

  const renderIdentityStep = () => (
    <>
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
              Choose the operator identity that will control this node. You can
              finish paymaster prep later before the final on-chain submit.
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
        </div>

        {authorizeResult ? (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.9rem 1rem',
              borderRadius: '12px',
              border:
                authorizeResult.status === 'error'
                  ? '1px solid rgba(239, 68, 68, 0.35)'
                  : authorizeResult.status === 'success'
                    ? '1px solid rgba(34, 197, 94, 0.35)'
                    : '1px solid rgba(59, 130, 246, 0.35)',
              background:
                authorizeResult.status === 'error'
                  ? 'rgba(127, 29, 29, 0.2)'
                  : authorizeResult.status === 'success'
                    ? 'rgba(22, 101, 52, 0.15)'
                    : 'rgba(30, 64, 175, 0.15)',
              display: 'grid',
              gap: '0.4rem',
            }}
          >
            <div style={{ fontWeight: 700 }}>{authorizeResult.title}</div>
            <div style={{ fontSize: '0.9rem' }}>{authorizeResult.message}</div>
            {authorizeResult.txHash ? (
              <a
                href={`${EXPLORER_URL}/tx/${authorizeResult.txHash}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#93c5fd', fontSize: '0.85rem' }}
              >
                View transaction
              </a>
            ) : null}
          </div>
        ) : null}
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
          Operator Agent ID
        </label>
        {hasAgent ? (
          <select
            id="operator-agent-id"
            className="input"
            value={operatorAgentId}
            onChange={(e) => setOperatorAgentId(e.target.value)}
            disabled={isRegistering || !canAddMore || isAgentLoading}
          >
            <option value="">Select operator identity</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                Agent #{agent.id}
                {agent.name ? ` - ${agent.name}` : ''}
              </option>
            ))}
          </select>
        ) : (
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
        )}
        <p
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-secondary)',
            marginTop: '0.25rem',
          }}
        >
          {selectedOperatorAgent
            ? `Using Agent #${selectedOperatorAgent.id}${selectedOperatorAgent.name ? ` (${selectedOperatorAgent.name})` : ''} as the node operator.`
            : 'Choose the ERC-8004 operator identity that will own this node registration.'}
        </p>
      </div>
    </>
  )

  const renderServicesStep = () => (
    <div style={{ marginBottom: '1.5rem' }}>
      <label
        style={{
          display: 'block',
          marginBottom: '0.5rem',
          fontWeight: '600',
        }}
      >
        Services
      </label>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {NODE_SERVICE_DEFINITIONS.map((service) => {
          const selected = selectedServices.includes(service.id)

          return (
            <button
              key={service.id}
              type="button"
              onClick={() => toggleService(service.id)}
              className={selected ? 'button' : 'button button-secondary'}
              style={{
                textAlign: 'left',
                padding: '0.875rem',
                justifyContent: 'flex-start',
                height: '100%',
              }}
            >
              <span>
                <strong style={{ display: 'block' }}>{service.name}</strong>
                <span
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: selected ? 'inherit' : 'var(--text-secondary)',
                    marginTop: '0.25rem',
                  }}
                >
                  {service.description}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <p
        style={{
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          marginTop: '0.5rem',
        }}
      >
        Choose one or more services this node will provide. Minimum stake scales
        with the number of selected services.
      </p>
    </div>
  )

  const renderStakeStep = () => (
    <>
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
          label="Reward Token (what you want to earn)"
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
          htmlFor="node-name"
          style={{
            display: 'block',
            marginBottom: '0.5rem',
            fontWeight: '600',
          }}
        >
          Node Name
        </label>
        <input
          id="node-name"
          className="input"
          type="text"
          placeholder="My Storage Node"
          value={nodeName}
          onChange={(e) => setNodeName(e.target.value)}
          disabled={isRegistering || !canAddMore}
        />
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
      </div>

      <div
        style={{
          padding: '1rem',
          background: 'var(--surface-hover)',
          borderRadius: '8px',
          marginBottom: '1.5rem',
          border: isOwnershipVerified
            ? '1px solid var(--success)'
            : '1px solid var(--border)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            marginBottom: '0.75rem',
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>Ownership Proof</div>
            <div
              style={{
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
                marginTop: '0.25rem',
              }}
            >
              Bind this endpoint to a delegated node wallet before staking.
            </div>
          </div>
          {isOwnershipVerified && (
            <div style={{ color: 'var(--success)', fontWeight: 600 }}>
              Verified
            </div>
          )}
        </div>

        {proofChallenge ? (
          <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <div
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  marginBottom: '0.25rem',
                }}
              >
                Delegated Node Wallet
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>
                {proofChallenge.nodeWalletAddress}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  marginBottom: '0.25rem',
                }}
              >
                Proof Document
              </div>
              <a href={proofChallenge.proofUrl} target="_blank" rel="noreferrer">
                {proofChallenge.proofUrl}
              </a>
            </div>
            <div>
              <div
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  marginBottom: '0.25rem',
                }}
              >
                Agent Delegated Wallet
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>
                {proofChallenge.currentAgentWallet &&
                proofChallenge.currentAgentWallet !== ZERO_ADDRESS
                  ? proofChallenge.currentAgentWallet
                  : 'Set after authorization'}
              </div>
            </div>
          </div>
        ) : (
          <p
            style={{
              fontSize: '0.9rem',
              color: 'var(--text-secondary)',
              marginBottom: '1rem',
            }}
          >
            Prepare a challenge to discover the node wallet and bind it to your
            ERC-8004 operator identity.
          </p>
        )}

        {proofChallenge && !proofChallenge.delegatedWalletContractReady && (
          <div
            style={{
              padding: '0.875rem',
              background: 'var(--warning-soft)',
              borderRadius: '8px',
              color: 'var(--warning)',
              marginBottom: '1rem',
              fontSize: '0.9rem',
            }}
          >
            This deployment does not expose delegated wallet methods on the
            current identity registry yet.
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void prepareOwnershipProof()}
            disabled={!rpcUrl.startsWith('http') || isPreparingProof}
          >
            {isPreparingProof ? 'Preparing...' : 'Prepare Proof'}
          </button>

          {proofChallenge &&
            proofChallenge.delegatedWalletContractReady &&
            !nodeWalletAuthorized && (
              <button
                type="button"
                className="button"
                onClick={() => void authorizeNodeWallet()}
                disabled={
                  isAuthorizingNodeWallet ||
                  isSetAgentWalletPending ||
                  isSetAgentWalletConfirming
                }
              >
                {isAuthorizingNodeWallet ||
                isSetAgentWalletPending ||
                isSetAgentWalletConfirming
                  ? 'Authorizing...'
                  : 'Authorize Node Wallet'}
              </button>
            )}

          {proofChallenge &&
            proofChallenge.delegatedWalletContractReady &&
            nodeWalletAuthorized &&
            !isOwnershipVerified && (
              <button
                type="button"
                className="button"
                onClick={() => void verifyOwnershipProof()}
                disabled={isVerifyingProof || isSigningOperatorMessage}
              >
                {isVerifyingProof || isSigningOperatorMessage
                  ? 'Verifying...'
                  : 'Verify Endpoint Ownership'}
              </button>
            )}
        </div>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <label
          htmlFor="zone"
          style={{
            display: 'block',
            marginBottom: '0.5rem',
            fontWeight: '600',
          }}
        >
          Zone / Availability Area
        </label>
        <input
          id="zone"
          className="input"
          type="text"
          placeholder="us-east-1a"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          disabled={isRegistering || !canAddMore}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <div>
          <label
            htmlFor="cpu-cores"
            style={{ display: 'block', marginBottom: '0.5rem', fontWeight: '600' }}
          >
            CPU Cores
          </label>
          <input
            id="cpu-cores"
            className="input"
            type="number"
            min="0"
            step="1"
            placeholder="8"
            value={cpuCores}
            onChange={(e) => setCpuCores(e.target.value)}
            disabled={isRegistering || !canAddMore}
          />
        </div>
        <div>
          <label
            htmlFor="memory-gb"
            style={{ display: 'block', marginBottom: '0.5rem', fontWeight: '600' }}
          >
            Memory (GB)
          </label>
          <input
            id="memory-gb"
            className="input"
            type="number"
            min="0"
            step="1"
            placeholder="32"
            value={memoryGb}
            onChange={(e) => setMemoryGb(e.target.value)}
            disabled={isRegistering || !canAddMore}
          />
        </div>
        <div>
          <label
            htmlFor="disk-gb"
            style={{ display: 'block', marginBottom: '0.5rem', fontWeight: '600' }}
          >
            Disk (GB)
          </label>
          <input
            id="disk-gb"
            className="input"
            type="number"
            min="0"
            step="1"
            placeholder="1000"
            value={diskGb}
            onChange={(e) => setDiskGb(e.target.value)}
            disabled={isRegistering || !canAddMore}
          />
        </div>
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
      </div>

      {useGasless && gaslessSupportsSelectedToken && (
        <div
          style={{
            padding: '1rem',
            background: gaslessReadiness.isReady
              ? 'var(--success-soft)'
              : 'var(--warning-soft)',
            borderRadius: '8px',
            marginBottom: '1.5rem',
            border: `1px solid ${
              gaslessReadiness.isReady ? 'var(--success)' : 'var(--warning)'
            }`,
          }}
        >
          {gaslessReadiness.isReady ? (
            <p style={{ margin: 0, color: 'var(--success)' }}>
              Ready for JEJU gasless node registration via{' '}
              {gaslessReadiness.preferredPath === 'allowance'
                ? 'direct paymaster pull'
                : 'existing credit'}
              .
            </p>
          ) : (
            <>
              <p style={{ margin: 0, color: 'var(--warning)' }}>
                Prepare this smart account with enough JEJU for the node stake plus
                either paymaster allowance or JEJU credit before submitting.
              </p>
              <p style={{ margin: '0.5rem 0 0 0', color: 'var(--warning)' }}>
                Recommended JEJU on smart account:{' '}
                {formatUnits(gaslessReadiness.recommendedJejuBalance, 18)} JEJU
              </p>
            </>
          )}
        </div>
      )}
    </>
  )

  const renderConfirmStep = () => (
    <div
      style={{
        display: 'grid',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}
    >
      <div
        style={{
          padding: '1rem',
          background: 'var(--surface-hover)',
          borderRadius: '8px',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
          Operator Identity
        </div>
        <div>
          {selectedOperatorAgent
            ? `Agent #${selectedOperatorAgent.id}${selectedOperatorAgent.name ? ` - ${selectedOperatorAgent.name}` : ''}`
            : `Agent #${parsedOperatorAgentId?.toString() ?? 'Unknown'}`}
        </div>
      </div>

      <div
        style={{
          padding: '1rem',
          background: 'var(--surface-hover)',
          borderRadius: '8px',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Services</div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {selectedServices.map((serviceId) => {
            const service = NODE_SERVICE_DEFINITIONS.find(
              (candidate) => candidate.id === serviceId,
            )
            return (
              <span
                key={serviceId}
                style={{
                  padding: '0.35rem 0.6rem',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  borderRadius: '999px',
                  fontSize: '0.85rem',
                }}
              >
                {service?.name ?? serviceId}
              </span>
            )
          })}
        </div>
      </div>

      <div
        style={{
          padding: '1rem',
          background: 'var(--surface-hover)',
          borderRadius: '8px',
          display: 'grid',
          gap: '0.5rem',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
          Stake & Node Details
        </div>
        <div>
          <strong>Stake:</strong> {stakeAmount || '0'} {stakingToken?.symbol}
        </div>
        <div>
          <strong>Reward token:</strong> {rewardToken?.symbol ?? 'Unselected'}
        </div>
        <div>
          <strong>RPC URL:</strong> {rpcUrl}
        </div>
        <div>
          <strong>Region:</strong> {REGION_NAMES[region] ?? 'Unknown'}
        </div>
        {nodeName && (
          <div>
            <strong>Node name:</strong> {nodeName}
          </div>
        )}
        {zone && (
          <div>
            <strong>Zone:</strong> {zone}
          </div>
        )}
      </div>
    </div>
  )

  const renderCompleteStep = () => (
    <div
      style={{
        display: 'grid',
        gap: '1rem',
      }}
    >
      <div
        style={{
          padding: '1rem',
          background: 'var(--success-soft)',
          borderRadius: '8px',
        }}
      >
        <p style={{ color: 'var(--success)', margin: 0 }}>
          ✅ Node registered successfully!
          {nodeRegistrationResult?.nodeIdentityId
            ? ` Node Identity #${nodeRegistrationResult.nodeIdentityId} is linked to ${nodeRegistrationResult.nodeId}.`
            : ''}
        </p>
      </div>

      {nodeIdentityError && (
        <div
          style={{
            padding: '1rem',
            background: 'var(--warning-soft)',
            borderRadius: '8px',
          }}
        >
          <p style={{ color: 'var(--warning)', margin: 0 }}>
            {nodeIdentityError}
          </p>
        </div>
      )}
    </div>
  )

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
            display: 'grid',
            gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
            gap: '0.5rem',
            marginBottom: '1.5rem',
          }}
        >
          {steps.map(({ key, label }, index) => {
            const isActive = key === step
            const isComplete = currentStepIndex > index
            return (
              <div
                key={key}
                style={{
                  padding: '0.75rem',
                  borderRadius: '8px',
                  background: isActive
                    ? 'var(--accent-soft)'
                    : isComplete
                      ? 'var(--success-soft)'
                      : 'var(--surface-hover)',
                  border: `1px solid ${
                    isActive
                      ? 'var(--accent)'
                      : isComplete
                        ? 'var(--success)'
                        : 'var(--border)'
                  }`,
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {index + 1}
                </div>
                <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{label}</div>
              </div>
            )
          })}
        </div>

        {step === 'identity' && renderIdentityStep()}
        {step === 'services' && renderServicesStep()}
        {step === 'stake' && renderStakeStep()}
        {step === 'confirm' && renderConfirmStep()}
        {step === 'complete' && renderCompleteStep()}

        {isRegisteringNodeIdentity && (
          <div
            style={{
              padding: '1rem',
              background: 'var(--primary-soft)',
              borderRadius: '8px',
              marginBottom: '1rem',
            }}
          >
            <p style={{ color: 'var(--primary)', margin: 0 }}>
              Linking a dedicated node identity and persisting selected services...
            </p>
          </div>
        )}

        {nodeIdentityError && (
          <div
            style={{
              padding: '1rem',
              background: 'var(--warning-soft)',
              borderRadius: '8px',
              marginBottom: '1rem',
            }}
          >
            <p style={{ color: 'var(--warning)', margin: 0 }}>
              {nodeIdentityError}
            </p>
          </div>
        )}

        {submitError && (
          <div
            style={{
              padding: '1rem',
              background: 'var(--error-soft)',
              borderRadius: '8px',
              marginBottom: '1rem',
            }}
          >
            <p style={{ color: 'var(--error)', margin: 0 }}>{submitError}</p>
          </div>
        )}

        {step !== 'complete' && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '1rem',
              marginTop: '1.5rem',
            }}
          >
            <button
              type="button"
              className="button button-secondary"
              disabled={step === 'identity' || isRegistering}
              onClick={handlePreviousStep}
            >
              Back
            </button>

            {step === 'confirm' ? (
              <button
                type="submit"
                className="button"
                disabled={!isValid || isRegistering || !!disabledReason}
              >
                {isRegistering
                  ? 'Staking & Registering...'
                  : useGasless
                    ? 'Stake & Register Node (JEJU gasless)'
                    : 'Stake & Register Node'}
              </button>
            ) : (
              <button
                type="button"
                className="button"
                onClick={handleNextStep}
                disabled={isRegistering}
              >
                Continue
              </button>
            )}
          </div>
        )}
      </form>
      {authorizeResult ? (
        <TransactionStatusModal
          result={authorizeResult}
          onClose={() => setAuthorizeResult(null)}
        />
      ) : null}
    </div>
  )
}
