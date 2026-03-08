import { describe, expect, test } from 'bun:test'
import { isFrontendSpaPath } from '../../api/server/frontend-routes'

describe('frontend storage SPA routes', () => {
  test('treats exact storage frontend paths as SPA routes', () => {
    expect(isFrontendSpaPath('/storage/ipfs')).toBe(true)
    expect(isFrontendSpaPath('/storage/ipfs/')).toBe(true)
    expect(isFrontendSpaPath('/storage/buckets')).toBe(true)
    expect(isFrontendSpaPath('/storage/cdn')).toBe(true)
    expect(isFrontendSpaPath('/storage/analytics')).toBe(true)
  })

  test('does not treat gateway CID paths or API paths as SPA routes', () => {
    expect(isFrontendSpaPath('/storage/ipfs/QmExampleCid')).toBe(false)
    expect(isFrontendSpaPath('/storage/upload')).toBe(false)
    expect(isFrontendSpaPath('/kms/health')).toBe(false)
  })
})
