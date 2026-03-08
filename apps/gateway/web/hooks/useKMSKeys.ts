import { useJejuAuth } from '@jejunetwork/auth/react'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { DWS_API_URL } from '../../lib/config'

export interface KMSKey {
  keyId: string
  name: string
  publicKey: string
  address: Address
  threshold: number
  totalParties: number
  version: number
  createdAt: number
}

interface KMSKeysResponse {
  keys: KMSKey[]
}

interface GatewayKMSKeysResult extends KMSKeysResponse {
  apiBaseUrl: string
  manageKeysUrl: string
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function getStoredOAuth3SessionId(): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return null
  }

  try {
    const raw = localStorage.getItem('oauth3_session')
    if (!raw) return null
    const parsed = JSON.parse(raw) as { sessionId?: unknown }
    return typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
      ? parsed.sessionId
      : null
  } catch {
    return null
  }
}

function resolvePreferredDwsBaseUrl(): string {
  const configuredDwsUrl = trimTrailingSlash(DWS_API_URL)

  if (typeof window === 'undefined') {
    return configuredDwsUrl
  }

  const origin = trimTrailingSlash(window.location.origin)
  const currentPath = window.location.pathname

  try {
    const configuredHost = new URL(configuredDwsUrl).host
    const currentHost = new URL(origin).host
    if (configuredHost === currentHost) {
      return configuredDwsUrl
    }
  } catch {
    return configuredDwsUrl
  }

  if (currentPath === '/' || currentPath.startsWith('/gateway')) {
    return `${origin}/dws`
  }

  return configuredDwsUrl
}

function buildManageKeysUrl(apiBaseUrl: string): string {
  return `${trimTrailingSlash(apiBaseUrl)}/security/keys`
}

async function fetchKmsKeys(
  apiBaseUrl: string,
  address?: string,
): Promise<KMSKeysResponse> {
  const headers: Record<string, string> = {}
  if (address) {
    headers['X-Jeju-Address'] = address
  }

  const sessionId = getStoredOAuth3SessionId()
  if (sessionId) {
    headers.Authorization = `Bearer ${sessionId}`
  }

  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/kms/keys`, {
    method: 'GET',
    headers,
  })

  if (!response.ok) {
    const text = await response.text()
    let message = 'Failed to load KMS keys.'
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
        if (typeof parsed.error === 'string' && parsed.error.length > 0) {
          message = parsed.error
        } else if (
          typeof parsed.message === 'string' &&
          parsed.message.length > 0
        ) {
          message = parsed.message
        }
      } catch {
        message = text
      }
    }
    throw new Error(message)
  }

  return (await response.json()) as KMSKeysResponse
}

export function useKMSKeys() {
  const { address } = useAccount()
  const { walletAddress } = useJejuAuth()
  const requestAddress = walletAddress ?? address ?? undefined
  const apiBaseUrl = useMemo(resolvePreferredDwsBaseUrl, [])
  const manageKeysUrl = useMemo(() => buildManageKeysUrl(apiBaseUrl), [apiBaseUrl])

  return useQuery({
    queryKey: ['gateway-kms-keys', requestAddress, apiBaseUrl],
    enabled: Boolean(requestAddress),
    queryFn: async (): Promise<GatewayKMSKeysResult> => {
      const response = await fetchKmsKeys(apiBaseUrl, requestAddress)
      return {
        ...response,
        apiBaseUrl,
        manageKeysUrl,
      }
    },
  })
}
