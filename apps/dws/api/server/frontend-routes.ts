const FRONTEND_STORAGE_PATHS = new Set([
  '/storage/ipfs',
  '/storage/buckets',
  '/storage/cdn',
  '/storage/analytics',
])

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path
}

export function isFrontendSpaPath(path: string): boolean {
  return FRONTEND_STORAGE_PATHS.has(normalizePath(path))
}

