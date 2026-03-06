import { runQoSServiceReporter, type NonStorageQoSModule } from './qos-service-reporter'
import { main as runStorageReporter } from './storage-reporter'
import { QOS_VALIDATOR_SERVICE_PROFILES } from './qos-validator-types'

function isNonStorageModule(value: string): value is NonStorageQoSModule {
  if (value === 'storage') return false
  return value in QOS_VALIDATOR_SERVICE_PROFILES
}

export async function main(): Promise<void> {
  const moduleName =
    process.env.QOS_VALIDATOR_MODULE ?? process.argv[2] ?? process.argv[3]

  if (!moduleName) {
    throw new Error(
      'Missing module. Set QOS_VALIDATOR_MODULE=<module> (for example: compute, rpc, cdn, da, vpn, proxy).',
    )
  }

  if (moduleName === 'storage') {
    await runStorageReporter()
    return
  }

  if (!isNonStorageModule(moduleName)) {
    throw new Error(`Unsupported QOS_VALIDATOR_MODULE=${moduleName}`)
  }

  await runQoSServiceReporter(moduleName)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[QoSV:service] Fatal error:', error)
    process.exit(1)
  })
}
