import { Grid3x3, KeyRound, type LucideProps, Plus } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import AgentWalletMigrationCard from './AgentWalletMigrationCard'
import AppDetailModal from './AppDetailModal'
import { ConnectPrompt } from './ConnectPrompt'
import RegisterAppForm from './RegisterAppForm'
import RegisteredAppsList from './RegisteredAppsList'

const PlusIcon = Plus as ComponentType<LucideProps>
const Grid3x3Icon = Grid3x3 as ComponentType<LucideProps>
const KeyRoundIcon = KeyRound as ComponentType<LucideProps>

export default function RegistryTab() {
  const { isConnected } = useAccount()
  const [activeSection, setActiveSection] = useState<
    'list' | 'register' | 'wallets'
  >('list')
  const [selectedAppId, setSelectedAppId] = useState<bigint | null>(null)
  const [listRefreshKey, setListRefreshKey] = useState(0)

  useEffect(() => {
    const handleNavigateToRegister = () => setActiveSection('register')
    const handleNavigateToRegistryList = () => {
      setActiveSection('list')
      setListRefreshKey((current) => current + 1)
    }
    window.addEventListener('navigate-to-register', handleNavigateToRegister)
    window.addEventListener(
      'navigate-to-registry-list',
      handleNavigateToRegistryList,
    )
    return () => {
      window.removeEventListener(
        'navigate-to-register',
        handleNavigateToRegister,
      )
      window.removeEventListener(
        'navigate-to-registry-list',
        handleNavigateToRegistryList,
      )
    }
  }, [])

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
          className={`button nav-tab ${activeSection === 'list' ? '' : 'button-secondary'}`}
          onClick={() => setActiveSection('list')}
        >
          <Grid3x3Icon size={16} />
          Browse
        </button>
        <button
          type="button"
          className={`button nav-tab ${activeSection === 'register' ? '' : 'button-secondary'}`}
          onClick={() => setActiveSection('register')}
        >
          <PlusIcon size={16} />
          Register
        </button>
        <button
          type="button"
          className={`button nav-tab ${activeSection === 'wallets' ? '' : 'button-secondary'}`}
          onClick={() => setActiveSection('wallets')}
        >
          <KeyRoundIcon size={16} />
          Wallets
        </button>
      </div>
      {activeSection === 'list' && (
        <RegisteredAppsList
          key={listRefreshKey}
          onSelectApp={setSelectedAppId}
        />
      )}
      {activeSection === 'register' &&
        (isConnected ? (
          <RegisterAppForm />
        ) : (
          <ConnectPrompt
            message="Connect to register your identity"
            action="You'll need a wallet to sign and stake your registration"
          />
        ))}
      {activeSection === 'wallets' &&
        (isConnected ? (
          <AgentWalletMigrationCard />
        ) : (
          <ConnectPrompt
            message="Connect to migrate agent wallets"
            action="Set delegated wallet addresses with on-chain confirmation"
          />
        ))}
      {selectedAppId !== null && (
        <AppDetailModal
          agentId={selectedAppId}
          onClose={() => setSelectedAppId(null)}
        />
      )}
    </div>
  )
}
