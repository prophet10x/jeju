/**
 * Eden Client for DWS API
 * Provides type-safe API calls with Zod validation
 */

import type { z } from 'zod'
import { DWS_API_URL } from '../config'

// Export base URL for API calls
export const API_URL = DWS_API_URL

export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message)
    this.name = 'APIError'
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public errors: z.ZodError,
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

interface FetchOptions extends Omit<RequestInit, 'body'> {
  address?: string
  body?: string
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function getErrorMessageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'string') {
    return body.trim().length > 0 ? body : fallback
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      return record.error
    }
    if (
      typeof record.message === 'string' &&
      record.message.trim().length > 0
    ) {
      return record.message
    }
  }
  return fallback
}

function getStoredOAuth3SessionId(): string | null {
  if (typeof window === 'undefined') return null
  if (typeof localStorage === 'undefined') return null

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

function applyDefaultAuthHeaders(headers: Record<string, string>): void {
  const hasAuthorization = Object.keys(headers).some(
    (key) => key.toLowerCase() === 'authorization',
  )
  if (hasAuthorization) return

  const sessionId = getStoredOAuth3SessionId()
  if (sessionId) {
    headers.Authorization = `Bearer ${sessionId}`
  }
}

function shouldAttachSessionAuth(endpoint: string): boolean {
  return endpoint === '/kms' || endpoint.startsWith('/kms/')
}

/**
 * Type-safe fetch helper with Zod validation
 */
export async function fetchApi<T>(
  endpoint: string,
  options?: FetchOptions,
  schema?: z.ZodType<T>,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  }

  if (options?.address) {
    headers['X-Jeju-Address'] = options.address
  }
  if (shouldAttachSessionAuth(endpoint)) {
    applyDefaultAuthHeaders(headers)
  }

  const response = await fetch(`${DWS_API_URL}${endpoint}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const error = await parseResponseBody(response)
    throw new APIError(
      getErrorMessageFromBody(error, 'API request failed'),
      response.status,
      typeof error === 'object' && error && 'code' in error
        ? String((error as Record<string, unknown>).code)
        : undefined,
    )
  }

  const data = await parseResponseBody(response)

  if (schema) {
    const result = schema.safeParse(data)
    if (!result.success) {
      console.warn('[API] Validation warning:', result.error.format())
      // Return data anyway - validation is informational
      return data as T
    }
    return result.data
  }

  return data as T
}

/**
 * Validated fetch helper - throws on validation failure
 */
export async function fetchValidated<T>(
  endpoint: string,
  schema: z.ZodType<T>,
  options?: FetchOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  }

  if (options?.address) {
    headers['X-Jeju-Address'] = options.address
  }
  if (shouldAttachSessionAuth(endpoint)) {
    applyDefaultAuthHeaders(headers)
  }

  const response = await fetch(`${DWS_API_URL}${endpoint}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const error = await parseResponseBody(response)
    throw new APIError(
      getErrorMessageFromBody(error, 'API request failed'),
      response.status,
      typeof error === 'object' && error && 'code' in error
        ? String((error as Record<string, unknown>).code)
        : undefined,
    )
  }

  const data = await parseResponseBody(response)
  const result = schema.safeParse(data)

  if (!result.success) {
    throw new ValidationError(
      `API response validation failed: ${result.error.message}`,
      result.error,
    )
  }

  return result.data
}

/**
 * Helper for POST requests
 */
export async function postApi<T>(
  endpoint: string,
  body: Record<string, unknown>,
  options?: Omit<FetchOptions, 'body' | 'method'>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return fetchApi<T>(
    endpoint,
    {
      ...options,
      method: 'POST',
      body: JSON.stringify(body),
    },
    schema,
  )
}

/**
 * Helper for DELETE requests
 */
export async function deleteApi<T>(
  endpoint: string,
  options?: Omit<FetchOptions, 'method'>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return fetchApi<T>(
    endpoint,
    {
      ...options,
      method: 'DELETE',
    },
    schema,
  )
}

/**
 * Helper for uploading files
 */
export async function uploadFile(
  endpoint: string,
  file: File,
  address?: string,
  options?: {
    storageClass?: 'SYSTEM_PUBLIC' | 'PRIVATE_OWNER' | 'MANAGED_EXECUTION'
    minReplicas?: number
    tier?: 'system' | 'popular' | 'private'
    category?: string
  },
): Promise<{
  cid: string
  size?: number
  contentType?: string
  accessClass?: 'SYSTEM_PUBLIC' | 'PRIVATE_OWNER' | 'MANAGED_EXECUTION'
  encryptionMode?: 'none' | 'kms'
  requestedMinReplicas?: number
  effectiveReplicaCount?: number
}> {
  const formData = new FormData()
  formData.append('file', file)
  if (options?.storageClass) {
    formData.append('storageClass', options.storageClass)
  }
  if (options?.minReplicas !== undefined) {
    formData.append('minReplicas', String(options.minReplicas))
  }
  if (options?.tier) {
    formData.append('tier', options.tier)
  }
  if (options?.category) {
    formData.append('category', options.category)
  }

  const headers: Record<string, string> = {}
  if (address) {
    headers['X-Jeju-Address'] = address
  }
  if (shouldAttachSessionAuth(endpoint)) {
    applyDefaultAuthHeaders(headers)
  }

  const response = await fetch(`${DWS_API_URL}${endpoint}`, {
    method: 'POST',
    headers,
    body: formData,
  })

  if (!response.ok) {
    const error = await parseResponseBody(response)
    throw new APIError(
      getErrorMessageFromBody(error, 'Upload failed'),
      response.status,
    )
  }

  return (await parseResponseBody(response)) as {
    cid: string
    size?: number
    contentType?: string
    accessClass?: 'SYSTEM_PUBLIC' | 'PRIVATE_OWNER' | 'MANAGED_EXECUTION'
    encryptionMode?: 'none' | 'kms'
    requestedMinReplicas?: number
    effectiveReplicaCount?: number
  }
}

/**
 * Helper for uploading raw data
 */
export async function uploadRaw(
  endpoint: string,
  data: string | ArrayBuffer,
  contentType: string,
  address?: string,
  filename?: string,
): Promise<{ cid: string }> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
  }
  if (address) {
    headers['X-Jeju-Address'] = address
  }
  if (filename) {
    headers['x-filename'] = filename
  }
  if (shouldAttachSessionAuth(endpoint)) {
    applyDefaultAuthHeaders(headers)
  }

  const response = await fetch(`${DWS_API_URL}${endpoint}`, {
    method: 'POST',
    headers,
    body: data,
  })

  if (!response.ok) {
    const error = await response.json()
    throw new APIError(
      error.error ?? error.message ?? 'Upload failed',
      response.status,
    )
  }

  return response.json()
}
