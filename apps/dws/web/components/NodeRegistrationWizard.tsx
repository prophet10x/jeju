/**
 * Node Registration Wizard
 *
 * Multi-step wizard for registering a new node on the Jeju Network.
 * Uses wagmi's useWriteContract for actual on-chain transactions.
 */

import {
  DEFAULT_GASLESS_PAYMENT_AMOUNT,
  describeNodeRegistrationError,
  fetchAgentWallet,
  getNodeRegisteredIdFromReceipt,
  JEJU_NODE_REGISTRATION_SERVICE,
  NODE_SERVICE_DEFINITIONS,
  type NodeIdentityMetadata,
  type NodeRegistrationDraft,
  type NodeRegistrationResult,
  type NodeServiceDefinition,
  type NodeServiceId,
  waitForAgentWallet,
} from '@jejunetwork/shared'
import { ZERO_ADDRESS } from '@jejunetwork/types'
import {
  Region,
  type RegionValue,
  useNodeStaking,
} from '@jejunetwork/ui/hooks/useNodeStaking'
import {
  TransactionStatusModal,
  type TransactionStatusResult,
  useWallet,
} from '@jejunetwork/ui/wallet'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Box,
  Check,
  Coins,
  Cpu,
  Database,
  ExternalLink,
  Eye,
  GitBranch,
  Globe,
  HardDrive,
  Layers,
  Loader2,
  Lock,
  Mail,
  Monitor,
  Package,
  Play,
  Radio,
  Scale,
  Search,
  Server,
  Shield,
  Wallet,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type Address, encodeFunctionData, erc20Abi, formatEther } from 'viem'
import {
  usePublicClient,
  useSignMessage,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { CONTRACTS, EXPLORER_URL } from '../config'
import { useAgentId } from '../hooks/useAgentId'
import { useGaslessBootstrap } from '../hooks/useGaslessBootstrap'
import { useGaslessSmartAccount } from '../hooks/useGaslessSmartAccount'
import { useNodeIdentityRegistry } from '../hooks/useNodeIdentityRegistry'

type WizardStep =
  | 'connect'
  | 'services'
  | 'stake'
  | 'approve'
  | 'confirm'
  | 'complete'

interface ServiceOption {
  id: string
  name: string
  icon: React.ReactNode
  description: string
  selected: boolean
}

const SERVICE_ICONS: Record<NodeServiceDefinition['icon'], React.ReactNode> = {
  shield: <Shield size={20} />,
  globe: <Globe size={20} />,
  'hard-drive': <HardDrive size={20} />,
  radio: <Radio size={20} />,
  cpu: <Cpu size={20} />,
  monitor: <Monitor size={20} />,
  zap: <Zap size={20} />,
  box: <Box size={20} />,
  bot: <Bot size={20} />,
  'git-branch': <GitBranch size={20} />,
  package: <Package size={20} />,
  play: <Play size={20} />,
  database: <Database size={20} />,
  layers: <Layers size={20} />,
  mail: <Mail size={20} />,
  scale: <Scale size={20} />,
  search: <Search size={20} />,
  eye: <Eye size={20} />,
  lock: <Lock size={20} />,
}

function createDefaultServices(): ServiceOption[] {
  return NODE_SERVICE_DEFINITIONS.map((service) => ({
    id: service.id,
    name: service.name,
    description: service.description,
    icon: SERVICE_ICONS[service.icon],
    selected: false,
  }))
}

// Token addresses from config - use JEJU token for staking and rewards
import { TOKENS } from '../config'

// Use configured token addresses, falling back to zero address if not configured
const DEFAULT_STAKING_TOKEN = TOKENS.jeju
const DEFAULT_REWARD_TOKEN = TOKENS.jeju

function formatStakeAmount(wei: bigint): string {
  const value = Number(formatEther(wei))
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K JEJU`
  if (value >= 1) return `${value.toFixed(0)} JEJU`
  return `${value.toFixed(2)} JEJU`
}

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

const NODE_STAKING_REGISTRATION_ABI = [
  {
    name: 'registerNode',
    type: 'function',
    inputs: [
      { name: 'stakingToken', type: 'address' },
      { name: 'stakeAmount', type: 'uint256' },
      { name: 'rewardToken', type: 'address' },
      { name: 'rpcUrl', type: 'string' },
      { name: 'region', type: 'uint8' },
    ],
    outputs: [{ name: 'nodeId', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'registerNodeWithAgent',
    type: 'function',
    inputs: [
      { name: 'stakingToken', type: 'address' },
      { name: 'stakeAmount', type: 'uint256' },
      { name: 'rewardToken', type: 'address' },
      { name: 'rpcUrl', type: 'string' },
      { name: 'region', type: 'uint8' },
      { name: 'operatorAgentId', type: 'uint256' },
    ],
    outputs: [{ name: 'nodeId', type: 'bytes32' }],
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

export default function NodeRegistrationWizard() {
  const { address, isConnected, isConnecting, connect } = useWallet()
  const publicClient = usePublicClient()
  const { hasAgent, agentId, agents, isLoading: isAgentLoading } = useAgentId()
  const gasless = useGaslessSmartAccount()
  const gaslessBootstrap = useGaslessBootstrap({ gasless })
  const { registerNodeIdentity } = useNodeIdentityRegistry()

  // Get staking manager address from config
  const stakingManagerAddress =
    CONTRACTS.nodeStakingManagerV2 !== ZERO_ADDRESS
      ? CONTRACTS.nodeStakingManagerV2
      : CONTRACTS.nodeStakingManager !== ZERO_ADDRESS
        ? CONTRACTS.nodeStakingManager
        : undefined

  // Use the real staking hook
  const {
    minStakeUSD,
    baseRewardPerMonthUSD,
    approveStaking,
    isApproving,
    isApprovalSuccess,
    approvalHash,
    registerNode,
    isRegistering,
    registrationHash,
  } = useNodeStaking(stakingManagerAddress, address)
  const { data: registrationReceipt } = useWaitForTransactionReceipt({
    hash: registrationHash,
  })

  const [step, setStep] = useState<WizardStep>('connect')
  const [services, setServices] = useState<ServiceOption[]>(() =>
    createDefaultServices(),
  )
  const [error, setError] = useState<string | null>(null)
  const [selectedRegion, setSelectedRegion] = useState<RegionValue>(
    Region.NorthAmerica,
  )
  const [nodeRpcUrl, setNodeRpcUrl] = useState('')
  const [nodeName, setNodeName] = useState('')
  const [zone, setZone] = useState('')
  const [cpuCores, setCpuCores] = useState('')
  const [memoryGb, setMemoryGb] = useState('')
  const [diskGb, setDiskGb] = useState('')
  const [customStakeAmount, setCustomStakeAmount] = useState('')
  const [useGasless, setUseGasless] = useState(true)
  const [selectedAgentIdState, setSelectedAgentIdState] = useState<
    number | null
  >(null)
  const [proofChallenge, setProofChallenge] =
    useState<NodeProofChallenge | null>(null)
  const [proofVerification, setProofVerification] =
    useState<NodeProofVerification | null>(null)
  const [isPreparingProof, setIsPreparingProof] = useState(false)
  const [isVerifyingProof, setIsVerifyingProof] = useState(false)
  const [isAuthorizingNodeWallet, setIsAuthorizingNodeWallet] = useState(false)
  const [authorizeResult, setAuthorizeResult] =
    useState<TransactionStatusResult | null>(null)
  const [lastRegistrationHash, setLastRegistrationHash] = useState<
    `0x${string}` | undefined
  >()
  const [submittedDraft, setSubmittedDraft] =
    useState<NodeRegistrationDraft | null>(null)
  const [processedRegistrationHash, setProcessedRegistrationHash] = useState<
    `0x${string}` | null
  >(null)
  const [nodeRegistrationResult, setNodeRegistrationResult] =
    useState<NodeRegistrationResult | null>(null)
  const [nodeIdentityError, setNodeIdentityError] = useState<string | null>(
    null,
  )
  const [isRegisteringNodeIdentity, setIsRegisteringNodeIdentity] =
    useState(false)

  const {
    writeContract: writeSetAgentWallet,
    data: setAgentWalletHash,
    isPending: isSetAgentWalletPending,
  } = useWriteContract()
  const {
    isLoading: isSetAgentWalletConfirming,
    isSuccess: isSetAgentWalletSuccess,
  } = useWaitForTransactionReceipt({ hash: setAgentWalletHash })
  const { signMessageAsync, isPending: isSigningOperatorMessage } =
    useSignMessage()

  const selectedServices = services.filter((s) => s.selected)
  const selectedServiceIds = useMemo(
    () => selectedServices.map((service) => service.id as NodeServiceId),
    [selectedServices],
  )
  const selectedAgent =
    selectedAgentIdState !== null
      ? agents.find(
          (candidate) => Number(candidate.id) === selectedAgentIdState,
        )
      : undefined
  const selectedAgentId =
    selectedAgentIdState !== null ? BigInt(selectedAgentIdState) : undefined
  const selectedAgentOwnedBySmartAccount = useMemo(
    () =>
      Boolean(
        selectedAgent?.owner &&
          gasless.smartAccountAddress &&
          selectedAgent.owner.toLowerCase() ===
            gasless.smartAccountAddress.toLowerCase(),
      ),
    [gasless.smartAccountAddress, selectedAgent?.owner],
  )
  const nodeWalletAuthorized =
    proofChallenge !== null &&
    proofChallenge.currentAgentWallet !== null &&
    proofChallenge.currentAgentWallet.toLowerCase() ===
      proofChallenge.nodeWalletAddress.toLowerCase()
  const isOwnershipVerified =
    proofVerification !== null &&
    proofVerification.challengeId === proofChallenge?.challengeId
  const normalizedNodeRpcUrl = nodeRpcUrl.trim()

  // Calculate minimum required stake from contract's minStakeUSD
  const minimumStake = useMemo(() => {
    if (!minStakeUSD) return BigInt(0)
    return minStakeUSD * BigInt(Math.max(selectedServices.length, 1))
  }, [minStakeUSD, selectedServices.length])

  // Actual stake: custom amount if set and >= minimum, otherwise minimum
  const requiredStake = useMemo(() => {
    if (customStakeAmount) {
      try {
        const customWei = BigInt(
          Math.floor(parseFloat(customStakeAmount) * 1e18),
        )
        if (customWei >= minimumStake) return customWei
      } catch {
        /* fall through to minimum */
      }
    }
    return minimumStake
  }, [customStakeAmount, minimumStake])

  // Calculate estimated reward from contract's baseRewardPerMonthUSD
  const estimatedMonthlyReward = useMemo(() => {
    if (!baseRewardPerMonthUSD) return '$0'
    const perService = Number(formatEther(baseRewardPerMonthUSD))
    const total = perService * selectedServices.length
    return `~$${total.toFixed(0)}`
  }, [baseRewardPerMonthUSD, selectedServices.length])
  const gaslessReadiness = gasless.getReadiness(
    requiredStake,
    DEFAULT_GASLESS_PAYMENT_AMOUNT,
  )
  const effectiveRegistrationHash = useGasless
    ? lastRegistrationHash
    : registrationHash
  const effectiveRegistrationReceipt = useGasless
    ? gasless.lastTransactionReceipt
    : registrationReceipt

  useEffect(() => {
    if (!agents.length) {
      setSelectedAgentIdState(null)
      return
    }

    setSelectedAgentIdState((current) => {
      if (
        current !== null &&
        agents.some((candidate) => Number(candidate.id) === current)
      ) {
        return current
      }

      return agentId ?? Number(agents[0].id)
    })
  }, [agentId, agents])

  const toggleService = useCallback((serviceId: string) => {
    setServices((prev) =>
      prev.map((s) =>
        s.id === serviceId ? { ...s, selected: !s.selected } : s,
      ),
    )
  }, [])

  const selectAllServices = useCallback(() => {
    setServices((prev) =>
      prev.map((service) => ({ ...service, selected: true })),
    )
  }, [])

  const clearAllServices = useCallback(() => {
    setServices((prev) =>
      prev.map((service) => ({ ...service, selected: false })),
    )
  }, [])

  const handleNextStep = useCallback(() => {
    setError(null)
    if (step === 'connect' && isConnected) {
      if (isAgentLoading) {
        setError('Checking your ERC-8004 operator identity. Please wait.')
        return
      }
      if (!hasAgent || selectedAgentId === undefined) {
        setError(
          'Node registration now requires an ERC-8004 operator identity. Create or connect an agent identity first.',
        )
        return
      }
      setStep('services')
    } else if (step === 'services' && selectedServices.length > 0) {
      setStep('stake')
    } else if (step === 'stake') {
      if (!isOwnershipVerified) {
        setError(
          'Verify delegated node ownership at the claimed endpoint before continuing.',
        )
        return
      }
      setStep(useGasless ? 'confirm' : 'approve')
    } else if (step === 'approve' && isApprovalSuccess) {
      setStep('confirm')
    }
  }, [
    step,
    hasAgent,
    isAgentLoading,
    isApprovalSuccess,
    isConnected,
    isOwnershipVerified,
    selectedAgentId,
    selectedServices.length,
    useGasless,
  ])

  const handlePrevStep = useCallback(() => {
    setError(null)
    if (step === 'services') {
      setStep('connect')
    } else if (step === 'stake') {
      setStep('services')
    } else if (step === 'approve') {
      setStep('stake')
    } else if (step === 'confirm') {
      setStep(useGasless ? 'stake' : 'approve')
    }
  }, [step, useGasless])

  const handleApprove = useCallback(() => {
    if (!stakingManagerAddress) {
      setError('Staking manager not configured for this network')
      return
    }
    if (DEFAULT_STAKING_TOKEN === ZERO_ADDRESS) {
      setError('Staking token not configured')
      return
    }
    setError(null)
    approveStaking(DEFAULT_STAKING_TOKEN, requiredStake)
  }, [stakingManagerAddress, requiredStake, approveStaking])

  const handleRegister = useCallback(async () => {
    if (!stakingManagerAddress) {
      setError('Staking manager not configured for this network')
      return
    }
    if (!normalizedNodeRpcUrl) {
      setError('Please enter your node RPC URL')
      return
    }
    if (selectedAgentId === undefined) {
      setError(
        'An ERC-8004 operator identity is required before you can register a node.',
      )
      return
    }
    setError(null)
    setNodeIdentityError(null)
    setNodeRegistrationResult(null)

    const nextDraft: NodeRegistrationDraft = {
      operatorAgentId: selectedAgentId.toString(),
      services: selectedServiceIds,
      stakeAmount: requiredStake.toString(),
      stakingToken: DEFAULT_STAKING_TOKEN,
      rewardToken: DEFAULT_REWARD_TOKEN,
      rpcUrl: normalizedNodeRpcUrl,
      region:
        [
          [Region.NorthAmerica, 'North America'],
          [Region.SouthAmerica, 'South America'],
          [Region.Europe, 'Europe'],
          [Region.Asia, 'Asia'],
          [Region.Africa, 'Africa'],
          [Region.Oceania, 'Oceania'],
          [Region.Global, 'Global'],
        ].find(([value]) => value === selectedRegion)?.[1] ?? 'Unknown',
      nodeName: nodeName.trim() || undefined,
      zone: zone.trim() || undefined,
      cpuCores: cpuCores ? Number(cpuCores) : undefined,
      memoryGb: memoryGb ? Number(memoryGb) : undefined,
      diskGb: diskGb ? Number(diskGb) : undefined,
    }

    setSubmittedDraft(nextDraft)

    if (useGasless) {
      if (!gaslessReadiness.isReady) {
        setError(
          'Prepare this smart account with enough JEJU and either paymaster allowance or JEJU credit before using the gasless path.',
        )
        return
      }
      try {
        const txHash = await gasless.executeGaslessCalls({
          serviceName: JEJU_NODE_REGISTRATION_SERVICE,
          requiredJejuBalance: requiredStake,
          calls: [
            {
              to: DEFAULT_STAKING_TOKEN,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [stakingManagerAddress, requiredStake],
              }),
            },
            {
              to: stakingManagerAddress,
              data: encodeFunctionData({
                abi: NODE_STAKING_REGISTRATION_ABI,
                functionName: 'registerNodeWithAgent',
                args: [
                  DEFAULT_STAKING_TOKEN,
                  requiredStake,
                  DEFAULT_REWARD_TOKEN,
                  normalizedNodeRpcUrl,
                  selectedRegion,
                  selectedAgentId,
                ],
              }),
            },
          ],
        })
        setLastRegistrationHash(txHash)
        return
      } catch (registrationError) {
        setError(
          describeNodeRegistrationError(
            registrationError,
            'Gasless registration failed',
          ),
        )
        return
      }
    }

    setLastRegistrationHash(undefined)
    try {
      registerNode({
        stakingToken: DEFAULT_STAKING_TOKEN,
        stakeAmount: requiredStake,
        rewardToken: DEFAULT_REWARD_TOKEN,
        rpcUrl: normalizedNodeRpcUrl,
        region: selectedRegion,
        operatorAgentId: selectedAgentId,
      })
    } catch (registrationError) {
      setError(describeNodeRegistrationError(registrationError))
    }
  }, [
    stakingManagerAddress,
    normalizedNodeRpcUrl,
    selectedAgentId,
    requiredStake,
    selectedRegion,
    registerNode,
    selectedServiceIds,
    gasless,
    gaslessReadiness.isReady,
    useGasless,
    cpuCores,
    diskGb,
    memoryGb,
    nodeName,
    zone,
  ])

  const prepareOwnershipProof = useCallback(async () => {
    const blockPrepare = (message: string) => {
      setError(message)
      setAuthorizeResult({
        status: 'error',
        title: 'Prepare proof blocked',
        message,
        explorerUrl: EXPLORER_URL,
      })
    }

    if (!address || selectedAgentId === undefined) {
      blockPrepare('Connect the operator wallet and select an agent first.')
      return
    }
    if (!normalizedNodeRpcUrl) {
      blockPrepare('Enter the node endpoint URL before preparing proof.')
      return
    }
    let endpoint: URL
    try {
      endpoint = new URL(normalizedNodeRpcUrl)
    } catch {
      blockPrepare('Enter a valid node endpoint URL (including https://).')
      return
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      blockPrepare('Node endpoint URL must start with http:// or https://.')
      return
    }

    setError(null)
    setAuthorizeResult({
      status: 'info',
      title: 'Preparing proof',
      message: 'Requesting ownership challenge from the registration backend.',
      explorerUrl: EXPLORER_URL,
    })
    setIsPreparingProof(true)
    setProofVerification(null)

    try {
      const response = await fetch('/node-registration/challenge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: normalizedNodeRpcUrl,
          operatorAddress: address,
          operatorAgentId: Number(selectedAgentId),
        }),
      })

      const rawPayload = await response.text()
      let payload: NodeProofChallenge | { error?: string } | null = null
      if (rawPayload) {
        try {
          payload = JSON.parse(rawPayload) as
            | NodeProofChallenge
            | { error?: string }
        } catch {
          throw new Error(
            response.ok
              ? 'Challenge endpoint returned invalid JSON.'
              : `Prepare proof failed (HTTP ${response.status}).`,
          )
        }
      }

      if (payload && 'error' in payload) {
        throw new Error(payload.error ?? 'Failed to prepare node proof')
      }
      if (!response.ok) {
        throw new Error(
          `Failed to prepare node proof (HTTP ${response.status})`,
        )
      }

      if (!payload || !('challengeId' in payload)) {
        throw new Error('Challenge endpoint returned an unexpected response.')
      }

      const challengePayload = payload as NodeProofChallenge
      setProofChallenge(challengePayload)
    } catch (err) {
      setProofChallenge(null)
      const message =
        err instanceof Error ? err.message : 'Failed to prepare proof'
      setAuthorizeResult({
        status: 'error',
        title: 'Prepare proof failed',
        message,
        explorerUrl: EXPLORER_URL,
      })
      setError(message)
    } finally {
      setIsPreparingProof(false)
    }
  }, [address, normalizedNodeRpcUrl, selectedAgentId])

  const authorizeNodeWallet = useCallback(async () => {
    if (!proofChallenge || selectedAgentId === undefined) {
      setError('Prepare the node proof challenge first.')
      return
    }
    if (CONTRACTS.identityRegistry === ZERO_ADDRESS) {
      setError('Identity registry not configured for this network.')
      return
    }

    setError(null)
    if (selectedAgentOwnedBySmartAccount) {
      if (!publicClient) {
        setError('Public client is not available.')
        return
      }

      setIsAuthorizingNodeWallet(true)

      try {
        const txHash = await gasless.executeGaslessCalls({
          serviceName: JEJU_NODE_REGISTRATION_SERVICE,
          calls: [
            {
              to: CONTRACTS.identityRegistry,
              data: encodeFunctionData({
                abi: IDENTITY_REGISTRY_ABI,
                functionName: 'setAgentWallet',
                args: [selectedAgentId, proofChallenge.nodeWalletAddress],
              }),
            },
          ],
        })

        setAuthorizeResult({
          status: 'info',
          title: 'Authorization submitted',
          message: 'Waiting for on-chain confirmation.',
          txHash,
          explorerUrl: EXPLORER_URL,
        })
        const resolvedWallet = await waitForAgentWallet({
          publicClient,
          registryAddress: CONTRACTS.identityRegistry,
          agentId: selectedAgentId,
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
          txHash,
          explorerUrl: EXPLORER_URL,
        })
      } catch (err) {
        setAuthorizeResult({
          status: 'error',
          title: 'Authorization failed',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to authorize node wallet',
          explorerUrl: EXPLORER_URL,
        })
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to authorize node wallet',
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
      args: [selectedAgentId, proofChallenge.nodeWalletAddress],
    })
  }, [
    gasless,
    proofChallenge,
    publicClient,
    selectedAgentId,
    selectedAgentOwnedBySmartAccount,
    writeSetAgentWallet,
  ])

  const verifyOwnershipProof = useCallback(async () => {
    if (!proofChallenge || selectedAgentId === undefined || !publicClient) {
      setError('Prepare the node proof challenge first.')
      return
    }

    setError(null)
    setIsVerifyingProof(true)

    try {
      setAuthorizeResult({
        status: 'info',
        title: 'Signature requested',
        message:
          'Approve the verification signature in your wallet to continue.',
        explorerUrl: EXPLORER_URL,
      })

      const operatorSignature = await signMessageAsync({
        message: proofChallenge.operatorMessage,
      })

      setAuthorizeResult({
        status: 'info',
        title: 'Verification submitted',
        message: 'Submitting endpoint ownership proof for verification.',
        explorerUrl: EXPLORER_URL,
      })

      const response = await fetch('/node-registration/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          challengeId: proofChallenge.challengeId,
          operatorSignature,
        }),
      })

      const rawPayload = await response.text()
      let payload: NodeProofVerification | { error?: string } | null = null
      if (rawPayload) {
        try {
          payload = JSON.parse(rawPayload) as
            | NodeProofVerification
            | { error?: string }
        } catch {
          throw new Error(
            response.ok
              ? 'Verify endpoint returned invalid JSON.'
              : `Failed to verify node proof (HTTP ${response.status}).`,
          )
        }
      }

      if (payload && 'error' in payload) {
        throw new Error(payload.error ?? 'Failed to verify node proof')
      }
      if (!response.ok) {
        throw new Error(`Failed to verify node proof (HTTP ${response.status})`)
      }

      if (!payload || !('verified' in payload)) {
        throw new Error('Verify endpoint returned an unexpected response.')
      }

      const verificationPayload = payload as NodeProofVerification

      const onChainAgentWallet = await fetchAgentWallet({
        publicClient,
        registryAddress: CONTRACTS.identityRegistry,
        agentId: selectedAgentId,
      })

      setProofVerification(verificationPayload)
      setProofChallenge((current) =>
        current
          ? {
              ...current,
              currentAgentWallet: onChainAgentWallet,
              requiresDelegatedWalletUpdate:
                !onChainAgentWallet ||
                onChainAgentWallet.toLowerCase() !==
                  verificationPayload.nodeWalletAddress.toLowerCase(),
            }
          : current,
      )
      setAuthorizeResult({
        status: 'success',
        title: 'Endpoint ownership verified',
        message: 'Proof document and operator authorization were verified.',
        explorerUrl: EXPLORER_URL,
      })
    } catch (err) {
      setProofVerification(null)
      const message =
        err instanceof Error ? err.message : 'Failed to verify proof'
      setAuthorizeResult({
        status: 'error',
        title: 'Verification failed',
        message,
        explorerUrl: EXPLORER_URL,
      })
      setError(message)
    } finally {
      setIsVerifyingProof(false)
    }
  }, [proofChallenge, publicClient, selectedAgentId, signMessageAsync])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset proof state when endpoint/operator selection changes
  useEffect(() => {
    setProofChallenge(null)
    setProofVerification(null)
  }, [nodeRpcUrl, selectedAgentId])

  useEffect(() => {
    if (!setAgentWalletHash || selectedAgentOwnedBySmartAccount) return

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
  }, [selectedAgentOwnedBySmartAccount, setAgentWalletHash])

  useEffect(() => {
    if (
      !isSetAgentWalletSuccess ||
      !publicClient ||
      selectedAgentId === undefined ||
      !proofChallenge ||
      selectedAgentOwnedBySmartAccount
    ) {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        const resolvedWallet = await waitForAgentWallet({
          publicClient,
          registryAddress: CONTRACTS.identityRegistry,
          agentId: selectedAgentId,
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
      } catch (err) {
        if (cancelled) return
        const message =
          err instanceof Error
            ? err.message
            : 'Failed to confirm delegated wallet authorization'
        setAuthorizeResult({
          status: 'error',
          title: 'Authorization failed',
          message,
          txHash: setAgentWalletHash,
          explorerUrl: EXPLORER_URL,
        })
        setError(message)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    isSetAgentWalletSuccess,
    proofChallenge,
    publicClient,
    selectedAgentId,
    selectedAgentOwnedBySmartAccount,
    setAgentWalletHash,
  ])

  // Auto-advance when approval succeeds
  useEffect(() => {
    if (!useGasless && step === 'approve' && isApprovalSuccess) {
      setStep('confirm')
    }
  }, [step, isApprovalSuccess, useGasless])

  useEffect(() => {
    if (step === 'confirm' && nodeRegistrationResult) {
      setStep('complete')
      return
    }

    if (step === 'confirm' && nodeIdentityError && processedRegistrationHash) {
      setStep('complete')
    }
  }, [
    step,
    nodeRegistrationResult,
    nodeIdentityError,
    processedRegistrationHash,
  ])

  useEffect(() => {
    if (
      !effectiveRegistrationHash ||
      !effectiveRegistrationReceipt ||
      !submittedDraft
    ) {
      return
    }
    if (processedRegistrationHash === effectiveRegistrationHash) return

    const nodeId = getNodeRegisteredIdFromReceipt(effectiveRegistrationReceipt)
    setProcessedRegistrationHash(effectiveRegistrationHash)

    if (!nodeId) {
      setNodeIdentityError(
        'Node staking transaction succeeded, but the node ID could not be decoded from the receipt. Refresh your nodes view and explorer to confirm on-chain state.',
      )
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
    void registerNodeIdentity(metadata, { gasless: useGasless }).then(
      (result) => {
        setIsRegisteringNodeIdentity(false)

        if (!result.success) {
          setNodeIdentityError(
            result.error ??
              'Node identity registration failed after staking succeeded.',
          )
          return
        }

        setNodeRegistrationResult({
          operatorAgentId: submittedDraft.operatorAgentId,
          nodeId,
          nodeIdentityId: result.agentId?.toString(),
          txHash: effectiveRegistrationHash,
        })
      },
    )
  }, [
    effectiveRegistrationHash,
    effectiveRegistrationReceipt,
    processedRegistrationHash,
    registerNodeIdentity,
    submittedDraft,
    useGasless,
  ])

  const renderStepIndicator = () => {
    const steps: { key: WizardStep; label: string }[] = [
      { key: 'connect', label: 'Connect' },
      { key: 'services', label: 'Services' },
      { key: 'stake', label: 'Stake' },
      { key: 'confirm', label: 'Register' },
    ]

    if (!useGasless) {
      steps.splice(3, 0, { key: 'approve', label: 'Approve' })
    }

    const currentIndex = steps.findIndex((s) => s.key === step)

    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '0.5rem',
          marginBottom: '2rem',
          flexWrap: 'wrap',
        }}
      >
        {steps.map((s, i) => {
          const isActive = s.key === step
          const isComplete = i < currentIndex || step === 'complete'

          return (
            <div
              key={s.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: isComplete
                    ? 'var(--success)'
                    : isActive
                      ? 'var(--accent)'
                      : 'var(--bg-tertiary)',
                  color: isComplete || isActive ? 'white' : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  transition: 'all 0.2s ease',
                }}
              >
                {isComplete ? <Check size={14} /> : i + 1}
              </div>
              <span
                style={{
                  fontSize: '0.85rem',
                  color: isActive
                    ? 'var(--text-primary)'
                    : 'var(--text-secondary)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {s.label}
              </span>
              {i < steps.length - 1 && (
                <div
                  style={{
                    width: '24px',
                    height: '2px',
                    background: isComplete ? 'var(--success)' : 'var(--border)',
                    borderRadius: '1px',
                    marginLeft: '0.5rem',
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // Check if staking manager is configured
  if (!stakingManagerAddress) {
    return (
      <div className="card" style={{ marginBottom: '2rem' }}>
        <div className="card-header">
          <h3 className="card-title">
            <Server size={18} /> Register Your Node
          </h3>
        </div>
        <div
          style={{
            padding: '2rem',
            textAlign: 'center',
            color: 'var(--text-secondary)',
          }}
        >
          <AlertCircle
            size={48}
            style={{ marginBottom: '1rem', color: 'var(--warning)' }}
          />
          <h4>Staking Not Available</h4>
          <p>
            Node staking contracts are not deployed on this network yet.
            <br />
            Please check back later or switch to a supported network.
          </p>
        </div>
      </div>
    )
  }

  const renderConnectStep = () => (
    <div style={{ textAlign: 'center', padding: '1rem' }}>
      {!isConnected && (
        <>
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.5rem',
            }}
          >
            <Wallet size={32} />
          </div>
          <h3 style={{ marginBottom: '0.75rem' }}>Connect Your Wallet</h3>
          <p
            style={{
              color: 'var(--text-secondary)',
              marginBottom: '1.5rem',
              maxWidth: '400px',
              margin: '0 auto 1.5rem',
            }}
          >
            Connect your Ethereum wallet to register your node. Your wallet will
            receive all earnings from providing services.
          </p>
        </>
      )}

      {isConnected ? (
        <div
          style={{
            padding: '1rem',
            background: 'var(--success-soft)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1.5rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              color: 'var(--success)',
              marginBottom: '0.5rem',
            }}
          >
            <Check size={18} />
            <span style={{ fontWeight: 600 }}>Wallet Connected</span>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.9rem',
              color: 'var(--text-secondary)',
            }}
          >
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </div>
          <div
            style={{
              marginTop: '0.75rem',
              fontSize: '0.9rem',
              color: hasAgent ? 'var(--success)' : 'var(--warning)',
            }}
          >
            {isAgentLoading
              ? 'Checking ERC-8004 operator identity...'
              : hasAgent && selectedAgentIdState !== null
                ? `Linked ERC-8004 operator identity: Agent #${selectedAgentIdState}`
                : 'No ERC-8004 operator identity found for this wallet yet.'}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => connect()}
          disabled={isConnecting}
          style={{ padding: '0.875rem 2rem' }}
        >
          {isConnecting ? (
            <>
              <Loader2 size={18} className="animate-spin" />
              Connecting...
            </>
          ) : (
            <>
              <Wallet size={18} />
              Connect Wallet
            </>
          )}
        </button>
      )}

      {isConnected && (
        <div
          style={{
            margin: '1.5rem auto 0',
            maxWidth: '560px',
            textAlign: 'left',
            padding: '1rem',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
          }}
        >
          {hasAgent && agents.length > 0 && (
            <div style={{ marginBottom: '1rem', textAlign: 'left' }}>
              <div
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                }}
              >
                Operator identity
              </div>
              <select
                value={selectedAgentIdState ?? ''}
                onChange={(event) =>
                  setSelectedAgentIdState(
                    event.target.value ? Number(event.target.value) : null,
                  )
                }
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                }}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    Agent #{agent.id}
                    {agent.name ? ` - ${agent.name}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

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
              <div style={{ fontWeight: 600 }}>
                JEJU gasless node registration
              </div>
              <div
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '0.9rem',
                  marginTop: '0.25rem',
                }}
              >
                Use your SimpleAccount for both JEJU stake and gas.
              </div>
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
                onChange={(event) => setUseGasless(event.target.checked)}
              />
              Use JEJU gasless flow
            </label>
          </div>

          <div
            style={{
              marginTop: '1rem',
              display: 'grid',
              gap: '0.4rem',
              fontSize: '0.9rem',
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
                : (gasless.smartAccountAddress ?? 'Unavailable')}
            </div>
            {gasless.smartAccountDerivationError && (
              <div style={{ color: 'var(--danger)' }}>
                <strong>Derivation error:</strong>{' '}
                {gasless.smartAccountDerivationError}
              </div>
            )}
            <div>
              <strong>SimpleAccount balance:</strong>{' '}
              {gasless.smartAccountJejuBalance !== undefined
                ? `${formatEther(gasless.smartAccountJejuBalance)} JEJU`
                : 'Loading...'}
            </div>
            <div>
              <strong>JEJU credit:</strong>{' '}
              {gasless.smartAccountJejuCredit !== undefined
                ? `${formatEther(gasless.smartAccountJejuCredit)} JEJU`
                : 'Loading...'}
            </div>
            <div>
              <strong>Paymaster allowance:</strong>{' '}
              {gasless.smartAccountPaymasterAllowance !== undefined
                ? `${formatEther(gasless.smartAccountPaymasterAllowance)} JEJU`
                : 'Loading...'}
            </div>
            <div style={{ color: 'var(--text-secondary)' }}>
              Recommended JEJU on smart account:{' '}
              {formatStakeAmount(requiredStake)}
            </div>
          </div>

          {useGasless && !gaslessReadiness.isReady && (
            <div style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={
                  gaslessBootstrap.isPreparing ||
                  !address ||
                  !gasless.smartAccountAddress
                }
                onClick={() =>
                  gaslessBootstrap.prepareSmartAccount({
                    ownerAddress: address,
                    purpose: 'node',
                    requiredStakeAmount: requiredStake,
                  })
                }
              >
                {gaslessBootstrap.isPreparing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Preparing Smart Account...
                  </>
                ) : (
                  'Prepare Smart Account'
                )}
              </button>
              {gaslessBootstrap.error && (
                <div style={{ marginTop: '0.75rem', color: 'var(--danger)' }}>
                  {gaslessBootstrap.error}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isConnected && (
        <div style={{ marginTop: '1rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleNextStep}
            disabled={isAgentLoading || !hasAgent}
            style={{ padding: '0.875rem 2rem' }}
          >
            Continue <ArrowRight size={16} />
          </button>
        </div>
      )}

      {isConnected && !isAgentLoading && !hasAgent && (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            background: 'var(--warning-soft)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--warning)',
          }}
        >
          Node registration now expects an ERC-8004 operator identity. Create an
          agent identity first, then come back to stake and register the node.
          <div style={{ marginTop: '0.75rem' }}>
            <a href="/agents?tab=register" className="btn btn-secondary btn-sm">
              Open Agent Registration
            </a>
          </div>
        </div>
      )}
    </div>
  )

  const renderServicesStep = () => (
    <div>
      <h3 style={{ marginBottom: '0.5rem', textAlign: 'center' }}>
        Select Services
      </h3>
      <p
        style={{
          color: 'var(--text-secondary)',
          textAlign: 'center',
          marginBottom: '1.5rem',
        }}
      >
        Choose which services you want to provide.
      </p>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '0.5rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <button
          type="button"
          className="btn btn-secondary"
          onClick={selectAllServices}
          disabled={selectedServices.length === services.length}
        >
          Pick all
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={clearAllServices}
          disabled={selectedServices.length === 0}
        >
          Unpick all
        </button>
      </div>

      <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {services.map((service) => (
          <button
            key={service.id}
            type="button"
            onClick={() => toggleService(service.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              padding: '1rem 1.25rem',
              background: service.selected
                ? 'var(--accent-soft)'
                : 'var(--bg-tertiary)',
              border: service.selected
                ? '2px solid var(--accent)'
                : '2px solid transparent',
              borderRadius: 'var(--radius-md)',
              textAlign: 'left',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            <div
              style={{
                width: '24px',
                height: '24px',
                borderRadius: '4px',
                border: service.selected
                  ? '2px solid var(--accent)'
                  : '2px solid var(--border)',
                background: service.selected ? 'var(--accent)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                flexShrink: 0,
              }}
            >
              {service.selected && <Check size={14} />}
            </div>
            <div
              style={{
                color: service.selected
                  ? 'var(--accent)'
                  : 'var(--text-secondary)',
              }}
            >
              {service.icon}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{service.name}</div>
              <div
                style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}
              >
                {service.description}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handlePrevStep}
        >
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleNextStep}
          disabled={selectedServices.length === 0}
        >
          Continue ({selectedServices.length} selected) <ArrowRight size={16} />
        </button>
      </div>
    </div>
  )

  const renderStakeStep = () => {
    const inputStyle = {
      width: '100%',
      padding: '0.75rem',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border)',
      background: 'var(--bg-secondary)',
      color: 'var(--text-primary)',
    }

    return (
      <div>
        <h3 style={{ marginBottom: '0.5rem', textAlign: 'center' }}>
          Node Configuration & Stake
        </h3>
        <p
          style={{
            color: 'var(--text-secondary)',
            textAlign: 'center',
            marginBottom: '1.5rem',
          }}
        >
          Configure your node details and stake JEJU tokens. Stake is returned
          when you deregister.
        </p>

        {/* Node Name */}
        <div style={{ marginBottom: '1.5rem' }}>
          <label
            htmlFor="node-name"
            style={{
              display: 'block',
              marginBottom: '0.5rem',
              fontWeight: 500,
            }}
          >
            Node Name{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
              (optional)
            </span>
          </label>
          <input
            id="node-name"
            type="text"
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            placeholder="my-node-1"
            style={inputStyle}
          />
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-muted)',
              marginTop: '0.5rem',
            }}
          >
            A friendly name to identify this node. Useful for multi-node
            operators.
          </p>
        </div>

        {/* Node RPC URL input */}
        <div style={{ marginBottom: '1.5rem' }}>
          <label
            htmlFor="node-rpc-url"
            style={{
              display: 'block',
              marginBottom: '0.5rem',
              fontWeight: 500,
            }}
          >
            Node RPC URL
          </label>
          <input
            id="node-rpc-url"
            type="text"
            value={nodeRpcUrl}
            onChange={(e) => setNodeRpcUrl(e.target.value)}
            placeholder="https://your-node.example.com:8545"
            style={inputStyle}
          />
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-muted)',
              marginTop: '0.5rem',
            }}
          >
            The public URL where your node will accept requests.
          </p>
        </div>

        <div
          style={{
            padding: '1rem',
            background: 'var(--bg-tertiary)',
            borderRadius: 'var(--radius-md)',
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  color: 'var(--success)',
                  fontWeight: 600,
                }}
              >
                <Check size={16} />
                Verified
              </div>
            )}
          </div>

          {proofChallenge ? (
            <div
              style={{
                display: 'grid',
                gap: '0.75rem',
                marginBottom: '1rem',
              }}
            >
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
                <div
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}
                >
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
                <a
                  href={proofChallenge.proofUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: '0.9rem' }}
                >
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
                <div
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}
                >
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
              Prepare a challenge to discover the node wallet and bind it to
              your ERC-8004 operator identity.
            </p>
          )}

          {proofChallenge && !proofChallenge.delegatedWalletContractReady && (
            <div
              style={{
                padding: '0.875rem',
                background: 'var(--warning-soft)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--warning)',
                marginBottom: '1rem',
                fontSize: '0.9rem',
              }}
            >
              This deployment does not expose delegated wallet methods on the
              current identity registry yet. The proof flow is wired locally,
              but the contract upgrade must be deployed before registration can
              be completed against this network.
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void prepareOwnershipProof()}
              disabled={
                !normalizedNodeRpcUrl ||
                isPreparingProof ||
                !address ||
                selectedAgentId === undefined
              }
            >
              {isPreparingProof ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Preparing...
                </>
              ) : (
                'Prepare Proof'
              )}
            </button>

            {proofChallenge?.delegatedWalletContractReady &&
              !nodeWalletAuthorized && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void authorizeNodeWallet()}
                  disabled={
                    isAuthorizingNodeWallet ||
                    isSetAgentWalletPending ||
                    isSetAgentWalletConfirming
                  }
                >
                  {isAuthorizingNodeWallet ||
                  isSetAgentWalletPending ||
                  isSetAgentWalletConfirming ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Authorizing...
                    </>
                  ) : (
                    'Authorize Node Wallet'
                  )}
                </button>
              )}

            {proofChallenge?.delegatedWalletContractReady &&
              nodeWalletAuthorized &&
              !isOwnershipVerified && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void verifyOwnershipProof()}
                  disabled={isVerifyingProof || isSigningOperatorMessage}
                >
                  {isVerifyingProof || isSigningOperatorMessage ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    'Verify Endpoint Ownership'
                  )}
                </button>
              )}
          </div>

          {authorizeResult ? (
            <div
              style={{
                marginTop: '1rem',
                padding: '0.875rem',
                borderRadius: 'var(--radius-md)',
                border:
                  authorizeResult.status === 'error'
                    ? '1px solid var(--error)'
                    : authorizeResult.status === 'success'
                      ? '1px solid var(--success)'
                      : '1px solid var(--border)',
                background:
                  authorizeResult.status === 'error'
                    ? 'var(--error-soft)'
                    : authorizeResult.status === 'success'
                      ? 'var(--success-soft)'
                      : 'var(--surface-hover)',
                display: 'grid',
                gap: '0.35rem',
              }}
            >
              <div style={{ fontWeight: 700 }}>{authorizeResult.title}</div>
              <div style={{ fontSize: '0.9rem' }}>
                {authorizeResult.message}
              </div>
              {authorizeResult.txHash ? (
                <a
                  href={`${EXPLORER_URL}/tx/${authorizeResult.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                  }}
                >
                  View transaction
                  <ExternalLink size={14} />
                </a>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Region and Zone */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '1rem',
            marginBottom: '1.5rem',
          }}
        >
          <div>
            <label
              htmlFor="region-select"
              style={{
                display: 'block',
                marginBottom: '0.5rem',
                fontWeight: 500,
              }}
            >
              Region
            </label>
            <select
              id="region-select"
              value={selectedRegion}
              onChange={(e) =>
                setSelectedRegion(Number(e.target.value) as RegionValue)
              }
              style={inputStyle}
            >
              <option value={Region.NorthAmerica}>North America</option>
              <option value={Region.SouthAmerica}>South America</option>
              <option value={Region.Europe}>Europe</option>
              <option value={Region.Asia}>Asia</option>
              <option value={Region.Africa}>Africa</option>
              <option value={Region.Oceania}>Oceania</option>
              <option value={Region.Global}>Global</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="node-zone"
              style={{
                display: 'block',
                marginBottom: '0.5rem',
                fontWeight: 500,
              }}
            >
              Zone{' '}
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                (optional)
              </span>
            </label>
            <input
              id="node-zone"
              type="text"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="us-east-1"
              style={inputStyle}
            />
          </div>
        </div>

        {/* Hardware Specs */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div
            style={{
              display: 'block',
              marginBottom: '0.5rem',
              fontWeight: 500,
            }}
          >
            Hardware Specs{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
              (optional)
            </span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: '1rem',
            }}
          >
            <div>
              <label
                htmlFor="cpu-cores"
                style={{
                  display: 'block',
                  marginBottom: '0.25rem',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                CPU Cores
              </label>
              <input
                id="cpu-cores"
                type="number"
                min="1"
                value={cpuCores}
                onChange={(e) => setCpuCores(e.target.value)}
                placeholder="4"
                style={inputStyle}
              />
            </div>
            <div>
              <label
                htmlFor="memory-gb"
                style={{
                  display: 'block',
                  marginBottom: '0.25rem',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Memory (GB)
              </label>
              <input
                id="memory-gb"
                type="number"
                min="1"
                value={memoryGb}
                onChange={(e) => setMemoryGb(e.target.value)}
                placeholder="8"
                style={inputStyle}
              />
            </div>
            <div>
              <label
                htmlFor="disk-gb"
                style={{
                  display: 'block',
                  marginBottom: '0.25rem',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Disk (GB)
              </label>
              <input
                id="disk-gb"
                type="number"
                min="1"
                value={diskGb}
                onChange={(e) => setDiskGb(e.target.value)}
                placeholder="100"
                style={inputStyle}
              />
            </div>
          </div>
        </div>

        {/* Stake Summary */}
        <div
          style={{
            padding: '1.5rem',
            background: 'var(--bg-tertiary)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1.5rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: '1rem',
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>
              Selected Services
            </span>
            <span style={{ fontWeight: 600 }}>{selectedServices.length}</span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: '1rem',
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>
              Min Stake per Service
            </span>
            <span style={{ fontWeight: 600 }}>
              {minStakeUSD ? formatStakeAmount(minStakeUSD) : 'Loading...'}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              paddingTop: '1rem',
              borderTop: '2px solid var(--border)',
              marginBottom: '1rem',
            }}
          >
            <span style={{ fontWeight: 700 }}>Minimum Required</span>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
              {formatStakeAmount(minimumStake)}
            </span>
          </div>

          {/* Adjustable stake input */}
          <div>
            <label
              htmlFor="stake-amount"
              style={{
                display: 'block',
                marginBottom: '0.5rem',
                fontWeight: 500,
              }}
            >
              Stake Amount (JEJU)
            </label>
            <input
              id="stake-amount"
              type="number"
              min={minStakeUSD ? Number(formatEther(minimumStake)) : 0}
              step="any"
              value={customStakeAmount}
              onChange={(e) => setCustomStakeAmount(e.target.value)}
              placeholder={
                minStakeUSD ? Number(formatEther(minimumStake)).toString() : '0'
              }
              style={inputStyle}
            />
            <p
              style={{
                fontSize: '0.85rem',
                color: 'var(--text-muted)',
                marginTop: '0.5rem',
              }}
            >
              Stake more than the minimum for higher reward priority. Leave
              blank to use the minimum.
            </p>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              paddingTop: '1rem',
              borderTop: '2px solid var(--border)',
              fontWeight: 700,
              marginTop: '1rem',
            }}
          >
            <span>Your Stake</span>
            <span style={{ color: 'var(--accent)' }}>
              {formatStakeAmount(requiredStake)}
            </span>
          </div>
        </div>

        <div
          style={{
            padding: '1rem',
            background: 'var(--info-soft)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
          }}
        >
          <Coins size={18} style={{ color: 'var(--info)', marginTop: '2px' }} />
          <div style={{ fontSize: '0.9rem' }}>
            <strong>Estimated Monthly Earnings:</strong>{' '}
            {estimatedMonthlyReward}
            /mo
            <br />
            <span style={{ color: 'var(--text-secondary)' }}>
              Based on contract parameters and your selected services.
            </span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handlePrevStep}
          >
            Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleNextStep}
            disabled={!nodeRpcUrl || !isOwnershipVerified}
          >
            Continue <ArrowRight size={16} />
          </button>
        </div>
      </div>
    )
  }

  const renderApproveStep = () => (
    <div>
      <h3 style={{ marginBottom: '0.5rem', textAlign: 'center' }}>
        Approve Token Spending
      </h3>
      <p
        style={{
          color: 'var(--text-secondary)',
          textAlign: 'center',
          marginBottom: '1.5rem',
        }}
      >
        Before staking, you need to approve the staking contract to spend your
        tokens.
      </p>

      <div
        style={{
          padding: '1.5rem',
          background: 'var(--bg-tertiary)',
          borderRadius: 'var(--radius-md)',
          marginBottom: '1.5rem',
          textAlign: 'center',
        }}
      >
        <div style={{ marginBottom: '1rem' }}>
          <div
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-muted)',
              marginBottom: '0.25rem',
            }}
          >
            Amount to Approve
          </div>
          <div
            style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              color: 'var(--accent)',
            }}
          >
            {formatStakeAmount(requiredStake)}
          </div>
        </div>

        {approvalHash && (
          <div style={{ marginTop: '1rem' }}>
            <a
              href={`https://explorer.jejunetwork.org/tx/${approvalHash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                color: 'var(--accent)',
                fontSize: '0.9rem',
              }}
            >
              View Transaction <ExternalLink size={14} />
            </a>
          </div>
        )}

        {isApprovalSuccess && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              background: 'var(--success-soft)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--success)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
            }}
          >
            <Check size={18} />
            Approval Confirmed
          </div>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: '1rem',
            background: 'var(--error-soft)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            color: 'var(--error)',
          }}
        >
          <AlertCircle size={18} style={{ marginTop: '2px' }} />
          <div>{error}</div>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handlePrevStep}
          disabled={isApproving}
        >
          Back
        </button>
        {isApprovalSuccess ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleNextStep}
          >
            Continue <ArrowRight size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleApprove}
            disabled={isApproving}
          >
            {isApproving ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Approving...
              </>
            ) : (
              <>
                <Check size={18} />
                Approve Tokens
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )

  const renderConfirmStep = () => (
    <div>
      <h3 style={{ marginBottom: '0.5rem', textAlign: 'center' }}>
        Register Node
      </h3>
      <p
        style={{
          color: 'var(--text-secondary)',
          textAlign: 'center',
          marginBottom: '1.5rem',
        }}
      >
        Review your registration details and submit the transaction.
      </p>

      <div
        style={{
          padding: '1.5rem',
          background: 'var(--bg-tertiary)',
          borderRadius: 'var(--radius-md)',
          marginBottom: '1.5rem',
        }}
      >
        <div style={{ marginBottom: '1rem' }}>
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              marginBottom: '0.25rem',
            }}
          >
            Wallet Address
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>
            {address}
          </div>
        </div>

        {selectedAgentId !== undefined && (
          <div style={{ marginBottom: '1rem' }}>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-muted)',
                marginBottom: '0.25rem',
              }}
            >
              Linked Operator Identity
            </div>
            <div style={{ fontSize: '0.9rem' }}>
              Agent #{selectedAgentId.toString()}
              {selectedAgent?.name ? ` - ${selectedAgent.name}` : ''}
            </div>
          </div>
        )}

        {nodeName && (
          <div style={{ marginBottom: '1rem' }}>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-muted)',
                marginBottom: '0.25rem',
              }}
            >
              Node Name
            </div>
            <div style={{ fontSize: '0.9rem' }}>{nodeName}</div>
          </div>
        )}

        <div style={{ marginBottom: '1rem' }}>
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              marginBottom: '0.25rem',
            }}
          >
            Services
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {selectedServices.map((s) => (
              <span key={s.id} className="badge badge-info">
                {s.name}
              </span>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              marginBottom: '0.25rem',
            }}
          >
            Node RPC URL
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>
            {nodeRpcUrl}
          </div>
        </div>

        {proofVerification && (
          <div style={{ marginBottom: '1rem' }}>
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
              {proofVerification.nodeWalletAddress}
            </div>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '1rem',
            marginBottom: '1rem',
          }}
        >
          <div>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-muted)',
                marginBottom: '0.25rem',
              }}
            >
              Region
            </div>
            <div style={{ fontSize: '0.9rem' }}>
              {[
                [Region.NorthAmerica, 'North America'],
                [Region.SouthAmerica, 'South America'],
                [Region.Europe, 'Europe'],
                [Region.Asia, 'Asia'],
                [Region.Africa, 'Africa'],
                [Region.Oceania, 'Oceania'],
                [Region.Global, 'Global'],
              ].find(([v]) => v === selectedRegion)?.[1] ?? 'Unknown'}
            </div>
          </div>
          {zone && (
            <div>
              <div
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  marginBottom: '0.25rem',
                }}
              >
                Zone
              </div>
              <div style={{ fontSize: '0.9rem' }}>{zone}</div>
            </div>
          )}
        </div>

        {(cpuCores || memoryGb || diskGb) && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '1rem',
              marginBottom: '1rem',
            }}
          >
            {cpuCores && (
              <div>
                <div
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--text-muted)',
                    marginBottom: '0.25rem',
                  }}
                >
                  CPU Cores
                </div>
                <div style={{ fontSize: '0.9rem' }}>{cpuCores}</div>
              </div>
            )}
            {memoryGb && (
              <div>
                <div
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--text-muted)',
                    marginBottom: '0.25rem',
                  }}
                >
                  Memory
                </div>
                <div style={{ fontSize: '0.9rem' }}>{memoryGb} GB</div>
              </div>
            )}
            {diskGb && (
              <div>
                <div
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--text-muted)',
                    marginBottom: '0.25rem',
                  }}
                >
                  Disk
                </div>
                <div style={{ fontSize: '0.9rem' }}>{diskGb} GB</div>
              </div>
            )}
          </div>
        )}

        <div>
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              marginBottom: '0.25rem',
            }}
          >
            Total Stake
          </div>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: 'var(--accent)',
            }}
          >
            {formatStakeAmount(requiredStake)}
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '1rem',
            background: 'var(--error-soft)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            color: 'var(--error)',
          }}
        >
          <AlertCircle size={18} style={{ marginTop: '2px' }} />
          <div>{error}</div>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handlePrevStep}
          disabled={isRegistering}
        >
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleRegister}
          disabled={isRegistering}
        >
          {isRegistering ? (
            <>
              <Loader2 size={18} className="animate-spin" />
              Registering...
            </>
          ) : (
            <>
              <Check size={18} />
              Register Node
            </>
          )}
        </button>
      </div>

      {isRegisteringNodeIdentity && (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            background: 'var(--info-soft)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--info)',
          }}
        >
          Creating node identity and persisting selected services...
        </div>
      )}

      {nodeIdentityError && (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            background: 'var(--warning-soft)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--warning)',
          }}
        >
          {nodeIdentityError}
        </div>
      )}
    </div>
  )

  const renderCompleteStep = () => (
    <div style={{ textAlign: 'center', padding: '1rem' }}>
      <div
        style={{
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          background: 'var(--success)',
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 1.5rem',
        }}
      >
        <Check size={32} />
      </div>
      <h3 style={{ marginBottom: '0.75rem' }}>Registration Complete</h3>
      <p
        style={{
          color: 'var(--text-secondary)',
          marginBottom: '1.5rem',
          maxWidth: '400px',
          margin: '0 auto 1.5rem',
        }}
      >
        Your node has been registered on the network. Download and run the Jeju
        Node app to start earning.
      </p>

      {nodeRegistrationResult?.nodeIdentityId && (
        <div
          style={{
            padding: '1rem',
            background: 'var(--success-soft)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1rem',
          }}
        >
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              marginBottom: '0.25rem',
            }}
          >
            Node Identity
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 600 }}>
            Agent #{nodeRegistrationResult.nodeIdentityId}
          </div>
        </div>
      )}

      {(nodeRegistrationResult?.txHash || effectiveRegistrationHash) && (
        <div
          style={{
            padding: '1rem',
            background: 'var(--bg-tertiary)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1.5rem',
          }}
        >
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              marginBottom: '0.25rem',
            }}
          >
            Registration Transaction
          </div>
          <a
            href={`https://explorer.jejunetwork.org/tx/${nodeRegistrationResult?.txHash ?? effectiveRegistrationHash}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.85rem',
              color: 'var(--accent)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            {(
              nodeRegistrationResult?.txHash ?? effectiveRegistrationHash
            )?.slice(0, 10)}
            ...
            {(
              nodeRegistrationResult?.txHash ?? effectiveRegistrationHash
            )?.slice(-8)}
            <ExternalLink size={14} />
          </a>
        </div>
      )}

      {nodeIdentityError && (
        <div
          style={{
            padding: '1rem',
            background: 'var(--warning-soft)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '1.5rem',
            color: 'var(--warning)',
          }}
        >
          Node staking succeeded, but the node identity metadata could not be
          finalized: {nodeIdentityError}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
        <a href="/provider/nodes" className="btn btn-primary">
          <Server size={18} />
          View My Nodes
        </a>
        <a href="/provider/node#downloads" className="btn btn-secondary">
          Download App
        </a>
      </div>
    </div>
  )

  return (
    <>
      <div className="card" style={{ marginBottom: '2rem' }}>
        <div className="card-header">
          <h3 className="card-title">
            <Server size={18} /> Register Your Node
          </h3>
        </div>

        {step !== 'complete' && renderStepIndicator()}

        {step === 'connect' && renderConnectStep()}
        {step === 'services' && renderServicesStep()}
        {step === 'stake' && renderStakeStep()}
        {step === 'approve' && renderApproveStep()}
        {step === 'confirm' && renderConfirmStep()}
        {step === 'complete' && renderCompleteStep()}
      </div>
      {authorizeResult ? (
        <TransactionStatusModal
          result={authorizeResult}
          onClose={() => setAuthorizeResult(null)}
        />
      ) : null}
    </>
  )
}
