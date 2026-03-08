import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Page } from 'playwright'

type FlowAction = {
  action: string
  attempted: boolean
  clicked: boolean
  skippedReason?: string
  error?: string
}

const APP_TARGET = (process.env.JEJU_APP_TARGET ?? 'dws').toLowerCase()
const BASE_URL =
  process.env.JEJU_BASE_URL ??
  (APP_TARGET === 'gateway'
    ? 'https://jeju-testnet.fartbag.fun/gateway/nodes'
    : 'https://jeju-dws.fartbag.fun/provider/node/register')
const HEADLESS = process.env.HEADLESS !== 'false'

const runId = new Date().toISOString().split(':').join('-')
const outputDir = resolve(
  process.cwd(),
  'output',
  'playwright',
  `node-registration-${APP_TARGET}-${runId}`,
)

function extractTxHashes(text: string): string[] {
  return Array.from(new Set(text.match(/0x[a-fA-F0-9]{64}/g) ?? []))
}

async function capture(page: Page, name: string) {
  await page.screenshot({
    path: resolve(outputDir, `${name}.png`),
    fullPage: true,
  })
}

async function clickByButtonText(
  page: Page,
  actionName: string,
  buttonNames: string[],
): Promise<FlowAction> {
  for (const buttonName of buttonNames) {
    const locator = page.getByRole('button', {
      name: new RegExp(buttonName, 'i'),
    })
    if ((await locator.count()) === 0) continue

    const first = locator.first()
    const isVisible = await first.isVisible().catch(() => false)
    if (!isVisible) continue

    const isDisabled = await first.isDisabled().catch(() => true)
    if (isDisabled) {
      return {
        action: actionName,
        attempted: true,
        clicked: false,
        skippedReason: `Button "${buttonName}" is disabled`,
      }
    }

    try {
      await first.click({ timeout: 10_000 })
      await page.waitForTimeout(2_000)
      return {
        action: actionName,
        attempted: true,
        clicked: true,
      }
    } catch (error) {
      return {
        action: actionName,
        attempted: true,
        clicked: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    action: actionName,
    attempted: false,
    clicked: false,
    skippedReason: 'Button not found',
  }
}

async function run() {
  await mkdir(outputDir, { recursive: true })

  const browser = await chromium.launch({ headless: HEADLESS })
  const context = await browser.newContext()
  const page = await context.newPage()

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedRequests: Array<{ url: string; status?: number; text?: string }> =
    []

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })
  page.on('response', async (response) => {
    if (response.ok()) return
    const url = response.url()
    if (!/node-registration|staking|identity|kms|bundler|gateway|provider/i.test(url))
      return
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    failedRequests.push({
      url,
      status: response.status(),
      text: text.slice(0, 500),
    })
  })

  const actions: FlowAction[] = []

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(2_000)
    await capture(page, '01-loaded')

    actions.push(
      await clickByButtonText(page, 'connect-wallet', ['Connect Wallet']),
    )
    await capture(page, '02-after-connect')

    actions.push(
      await clickByButtonText(page, 'prepare-proof', [
        'Prepare Proof',
        'Prepare Ownership Proof',
      ]),
    )
    await capture(page, '03-after-prepare')

    actions.push(
      await clickByButtonText(page, 'authorize-node-wallet', [
        'Authorize Node Wallet',
        'Authorize',
      ]),
    )
    await capture(page, '04-after-authorize')

    actions.push(
      await clickByButtonText(page, 'verify-endpoint-ownership', [
        'Verify Endpoint Ownership',
        'Verify Proof',
      ]),
    )
    await capture(page, '05-after-verify')

    actions.push(
      await clickByButtonText(page, 'stake-register-node', [
        'Stake and Register Node',
        'Stake & Register Node',
        'Register Node',
        'Confirm & Stake',
      ]),
    )
    await capture(page, '06-after-stake')
  } finally {
    const bodyText = await page.locator('body').innerText().catch(() => '')
    const report = {
      appTarget: APP_TARGET,
      baseUrl: BASE_URL,
      outputDir,
      capturedAt: new Date().toISOString(),
      actions,
      txHashes: extractTxHashes(bodyText),
      consoleErrors,
      pageErrors,
      failedRequests,
    }
    await writeFile(
      resolve(outputDir, 'report.json'),
      JSON.stringify(report, null, 2),
      'utf8',
    )
    await browser.close()
    console.log(`Playwright node flow artifacts written to: ${outputDir}`)
    console.log(`Report: ${resolve(outputDir, 'report.json')}`)
  }
}

run().catch((error) => {
  console.error(
    error instanceof Error ? error.stack ?? error.message : String(error),
  )
  process.exitCode = 1
})
