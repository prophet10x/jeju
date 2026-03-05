#!/usr/bin/env bun

type CheckResult = {
  name: string
  ok: boolean
  detail: string
}

const gatewayApiBase =
  process.env.GATEWAY_API_BASE ??
  'https://jeju-testnet.fartbag.fun/gateway/api'
const dwsBase = process.env.DWS_BASE_URL ?? 'https://jeju-dws.fartbag.fun'
const operatorAddress =
  process.env.OPERATOR_ADDRESS ??
  '0xf9159891afb242ec0f2570c29406403e48a68271'
const requireNonEmptyNodes = (process.env.REQUIRE_NON_EMPTY_NODES ?? 'true')
  .toLowerCase()
  .trim()
const strictNodes = requireNonEmptyNodes === '1' || requireNonEmptyNodes === 'true'

function formatErr(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function expectJsonValidation400(
  name: string,
  url: string,
): Promise<CheckResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }

    const hasErrorField =
      parsed && typeof parsed === 'object' && 'error' in parsed
    if (res.status === 400 && hasErrorField) {
      return {
        name,
        ok: true,
        detail: `status=400, structured error present`,
      }
    }

    return {
      name,
      ok: false,
      detail: `expected status=400 + error json, got status=${res.status}, body=${text.slice(0, 240)}`,
    }
  } catch (error) {
    return { name, ok: false, detail: formatErr(error) }
  }
}

async function expectJson(
  name: string,
  url: string,
  validate: (parsed: unknown) => string | null,
): Promise<CheckResult> {
  try {
    const res = await fetch(url)
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }

    if (!res.ok) {
      return {
        name,
        ok: false,
        detail: `status=${res.status}, body=${text.slice(0, 240)}`,
      }
    }

    const validationError = validate(parsed)
    if (validationError) {
      return {
        name,
        ok: false,
        detail: validationError,
      }
    }

    return {
      name,
      ok: true,
      detail: `status=${res.status}`,
    }
  } catch (error) {
    return { name, ok: false, detail: formatErr(error) }
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

async function main() {
  const checks: Promise<CheckResult>[] = [
    expectJsonValidation400(
      'Gateway challenge validation',
      `${gatewayApiBase}/node-registration/challenge`,
    ),
    expectJsonValidation400(
      'Gateway verify validation',
      `${gatewayApiBase}/node-registration/verify`,
    ),
    expectJsonValidation400(
      'DWS challenge validation',
      `${dwsBase}/node-registration/challenge`,
    ),
    expectJsonValidation400(
      'DWS verify validation',
      `${dwsBase}/node-registration/verify`,
    ),
    expectJson(`${dwsBase} staking health`, `${dwsBase}/staking/health`, (parsed) => {
      const obj = asObject(parsed)
      if (!obj) return 'response is not JSON object'
      if (obj.status !== 'healthy') return `unexpected status=${String(obj.status)}`
      if (obj.stakingManagerConfigured !== true) {
        return 'stakingManagerConfigured is not true'
      }
      return null
    }),
    expectJson(`${dwsBase} staking nodes`, `${dwsBase}/staking/nodes?limit=10&offset=0`, (parsed) => {
      const obj = asObject(parsed)
      if (!obj) return 'response is not JSON object'
      const nodes = obj.nodes
      if (!Array.isArray(nodes)) return 'nodes field is not an array'
      if (strictNodes && nodes.length === 0) return 'nodes array is empty'
      return null
    }),
    expectJson(
      `${dwsBase} staking operator`,
      `${dwsBase}/staking/operator/${operatorAddress}`,
      (parsed) => {
        const obj = asObject(parsed)
        if (!obj) return 'response is not JSON object'
        const nodes = obj.nodes
        if (!Array.isArray(nodes)) return 'nodes field is not an array'
        if (strictNodes && nodes.length === 0) return 'operator nodes array is empty'
        return null
      },
    ),
  ]

  const results = await Promise.all(checks)
  const maxName = results.reduce((m, r) => Math.max(m, r.name.length), 0)

  console.log('V3 rollout smoke results')
  console.log(`Gateway API: ${gatewayApiBase}`)
  console.log(`DWS base:    ${dwsBase}`)
  console.log(`Operator:    ${operatorAddress}`)
  console.log(`Strict node rows: ${strictNodes ? 'on' : 'off'}`)
  console.log('')

  for (const result of results) {
    const status = result.ok ? 'PASS' : 'FAIL'
    const name = result.name.padEnd(maxName, ' ')
    console.log(`[${status}] ${name} :: ${result.detail}`)
  }

  const failed = results.filter((r) => !r.ok)
  console.log('')
  console.log(
    `Summary: ${results.length - failed.length}/${results.length} checks passed`,
  )

  if (failed.length > 0) {
    process.exit(1)
  }
}

await main()
