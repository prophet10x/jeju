import NodeRegistrationWizard from '../../components/NodeRegistrationWizard'

export default function RegisterNodePage() {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Register a Node</h1>
        <p className="page-subtitle">
          Stake tokens, select services, and register your node on-chain.
        </p>
      </div>

      <NodeRegistrationWizard />
    </div>
  )
}
