import type {
  GaslessBootstrapPurpose,
  GaslessBootstrapResponse,
} from '@jejunetwork/shared'
import { useCallback, useState } from 'react'
import type { Address } from 'viem'
import type { useGaslessSmartAccount } from './useGaslessSmartAccount'

interface UseGaslessBootstrapParams {
  endpoint?: string
  gasless: ReturnType<typeof useGaslessSmartAccount>
}

export function useGaslessBootstrap(params: UseGaslessBootstrapParams) {
  const { gasless } = params
  const [isBootstrapping, setIsBootstrapping] = useState(false)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [lastBootstrapResult, setLastBootstrapResult] =
    useState<GaslessBootstrapResponse | null>(null)

  const bootstrap = useCallback(
    async (options: {
      purpose: GaslessBootstrapPurpose
      requiredStakeAmount: bigint
      ownerAddress?: Address
      smartAccountAddress?: Address
    }) => {
      const ownerAddress = options.ownerAddress ?? gasless.ownerAddress
      const smartAccountAddress =
        options.smartAccountAddress ?? gasless.smartAccountAddress

      if (!ownerAddress) {
        throw new Error(
          'Wallet signer unavailable. Connect your EOA in Rabby/MetaMask to continue.',
        )
      }
      if (!smartAccountAddress) {
        throw new Error('Smart account is not available yet')
      }

      setIsBootstrapping(true)
      setBootstrapError(null)

      try {
        const response = await fetch(
          params.endpoint ?? './api/gasless/bootstrap',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ownerAddress,
              smartAccountAddress,
              purpose: options.purpose,
              requiredStakeAmount: options.requiredStakeAmount.toString(),
            }),
          },
        )

        const rawBody = await response.text()
        const payload = (
          rawBody
            ? JSON.parse(rawBody)
            : {
                success: false,
                error: 'Empty response from bootstrap endpoint',
              }
        ) as GaslessBootstrapResponse | { success?: false; error?: string }

        if (!response.ok || !payload.success) {
          throw new Error(payload.error ?? 'Failed to prepare smart account')
        }

        setLastBootstrapResult(payload)
        await gasless.refreshState()
        return payload
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to prepare smart account'
        setBootstrapError(message)
        throw new Error(message)
      } finally {
        setIsBootstrapping(false)
      }
    },
    [gasless, params.endpoint],
  )

  return {
    bootstrap,
    isBootstrapping,
    bootstrapError,
    lastBootstrapResult,
  }
}
