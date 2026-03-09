export function getDwsBasePath(): string {
  if (typeof window === 'undefined') return ''
  const pathname = window.location.pathname ?? ''
  return pathname === '/dws' || pathname.startsWith('/dws/') ? '/dws' : ''
}

export function toDwsPath(path: string): string {
  const normalizedPath =
    path.length === 0 ? '/' : path.startsWith('/') ? path : `/${path}`
  return `${getDwsBasePath()}${normalizedPath}`
}
