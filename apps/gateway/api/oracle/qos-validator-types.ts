export type QoSValidatorModule = 'storage' | 'rpc' | 'compute' | 'cdn'

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
}
