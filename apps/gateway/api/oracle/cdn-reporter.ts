import { runQoSServiceReporter } from './qos-service-reporter'

export async function main(): Promise<void> {
  await runQoSServiceReporter('cdn')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[QoSV:cdn] Fatal error:', error)
    process.exit(1)
  })
}
