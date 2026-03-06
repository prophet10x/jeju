#!/usr/bin/env bash
set -euo pipefail

MODULE="${1:-}"
MODE="${2:-dryrun}"

if [[ -z "$MODULE" ]]; then
  echo "Usage: $0 <module> [onchain|dryrun]"
  echo "Example: $0 storage dryrun"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"

if [[ -f "${REPO_ROOT}/.env.testnet" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${REPO_ROOT}/.env.testnet"
  set +a
fi

export JEJU_NETWORK="testnet"

DWS_BASE="${QOS_VALIDATOR_DWS_BASE:-https://jeju-dws.fartbag.fun}"
NODE_STAKING_MANAGER="${QOS_VALIDATOR_NODE_STAKING_MANAGER:-0xd40B6b76CAac694daF416132142919aDB64F46d8}"
RPC_URL="${QOS_VALIDATOR_RPC_URL:-${JEJU_TESTNET_RPC_URL:-https://jeju-testnet.fartbag.fun/}}"

NODE_ID="${QOS_VALIDATOR_NODE_ID:-}"
if [[ -z "$NODE_ID" ]]; then
  if command -v cast >/dev/null 2>&1; then
    NODE_ID="$(cast call "$NODE_STAKING_MANAGER" 'getAllNodes()(bytes32[])' --rpc-url "$RPC_URL" | rg -o '0x[0-9a-fA-F]{64}' | head -n 1 || true)"
  fi
fi

if [[ -z "$NODE_ID" ]]; then
  echo "Could not determine node ID automatically."
  echo "Set QOS_VALIDATOR_NODE_ID and retry."
  exit 1
fi

export QOS_VALIDATOR_NODE_ID="$NODE_ID"
export QOS_VALIDATOR_ENDPOINT_OVERRIDES="${NODE_ID}=${DWS_BASE}"

echo "[qosv-testnet] module=${MODULE} mode=${MODE} nodeId=${NODE_ID} dws=${DWS_BASE}"

cd "$APP_DIR"
bash scripts/run-qos-validator-once.sh "$MODULE" "$MODE"
