import { runQoSServiceReporter } from './qos-service-reporter'

export async function main(): Promise<void> {
  await runQoSServiceReporter('rpc')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[QoSV:rpc] Fatal error:', error)
    process.exit(1)
  })
}
