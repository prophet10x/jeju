# Jeju L2 Testnet Deployment

Live testnet deployed on OP Stack, connected to Sepolia L1.

## Network Info

| Field | Value |
|-------|-------|
| Chain ID | `420690` (`0x66b32`) |
| L1 | Sepolia (`11155111`) |
| RPC | `https://jeju-testnet.fartbag.fun/` |
| WebSocket | `wss://jeju-testnet.fartbag.fun/ws` |
| Bundler (ERC-4337) | `https://jeju-testnet.fartbag.fun/bundler` |
| Block Time | 2 seconds |
| Fork Level | Isthmus + Jovian (all forks at genesis) |
| DA Type | Blobs (EIP-4844) |

## Add to Wallet

```json
{
  "chainId": "0x66b32",
  "chainName": "Jeju Testnet",
  "rpcUrls": ["https://jeju-testnet.fartbag.fun/"],
  "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 }
}
```

## Deployer

| Role | Address |
|------|---------|
| Contract Deployer | `0x86d240bFf6C1Fdc0A5a4D7e371E59F0938f1666c` |
| Batcher (Sepolia) | `0xa81aEa6814b9bF322E4791aC9F3bb05495437c42` |

## L1 Contracts (Sepolia)

| Contract | Address |
|----------|---------|
| DisputeGameFactory | `0xFb746754bAc2D52bf488C5f470a078eD693643d3` |
| L1CrossDomainMessenger | `0x0B01d94FcB444660df4699DD7C379a20875E3c36` |
| OptimismPortal2 | `0x9d484A3c375E5faAEe6202fc0622342E128b6326` |
| SystemConfig | `0xF1D47AF01ea6C17f7E8F3Ad2edee603ab8b189eB` |

## L2 Contracts (Deployed Feb 22 2026)

### Core Infrastructure (Deploy.s.sol)

| Contract | Address |
|----------|---------|
| PriceOracle | `0xb10c232987ddce181b008d64ec5697a88bd126d1` |
| ServiceRegistry | `0xefc5a8c31cfd2a693e0169790421076916405083` |
| IdentityRegistry | `0xd69811b544a76bf6c995a4a5263b648fa7b59082` |
| ReputationRegistry | `0xe10d8b33a678f292e979d34a178b7297e0ca9469` |
| ValidationRegistry | `0x62fae7515077becff8f7cda15ac13d39e85f8d7e` |
| BanManager | `0x2117e8d850387338b516e85651d80919f799ad64` |
| ReputationLabelManager | `0xd5eafc2842b003d1e4c1bc2a950d0eafc5ac4345` |

### Tokens

| Contract | Address |
|----------|---------|
| USDC (NetworkUSDC) | `0x3eb934d56d14fa073ef859c13a7ab9c5f8eeb948` |
| JEJU Token | `0xb224f7607215139130ea79111358c1908e69f30e` |
| ELIZAOS Token | `0xf5f918b88fecd8efc5fc9a9dad9e95213e168915` |
| CreditManager | `0x6cfc5f9b0e5fe29470778b018aaaeb014281ea19` |

### ERC-4337 Account Abstraction

| Contract | Address |
|----------|---------|
| EntryPoint v0.7 (canonical genesis) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| EntryPoint (new deployment) | `0x8332e76e40805ac9b06f3b11c1f415d608f66db3` |

### Paymaster Stack

| Contract | Address |
|----------|---------|
| TokenRegistry | `0x6d8a467a29e4da4b53345555ae7d628e741a40a8` |
| PaymasterFactory | `0xe4abfd2e67240dfffa8433e04df094f3b5206272` |
| MultiTokenPaymaster | `0xfc86aeccf568e966c404387037195eee2f97f51d` |
| CrossChainPaymaster | `0xd4c0a4f86870576c7103c20174aa3a36ea107136` |
| L1StakeManager | `0x81ba38fd34f342f81646f22c8452167c297d8bd6` |

### OIF (Open Intents Framework)

| Contract | Address |
|----------|---------|
| SolverRegistry | `0x2962566c122941412a8e30beaa62b235f88f912f` |
| SimpleOracle | `0x3e145f1c100ecbf6ceaa02e1d4cea8a936063b38` |
| InputSettler | `0x6694b781852a94f885927b114704b83b4222fc21` |
| OutputSettler | `0x0c349d357a006ae32af7cd56479384f740d74003` |

### X402 Payment Protocol

| Contract | Address |
|----------|---------|
| X402Facilitator | `0x4e5cacedc21c554b16748d1dbdb3ba414f8e4181` |
| X402IntentBridge | `0x517a57f43c34abb3a49de4aefcc84250f3063712` |

### JNS (Jeju Name Service)

| Contract | Address |
|----------|---------|
| JNSRegistry | `0x8a791620dd6260079bf849dc5567adc3f2fdc318` |
| JNSResolver | `0x610178da211fef7d417bc0e6fed39f05609ad788` |
| JNSRegistrar | `0xb7f8bc63bbcad18155201308c8f3540b07f84f5e` |
| JNSReverseRegistrar | `0xa51c1fc2f0d1a1b8494ed1fe312d7c3a78ed91c0` |

### DWS (Decentralized Web Services)

| Contract | Address |
|----------|---------|
| StorageManager | `0x3aa5ebb10dc797cac828524e59a333d0a371443c` |
| WorkerRegistry | `0xc6e7df5e7b4f2a278906862b61205850344d4e7d` |
| CDNRegistry | `0x59b670e9fa9d0a427751af201d676719a970857b` |
| RepoRegistry | `0x4ed7c70f96b99c776995fb64377f0d4ab3b0e1c1` |
| PackageRegistry | `0x322813fd9a801c5507c9de605d63cea4f2ce6c44` |
| DWSMarketplace | `0x5b73c5498c1e3b4dba84de0f1833c4a029d90519` |

### TEE (Trusted Execution Environment)

| Contract | Address |
|----------|---------|
| UnifiedAttestationVerifier | `0x22c41faeb5b70e61c56c04fdb0cd880ebd971ad5` |
| TEERegistry | `0xb62a9de44c64b354ceb9ce1e53443ee24cbcb4dc` |

### Compute & Serverless Workers

| Contract | Address |
|----------|---------|
| ComputeRegistry | `0xa82ff9afd8f496c3d6ac40e2a0f282e47488cfc9` |
| LedgerManager | `0xdbd0ff6c9280f4a335eb23d2565c861bf17e2414` |
| InferenceServing | `0x12fe1fb20900337c295c85af671a88bc7548e08c` |

### Training & AI

| Contract | Address |
|----------|---------|
| ComputeRegistry (Training) | `0xf3ed251d634d1ce275f8e8748bcfc4f96520b2f1` |
| MPCKeyRegistry | `0x544ab0facf5457e0e88d30fd118dfe5191b3f6ec` |
| TrainingCoordinator | `0x14d0a76667604c189183f251c4b62bdad9658148` |
| TrainingRewards | `0xf04493f4b4e7c0baf93e23379ffb78b18769d971` |
| TrainingRegistry | `0x11d523effbad1462e63beedc79fd2fe8fc8f2f07` |
| NodePerformanceOracle | `0xbb0a3554af6792436609d21bcd703b9ef70ee7aa` |

### Decentralization

| Contract | Address |
|----------|---------|
| SequencerRegistry | `0xfff980e4c02497b59bbcc407a4b6cd7fe73c03b6` |
| ThresholdBatchSubmitter | `0xb391c2241a8fbdd7613c1d0c25395fb687c5959c` |
| GovernanceTimelock | `0x2d47410261a156cefae5ae5a6ca3f597d7612ba1` |
| DisputeGameFactory | `0x25094b9e10b47fa8a8094b18695d6a5b2d1c2a97` |
| ForcedInclusion | `0xdd839e3afd2472e3cbee740396fd3a9ca7441808` |
| CannonProver | `0xebe9b937a724f6b366fd38359e67acf751928598` |
| L2OutputOracleAdapter | `0x78e41ae212154fbdf68f7859cabf775a5a7699a9` |
| OptimismPortalAdapter | `0xc7f6f7b66d26308392dc1dd34abfdbd56903ac40` |
| PreimageOracle | `0x44ffba0a689de595c7d9501db26a131021cb3108` |
| MIPS | `0x8446e5e94a02f3aa96dce377df212e10700f1bba` |

### Data Availability

| Contract | Address |
|----------|---------|
| DAOperatorRegistry | `0xadf2e94136ebba745bd5151fcdd9657dfdf5db70` |
| DABlobRegistry | `0xc917bbb012d63300992c94312567e0fa82e99916` |
| DAAttestationManager | `0x130b23f59119e7c8f1ca0cdf375ebdb6c2781c63` |

### Decentralized RPC

| Contract | Address |
|----------|---------|
| MultiChainRPCRegistry | `0x2e2ed0cfd3ad2f1d34481277b3204d807ca2f8c2` |
| BandwidthRewards | `0xd8a5a9b31c3c0232e196d518e89fd8bf83acad43` |
| UsageRewardDistributor | `0xdc11f7e700a4c898ae5caddb1082cffa76512add` |

### Federation

| Contract | Address |
|----------|---------|
| NetworkRegistry | `0xac7a8a00aae63f2c6220d8c471870228b5c180ab` |
| RegistryHub | `0x4b87840caee7df61efa29df64a1002402e8b6b50` |
| RegistrySyncOracle | `0xacd15425d4daab8afcad3268023b890d39aa864f` |
| SolanaVerifier | `0x675e78fd4f550fc124366eda4b8573814da4dc27` |
| FederatedIdentity | `0x6620b1dad7c56fc99807d24b379a8c1450227a55` |
| FederatedLiquidity | `0xf3687c8a8b3a9b3a874b8a091559395432a4fd9d` |
| FederatedSolver | `0xcaa6da5a9bae5d5597edbc2cb533eccea45d9fd1` |

### DAO & Governance

| Contract | Address |
|----------|---------|
| FeeConfig | `0x563a1cb3a1b8fb106916fde7de702bc2e5bd704b` |
| DAORegistry | `0x8a2fab7e60a3041c5fc142d3f60941859e33612c` |
| DAOFunding | `0xd09faa0a824605760d48ca04d32add8db47ab8bc` |
| BoardGovernance | `0x1ee48e51d8266be9b038db37ab55c935ecac9ef1` |

### Commerce

| Contract | Address |
|----------|---------|
| AuthCaptureEscrow | `0x86df59517b75aa47e6e19a5e2b07c359c098dc98` |

### Liquidity

| Contract | Address |
|----------|---------|
| RiskSleeve | `0x1908ec79e5c8e6b17a9c6c56ead9014555e7210d` |

### Content & Git

| Contract | Address |
|----------|---------|
| ContentRegistry | `0x47c9b4bb4680163cff384b184acc1d12ef75295a` |
| RepoRegistry (GitPkg) | `0x5b73c5498c1e3b4dba84de0f1833c4a029d90519` |
| PackageRegistry (GitPkg) | `0x7fa9385be102ac3eac297483dd6233d62b3e1496` |

### Crucible

| Contract | Address |
|----------|---------|
| AgentVault | `0xa539885c451072af0bca62f570b8ad296823830a` |
| RoomRegistry | `0xf271726f1d23cc5969445c0c1cdf502836253845` |
| TriggerRegistry | `0x58a55dc97a3bba3cd16d927e3ed5b3c90f8e1a4c` |

### Proof of Cloud

| Contract | Address |
|----------|---------|
| ProofOfCloudValidator | `0xbb1508040daeff7c1d4d6e8b4fe714f519676a13` |

### SQLit

| Contract | Address |
|----------|---------|
| SQLitIdentityRegistry | `0x5b73c5498c1e3b4dba84de0f1833c4a029d90519` |

## Not Yet Deployed

These contracts have deploy scripts but failed due to missing dependencies or env vars:

| Contract Suite | Script | Reason |
|---------------|--------|--------|
| DWS Infrastructure | `DeployDWSInfra.s.sol` | Deployed on-chain but broadcast not captured (vm.writeFile error) |
| Governance Timelocks | `DeployGovernance.s.sol` | Deployed on-chain but broadcast not captured (vm.writeFile error) |
| App Fee Registry | `DeployAppFeeRegistry.s.sol` | Missing `FEE_DISTRIBUTOR` env var |
| Cross-Chain (Testnet) | `DeployTestnetCrossChain.s.sol` | Contract not found in build |

### Contracts Without Deploy Scripts

The following contract categories exist in source but don't have dedicated deploy scripts yet:

| Category | Source Directory | Key Contracts |
|----------|-----------------|---------------|
| Staking | `src/staking/` | NodeStakingManager, AutoSlasher, ServiceStaking |
| Moderation | `src/moderation/` | VoterSlashing (BanManager deployed above) |
| AMM/DEX | `src/amm/` | UniswapV4 hooks, TFMM strategies |
| Perps | `src/perps/` | Perpetual futures contracts |
| Prediction | `src/prediction/` | Prediction market contracts |
| VPN | `src/vpn/` | VPN registry and billing |
| Launchpad | `src/launchpad/` | Token launchpad |
| Messaging | `src/messaging/` | On-chain messaging |
| NFTs | `src/nfts/` | NFT contracts |
| KMS | `src/kms/` | Key management service |
| OAuth3 | `src/oauth3/` | On-chain OAuth |
| Games | `src/games/` | Gaming contracts |
| Email | `src/email/` | Email verification |
| OTC | `src/otc/` | OTC trading desk |
| Containers | `src/containers/` | Container registry |
| Keepalive | `src/keepalive/` | Node keepalive |
| Rewards | `src/rewards/` | Reward distribution |
| Security | `src/security/` | Security contracts |
| MEV | `src/mev/` | MEV protection |
| Dispute | `src/dispute/` | Dispute resolution (Factory deployed above) |
| Bandwidth | `src/bandwidth/` | Bandwidth tracking |
| Escrow | `src/escrow/` | General escrow |
| Safe | `src/safe/` | Safe multisig integration |
| Distributor | `src/distributor/` | Token distribution |
| Funding | `src/funding/` | Funding mechanisms |
| Treasury | `src/treasury/` | Treasury management |
| Marketplace | `src/marketplace/` | General marketplace |
| Models | `src/models/` | ML model contracts |
| Proxy | `src/proxy/` | Upgradeable proxy patterns |

## Services

| Service | Port | Endpoint |
|---------|------|----------|
| op-geth (RPC) | 9545 | `https://jeju-testnet.fartbag.fun/` |
| op-geth (WS) | 9546 | `wss://jeju-testnet.fartbag.fun/ws` |
| op-node | 7545 | internal |
| op-batcher | 6545 | internal (blob DA) |
| Alto Bundler | 4337 | `https://jeju-testnet.fartbag.fun/bundler` |
| PoW Faucet | 8088 | `https://jeju-testnet.fartbag.fun/faucet/` |
| Gateway API | 4013 | `https://jeju-testnet.fartbag.fun/gateway/` |
| DWS Console | 4030 | `http://52.206.203.24/` (AWS) |
| Block Explorer | 5100 | `https://jeju-testnet.fartbag.fun/explorer/` |

## Block Explorer (Blockscout)

[Blockscout](https://github.com/blockscout/blockscout) provides a full-featured block explorer at `/explorer/`.

**Architecture:**
- **Backend** (Elixir) — indexes blocks/transactions from op-geth via JSON-RPC, stores in PostgreSQL
- **Frontend** (Next.js) — serves the explorer UI
- **Proxy** (nginx) — routes between frontend and backend API
- **External nginx** — serves everything under `/explorer/` subpath with static asset path rewriting

**Server:** Oracle (192.9.153.231), deployed at `~/blockscout/docker-compose/`

**Key configuration:**
- Backend connects to op-geth via Docker network (`jeju-l2-network`) at `http://jeju-op-geth:9545/`
- Frontend uses `NEXT_PUBLIC_API_BASE_PATH=/explorer` for API path prefixing
- WebSocket protocol set to `wss` (site served over HTTPS)
- NFT media handler disabled (not needed, avoids permission issues)
- `services/frontend.yml` must NOT have `platform: linux/amd64` (server is ARM64)

**Compose file:** [`packages/deployment/docker/blockscout-explorer.compose.yaml`](packages/deployment/docker/blockscout-explorer.compose.yaml)

**Management:**
```bash
ssh ubuntu@192.9.153.231
cd ~/blockscout/docker-compose

# Start/restart
docker compose -f docker-compose-jeju.yml up -d

# View logs
docker compose -f docker-compose-jeju.yml logs -f backend
docker compose -f docker-compose-jeju.yml logs -f frontend

# Full recreate (after config changes)
docker compose -f docker-compose-jeju.yml up -d --force-recreate
```

**nginx config** (`/etc/nginx/sites-enabled/jeju-testnet`):
```nginx
location /explorer/ {
    proxy_pass http://127.0.0.1:5100/;
    # ... standard proxy headers ...
    # Only rewrite static asset paths (_next, assets, static, icons)
    # API/socket paths are handled by NEXT_PUBLIC_API_BASE_PATH
    sub_filter_once off;
    sub_filter_types text/html application/javascript text/css;
    sub_filter '"/_next/' '"/explorer/_next/';
    sub_filter "'/_next/" "'/explorer/_next/";
    sub_filter '"/assets/' '"/explorer/assets/';
    sub_filter '"/static/' '"/explorer/static/';
    sub_filter '"/icons/' '"/explorer/icons/';
    proxy_set_header Accept-Encoding "";
}
```

## Deployment History

- **Feb 28, 2026**: Added Blockscout block explorer at `/explorer/`. Deployed via Docker Compose on Oracle server.
- **Feb 22, 2026**: Full redeployment with new deployer key (`0x86d240...`). 97 contracts across 24 deploy scripts. Switched batcher to blob DA.
- **Feb 21, 2026**: 22,428-block reorg caused by batcher running out of Sepolia ETH. All post-genesis contracts lost.
- **Feb 21, 2026**: Initial deployment on Sepolia L1.
