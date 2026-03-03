import type { GaslessBootstrapResponse } from '@jejunetwork/shared'
import { useCallback, useMemo, useState } from 'react'
import type { useGaslessSmartAccount } from './useGaslessSmartAccount'

interface UseGaslessBootstrapParams {
  gasless: ReturnType<typeof useGaslessSmartAccount>
}

export function useGaslessBootstrap({
  gasless,
}: UseGaslessBootstrapParams) {
  const [isPreparing, setIsPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<GaslessBootstrapResponse | null>(
    null,
  )

  const prepareSmartAccount = useCallback(
    async (params: {
      ownerAddress?: string
      purpose: 'node'
      requiredStakeAmount: bigint
      endpoint?: string
    }) => {
      if (!params.ownerAddress) {
        throw new Error('Connect your wallet first')
      }
      if (!gasless.smartAccountAddress) {
        throw new Error(
          gasless.smartAccountDerivationError ??
            'Unable to derive SimpleAccount address',
        )
      }

      setIsPreparing(true)
      setError(null)

      try {
        const response = await fetch(params.endpoint ?? '/gasless/bootstrap', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ownerAddress: params.ownerAddress,
            smartAccountAddress: gasless.smartAccountAddress,
            purpose: params.purpose,
            requiredStakeAmount: params.requiredStakeAmount.toString(),
          }),
        })

        const text = await response.text()
        const payload = text
          ? (JSON.parse(text) as
              | GaslessBootstrapResponse
              | { error?: string })
          : { error: 'Empty bootstrap response' }

        if (!response.ok || ('error' in payload && payload.error)) {
          throw new Error(payload.error ?? 'Failed to prepare smart account')
        }

        setLastResult(payload)
        await gasless.refreshState()
        return payload
      } catch (bootstrapError) {
        const message =
          bootstrapError instanceof Error
            ? bootstrapError.message
            : 'Failed to prepare smart account'
        setError(message)
        throw bootstrapError
      } finally {
        setIsPreparing(false)
      }
    },
    [gasless],
  )

  return useMemo(
    () => ({
      isPreparing,
      error,
      lastResult,
      prepareSmartAccount,
    }),
    [error, isPreparing, lastResult, prepareSmartAccount],
  )
}
