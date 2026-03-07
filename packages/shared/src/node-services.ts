export type NodeServiceId =
  | 'vpn'
  | 'cdn'
  | 'storage'
  | 'rpc'
  | 'compute'
  | 'gpu'
  | 'workers'
  | 'workerd'
  | 'agents'
  | 'git'
  | 'pkg'
  | 'ci'
  | 's3'
  | 'da'
  | 'email'
  | 'lb'
  | 'indexer'
  | 'scraping'
  | 'security'
  | 'observability'

export interface NodeServiceDefinition {
  id: NodeServiceId
  name: string
  description: string
  icon: string
}

export interface OperatorIdentityOption {
  id: string
  name?: string
  owner: string
}

export interface NodeIdentityMetadata {
  nodeName?: string
  operatorAgentId: string
  nodeId?: string
  rpcUrl: string
  region: string
  services: NodeServiceId[]
  serviceTags: string[]
  cpuCores?: number
  memoryGb?: number
  diskGb?: number
  zone?: string
  stakingToken: string
  stakeAmount: string
  rewardToken: string
  status: 'draft' | 'active' | 'inactive'
}

export interface NodeRegistrationDraft {
  operatorAgentId: string
  services: NodeServiceId[]
  stakeAmount: string
  stakingToken: string
  rewardToken: string
  rpcUrl: string
  region: string
  nodeName?: string
  zone?: string
  cpuCores?: number
  memoryGb?: number
  diskGb?: number
}

export interface NodeRegistrationResult {
  operatorAgentId: string
  nodeId?: string
  nodeIdentityId?: string
  nodeIdentityFallback?: boolean
  txHash?: `0x${string}`
}

export type NodeServiceScoreMap = Partial<Record<NodeServiceId, number>>

export const NODE_SERVICE_DEFINITIONS: NodeServiceDefinition[] = [
  { id: 'vpn', name: 'VPN Node', icon: 'shield', description: 'Route encrypted VPN traffic' },
  { id: 'cdn', name: 'CDN Edge', icon: 'globe', description: 'Cache and serve content' },
  { id: 'storage', name: 'Storage Node', icon: 'hard-drive', description: 'Store network data' },
  { id: 'rpc', name: 'RPC Provider', icon: 'radio', description: 'Serve blockchain queries' },
  { id: 'compute', name: 'Compute Node', icon: 'cpu', description: 'Run containers and workers' },
  { id: 'gpu', name: 'GPU Compute', icon: 'monitor', description: 'GPU inference and training' },
  { id: 'workers', name: 'Serverless Workers', icon: 'zap', description: 'Run serverless functions' },
  { id: 'workerd', name: 'V8 Isolates', icon: 'box', description: 'Lightweight V8 workloads' },
  { id: 'agents', name: 'AI Agent Host', icon: 'bot', description: 'Host ElizaOS AI agents' },
  { id: 'git', name: 'Git Repository', icon: 'git-branch', description: 'Host git repositories' },
  { id: 'pkg', name: 'Package Registry', icon: 'package', description: 'Host package registry' },
  { id: 'ci', name: 'CI/CD Runner', icon: 'play', description: 'Run CI/CD pipeline jobs' },
  { id: 's3', name: 'S3 Storage', icon: 'database', description: 'S3-compatible object storage' },
  { id: 'da', name: 'Data Availability', icon: 'layers', description: 'Data availability node' },
  { id: 'email', name: 'Email Relay', icon: 'mail', description: 'Decentralized email relay' },
  { id: 'lb', name: 'Load Balancer', icon: 'scale', description: 'Scale-to-zero load balancing' },
  { id: 'indexer', name: 'Indexer Node', icon: 'search', description: 'Index blockchain data' },
  { id: 'scraping', name: 'Web Scraper', icon: 'eye', description: 'Web scraping and extraction' },
  { id: 'security', name: 'Security Node', icon: 'lock', description: 'WAF and access control' },
  { id: 'observability', name: 'Observability', icon: 'eye', description: 'Logs, metrics, and traces' },
]

export function getNodeServiceMinimumStakeUsd(serviceCount: number, minStakeUsd = 1000) {
  return minStakeUsd * Math.max(serviceCount, 1)
}
