import { Globe, type LucideProps, Server, TrendingUp } from 'lucide-react'
import { type ComponentType, useState } from 'react'
import { useAccount } from 'wagmi'
import { useJejuAuth } from '@jejunetwork/auth/react'
import { ConnectPrompt } from './ConnectPrompt'
import MyNodesCard from './MyNodesCard'
import NetworkStatsCard from './NetworkStatsCard'
import RegisterNodeForm from './RegisterNodeForm'

const GlobeIcon = Globe as ComponentType<LucideProps>
const ServerIcon = Server as ComponentType<LucideProps>
const TrendingUpIcon = TrendingUp as ComponentType<LucideProps>

export default function NodeStakingTab() {
  const { isConnected } = useAccount()
  const { authenticated, walletAddress, loading } = useJejuAuth()
  const [activeSection, setActiveSection] = useState<
    'overview' | 'register' | 'my-nodes'
  >('overview')
  const hasAuthenticatedSession = Boolean(authenticated && walletAddress)

  return (
    <div className="animate-fade-in">
      <div
        className="nav-tab-container"
        style={{
          gridTemplateColumns: 'repeat(3, 1fr)',
          maxWidth: '360px',
          marginBottom: '1.5rem',
        }}
      >
        <button
          type="button"
          className={`button nav-tab ${activeSection === 'overview' ? '' : 'button-secondary'}`}
          onClick={() => setActiveSection('overview')}
        >
          <GlobeIcon size={16} />
          Overview
        </button>
        <button
          type="button"
          className={`button nav-tab ${activeSection === 'my-nodes' ? '' : 'button-secondary'}`}
          onClick={() => setActiveSection('my-nodes')}
        >
          <ServerIcon size={16} />
          My Nodes
        </button>
        <button
          type="button"
          className={`button nav-tab ${activeSection === 'register' ? '' : 'button-secondary'}`}
          onClick={() => setActiveSection('register')}
        >
          <TrendingUpIcon size={16} />
          Register
        </button>
      </div>
      {activeSection === 'overview' && <NetworkStatsCard />}
      {activeSection === 'my-nodes' &&
        (hasAuthenticatedSession ? (
          <MyNodesCard />
        ) : (
          <ConnectPrompt
            message={
              loading
                ? 'Checking authentication...'
                : isConnected
                  ? 'Sign in to view your nodes'
                  : 'Connect and sign in to view your nodes'
            }
            action="See your registered nodes, staking rewards, and status after authentication"
          />
        ))}
      {activeSection === 'register' &&
        (hasAuthenticatedSession ? (
          <RegisterNodeForm />
        ) : (
          <ConnectPrompt
            message={
              loading
                ? 'Checking authentication...'
                : isConnected
                  ? 'Sign in to register a node'
                  : 'Connect and sign in to register a node'
            }
            action="Stake tokens, join the network, and start earning rewards after authentication"
          />
        ))}
    </div>
  )
}
