import { runQoSServiceReporter } from './qos-service-reporter'

export async function main(): Promise<void> {
  await runQoSServiceReporter('compute')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[QoSV:compute] Fatal error:', error)
    process.exit(1)
  })
}
