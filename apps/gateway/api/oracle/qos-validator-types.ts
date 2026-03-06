export type QoSValidatorModule =
  | 'storage'
  | 'rpc'
  | 'compute'
  | 'gpu'
  | 'cdn'
  | 'agents'
  | 'email'
  | 'security'
  | 'observability'
  | 'a2a'
  | 'api-marketplace'
  | 'ci'
  | 'containers'
  | 'da'
  | 'dws-services'
  | 'edge'
  | 'exec'
  | 'funding'
  | 'git'
  | 'indexer'
  | 'kms'
  | 'lb'
  | 'moderation'
  | 'nitro-database'
  | 'oauth3'
  | 'pkg'
  | 'prices'
  | 'proxy'
  | 'pypkg'
  | 'releases'
  | 's3'
  | 'staking'
  | 'vpn'
  | 'workers'
  | 'workerd'

export type QoSValidatorMetricWeights = {
  uptime: number
  latency: number
  volume: number
}

export interface QoSValidatorServiceProfile {
  module: QoSValidatorModule
  serviceId: string
  displayName: string
  metrics: QoSValidatorMetricWeights
}

const BASELINE_WEIGHTS: QoSValidatorMetricWeights = {
  uptime: 0.5,
  latency: 0.25,
  volume: 0.25,
}

function baselineProfile(module: Exclude<QoSValidatorModule, 'storage' | 'rpc' | 'compute' | 'cdn'>): QoSValidatorServiceProfile {
  return {
    module,
    serviceId: `qos-validator-${module}`,
    displayName: `QoSV/${module}`,
    metrics: BASELINE_WEIGHTS,
  }
}

export const QOS_VALIDATOR_SERVICE_PROFILES: Record<
  QoSValidatorModule,
  QoSValidatorServiceProfile
> = {
  storage: {
    module: 'storage',
    serviceId: 'qos-validator-storage',
    displayName: 'QoSV/storage',
    metrics: {
      uptime: 0.4,
      latency: 0.3,
      volume: 0.3,
    },
  },
  rpc: {
    module: 'rpc',
    serviceId: 'qos-validator-rpc',
    displayName: 'QoSV/rpc',
    metrics: {
      uptime: 0.5,
      latency: 0.3,
      volume: 0.2,
    },
  },
  compute: {
    module: 'compute',
    serviceId: 'qos-validator-compute',
    displayName: 'QoSV/compute',
    metrics: {
      uptime: 0.4,
      latency: 0.2,
      volume: 0.4,
    },
  },
  gpu: {
    module: 'gpu',
    serviceId: 'qos-validator-gpu',
    displayName: 'QoSV/gpu',
    metrics: {
      uptime: 0.35,
      latency: 0.15,
      volume: 0.5,
    },
  },
  cdn: {
    module: 'cdn',
    serviceId: 'qos-validator-cdn',
    displayName: 'QoSV/cdn',
    metrics: {
      uptime: 0.4,
      latency: 0.35,
      volume: 0.25,
    },
  },
  agents: baselineProfile('agents'),
  email: baselineProfile('email'),
  security: baselineProfile('security'),
  observability: baselineProfile('observability'),
  a2a: baselineProfile('a2a'),
  'api-marketplace': baselineProfile('api-marketplace'),
  ci: baselineProfile('ci'),
  containers: baselineProfile('containers'),
  da: baselineProfile('da'),
  'dws-services': baselineProfile('dws-services'),
  edge: baselineProfile('edge'),
  exec: baselineProfile('exec'),
  funding: baselineProfile('funding'),
  git: baselineProfile('git'),
  indexer: baselineProfile('indexer'),
  kms: baselineProfile('kms'),
  lb: baselineProfile('lb'),
  moderation: baselineProfile('moderation'),
  'nitro-database': baselineProfile('nitro-database'),
  oauth3: baselineProfile('oauth3'),
  pkg: baselineProfile('pkg'),
  prices: baselineProfile('prices'),
  proxy: baselineProfile('proxy'),
  pypkg: baselineProfile('pypkg'),
  releases: baselineProfile('releases'),
  s3: baselineProfile('s3'),
  staking: baselineProfile('staking'),
  vpn: baselineProfile('vpn'),
  workers: baselineProfile('workers'),
  workerd: baselineProfile('workerd'),
}
