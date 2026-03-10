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
  await dismissBlockingModals(page)
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

async function dismissBlockingModals(page: Page) {
  const closeButtons = page.getByRole('button', {
    name: /close transaction status|close/i,
  })
  const count = await closeButtons.count().catch(() => 0)
  for (let i = 0; i < count; i += 1) {
    const button = closeButtons.nth(i)
    const visible = await button.isVisible().catch(() => false)
    if (!visible) continue
    await button.click({ timeout: 2_000 }).catch(() => {})
    await page.waitForTimeout(150)
  }
  await page.keyboard.press('Escape').catch(() => {})
}

async function clickIfEnabled(
  page: Page,
  actionName: string,
  buttonNames: string[],
): Promise<boolean> {
  const result = await clickByButtonText(page, actionName, buttonNames)
  return result.clicked
}

async function ensureStepReadyForProof(page: Page) {
  for (let i = 0; i < 8; i += 1) {
    await ensureRpcInput(page)

    const prepareProofButton = page.getByRole('button', {
      name: /prepare proof|prepare ownership proof/i,
    })
    if ((await prepareProofButton.count()) > 0) {
      const visible = await prepareProofButton.first().isVisible().catch(() => false)
      if (visible) return
    }

    // Service step helper.
    await clickIfEnabled(page, 'pick-all-services', ['Pick all'])

    // Generic wizard progression.
    const progressed = await clickIfEnabled(page, 'continue-step', [
      '^Continue$',
      '^Next$',
    ])
    if (!progressed) {
      await page.waitForTimeout(700)
      continue
    }

    await page.waitForTimeout(1200)
  }
}

async function tryDismissOnboarding(page: Page) {
  const dismissNames = ['Skip tour', 'Skip', 'Close']
  for (const name of dismissNames) {
    const button = page.getByRole('button', {
      name: new RegExp(name, 'i'),
    })
    if ((await button.count()) === 0) continue
    const first = button.first()
    if (!(await first.isVisible().catch(() => false))) continue
    await first.click({ timeout: 5_000 }).catch(() => {})
    await page.waitForTimeout(500)
  }

  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(500)
}

async function ensureRegistrationContext(page: Page) {
  await tryDismissOnboarding(page)
  if (APP_TARGET === 'gateway') {
    await clickByButtonText(page, 'open-register-tab', ['Register'])
  } else {
    await clickByButtonText(page, 'open-register-route', [
      'Run a Node',
      'Register Node',
      'Register',
    ])
  }
  await page.waitForTimeout(1_000)

  // Force canonical registration URL after auth redirects.
  if (page.url() !== BASE_URL) {
    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    await page.waitForTimeout(1_000)
  }
  await tryDismissOnboarding(page)
}

async function ensureRpcInput(page: Page) {
  const endpoint = `${new URL(BASE_URL).origin}/`
  const byLabel = page.getByLabel(/rpc|endpoint/i)
  const byUrlInput = page.locator('input[type="url"]')
  const byHttpsPlaceholder = page.locator('input[placeholder*="https://"]')
  const candidates = [byLabel, byUrlInput, byHttpsPlaceholder]

  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0)
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i)
      const visible = await candidate.isVisible().catch(() => false)
      if (!visible) continue
      await candidate.fill(endpoint).catch(() => {})
      await page.waitForTimeout(200)
    }
  }

  return endpoint
}

async function ensureAuthenticated(page: Page) {
  for (let i = 0; i < 5; i += 1) {
    await dismissBlockingModals(page)
    const headerSignIn = page.getByRole('button', { name: /^sign in$/i }).first()
    const signInVisible = await headerSignIn.isVisible().catch(() => false)

    if (signInVisible) {
      await headerSignIn.click({ timeout: 8_000 }).catch(() => {})
      await page.waitForTimeout(1_000)
    }

    const connectWalletButton = page
      .getByRole('button', { name: /^connect wallet$/i })
      .first()
    if (await connectWalletButton.isVisible().catch(() => false)) {
      await connectWalletButton.click({ timeout: 8_000 }).catch(() => {})
      await page.waitForTimeout(1_200)
    } else {
      const walletConnector = page
        .getByRole('button')
        .filter({
          hasText: /guest|test wallet|wallet|injected|metamask|rabby/i,
        })
      if ((await walletConnector.count().catch(() => 0)) > 0) {
        const target = walletConnector.first()
        const label = (await target.innerText().catch(() => '')).toLowerCase()
        if (
          !/google|github|discord|twitter|email|password|farcaster/.test(label)
        ) {
          await target.click({ timeout: 8_000 }).catch(() => {})
          await page.waitForTimeout(1_200)
        }
      }
    }

    await tryDismissOnboarding(page)
    await page.waitForTimeout(800)

    const gateText = await page
      .getByText(/sign in to register a node/i)
      .first()
      .isVisible()
      .catch(() => false)
    const stillHasSignIn = await headerSignIn.isVisible().catch(() => false)
    if (!gateText && !stillHasSignIn) return
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
    await ensureRegistrationContext(page)
    await capture(page, '01-loaded')

    actions.push(
      await clickByButtonText(page, 'open-sign-in', ['^Sign In$']),
    )
    await page.waitForTimeout(2_000)
    await ensureAuthenticated(page)
    await ensureRegistrationContext(page)
    await ensureRpcInput(page)
    await ensureStepReadyForProof(page)
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
    await ensureStepReadyForProof(page)
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
