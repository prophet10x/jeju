import { useJejuAuth } from '@jejunetwork/auth/react'
import { WalletManagementMenu as WalletManagementMenuUi } from '@jejunetwork/ui'
import { useMemo, useState } from 'react'
import { erc20Abi, formatEther, parseEther, type Address } from 'viem'
import {
  useAccount,
  useBalance,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from 'wagmi'
import { TOKENS } from '../config'
import { useGaslessSmartAccount } from '../hooks/useGaslessSmartAccount'

function formatToken(value?: bigint) {
  if (value === undefined) return '0 JEJU'
  const amount = Number(formatEther(value))
  const formatted = amount.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  })
  return `${formatted} JEJU ($${formatted})`
}

function formatNative(value?: bigint) {
  if (value === undefined) return '0 ETH'
  return `${Number(formatEther(value)).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  })} ETH`
}

export default function WalletManagementMenu() {
  const { walletAddress, logout } = useJejuAuth()
  const { disconnect } = useDisconnect()
  const { address: connectedAddress } = useAccount()
  const publicClient = usePublicClient()
  const gasless = useGaslessSmartAccount()
  const [movePending, setMovePending] = useState(false)
  const { writeContractAsync } = useWriteContract()

  const ownerAddress =
    (gasless.ownerAddress as Address | undefined) ||
    (walletAddress as Address | undefined)

  const { data: ownerEthBalance, refetch: refetchOwnerEth } = useBalance({
    address: ownerAddress,
    query: { enabled: Boolean(ownerAddress) },
  })

  const { data: ownerJejuBalance, refetch: refetchOwnerJeju } = useReadContract({
    address: TOKENS.jeju,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: ownerAddress ? [ownerAddress] : undefined,
    query: { enabled: Boolean(ownerAddress) },
  })

  const { data: smartEthBalance, refetch: refetchSmartEth } = useBalance({
    address: gasless.smartAccountAddress,
    query: { enabled: Boolean(gasless.smartAccountAddress) },
  })

  const moveDisabledReason = useMemo(() => {
    if (!connectedAddress || !ownerAddress) {
      return 'Connect the owner wallet to move JEJU.'
    }
    if (connectedAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
      return 'Reconnect with the owner wallet to move JEJU.'
    }
    if (!gasless.smartAccountAddress) {
      return 'SimpleAccount is not available yet.'
    }
    if ((ownerEthBalance?.value ?? 0n) === 0n) {
      return 'This transfer needs L2 ETH on the EOA.'
    }
    if ((ownerJejuBalance as bigint | undefined) === 0n) {
      return 'No JEJU is available on the EOA.'
    }
    return null
  }, [
    connectedAddress,
    gasless.smartAccountAddress,
    ownerAddress,
    ownerEthBalance?.value,
    ownerJejuBalance,
  ])

  async function moveToSmartAccount(amount: bigint) {
    if (!ownerAddress || !gasless.smartAccountAddress) return
    setMovePending(true)
    try {
      const hash = await writeContractAsync({
        address: TOKENS.jeju,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [gasless.smartAccountAddress, amount],
      })
      await publicClient?.waitForTransactionReceipt({ hash })
      await Promise.all([
        gasless.refreshState(),
        refetchOwnerJeju(),
        refetchOwnerEth(),
        refetchSmartEth(),
      ])
    } finally {
      setMovePending(false)
    }
  }

  return (
    <WalletManagementMenuUi
      connectedLabel={
        ownerAddress
          ? `${ownerAddress.slice(0, 6)}...${ownerAddress.slice(-4)}`
          : 'Connected'
      }
      ownerWallet={{
        label: 'Owner Wallet (EOA)',
        address: ownerAddress,
        jejuBalance: formatToken(ownerJejuBalance as bigint | undefined),
        ethBalance: formatNative(ownerEthBalance?.value),
      }}
      smartWallet={{
        label: 'Gasless Wallet (SimpleAccount)',
        address: gasless.smartAccountAddress,
        jejuBalance: formatToken(gasless.smartAccountJejuBalance),
        ethBalance: formatNative(smartEthBalance?.value),
        jejuCredit: formatToken(gasless.smartAccountJejuCredit),
        paymasterAllowance: formatToken(gasless.smartAccountPaymasterAllowance),
      }}
      smartAccountError={gasless.smartAccountDerivationError}
      movePending={movePending}
      moveDisabledReason={moveDisabledReason}
      onMoveAllToSmart={() =>
        moveToSmartAccount((ownerJejuBalance as bigint | undefined) ?? 0n)
      }
      onMoveCustomToSmart={(amount) => moveToSmartAccount(parseEther(amount))}
      onDisconnect={async () => {
        await logout()
        disconnect()
      }}
    />
  )
}
