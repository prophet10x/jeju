import {
  runNodeMetadataReplicationOnce,
} from '../api/services/node-metadata-replication'

function parseIntervalMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000
}

async function runLoop() {
  const runOnce = (process.env.NODE_METADATA_REPLICATION_RUN_ONCE ?? '')
    .trim()
    .toLowerCase()
  const shouldRunOnce = ['1', 'true', 'yes', 'on'].includes(runOnce)
  const intervalMs = parseIntervalMs(
    process.env.NODE_METADATA_REPLICATION_INTERVAL_MS,
  )

  const execute = async () => {
    const summary = await runNodeMetadataReplicationOnce()
    console.log(
      JSON.stringify(
        {
          service: 'node-metadata-replication',
          at: new Date().toISOString(),
          ...summary,
        },
        null,
        2,
      ),
    )
  }

  await execute()
  if (shouldRunOnce) return

  setInterval(() => {
    void execute().catch((error) => {
      console.error(
        '[node-metadata-replication] cycle failed:',
        error instanceof Error ? error.message : error,
      )
    })
  }, intervalMs)
}

runLoop().catch((error) => {
  console.error(
    '[node-metadata-replication] fatal:',
    error instanceof Error ? error.message : error,
  )
  process.exitCode = 1
})
