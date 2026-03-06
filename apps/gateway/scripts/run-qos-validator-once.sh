#!/usr/bin/env bash
set -euo pipefail

MODULE="${1:-}"
SUBMIT_MODE="${2:-onchain}"

if [[ -z "$MODULE" ]]; then
  echo "Usage: $0 <module> [onchain|dryrun]"
  echo "Examples:"
  echo "  $0 storage onchain"
  echo "  $0 compute onchain"
  echo "  $0 da dryrun"
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

export JEJU_NETWORK="${JEJU_NETWORK:-testnet}"
export QOS_VALIDATOR_MODULE="$MODULE"
export QOS_VALIDATOR_RUN_ONCE=true
export QOS_VALIDATOR_REQUEST_TIMEOUT_MS="${QOS_VALIDATOR_REQUEST_TIMEOUT_MS:-20000}"
export QOS_VALIDATOR_PUBLISH_IDENTITY_METADATA="${QOS_VALIDATOR_PUBLISH_IDENTITY_METADATA:-false}"

# Keep slash execution disabled for run-once validation.
export QOS_VALIDATOR_ENABLE_AUTO_SLASHING="${QOS_VALIDATOR_ENABLE_AUTO_SLASHING:-false}"
export QOS_VALIDATOR_CHECK_SLASHING="${QOS_VALIDATOR_CHECK_SLASHING:-false}"
export QOS_VALIDATOR_EXECUTE_SLASHING="${QOS_VALIDATOR_EXECUTE_SLASHING:-false}"

if [[ "${SUBMIT_MODE}" == "onchain" ]]; then
  export QOS_VALIDATOR_SUBMIT_ON_CHAIN=true
  export QOS_VALIDATOR_REGISTER_AS_QOS_VALIDATOR="${QOS_VALIDATOR_REGISTER_AS_QOS_VALIDATOR:-true}"
else
  export QOS_VALIDATOR_SUBMIT_ON_CHAIN=false
  export QOS_VALIDATOR_REGISTER_AS_QOS_VALIDATOR=false
fi

if [[ -z "${QOS_VALIDATOR_PRIVATE_KEY:-}" && -n "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  export QOS_VALIDATOR_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY}"
fi

if [[ -z "${QOS_VALIDATOR_SERVICE_ID:-}" ]]; then
  export QOS_VALIDATOR_SERVICE_ID="qos-validator-${MODULE}"
fi

echo "[qosv-run-once] module=${MODULE} network=${JEJU_NETWORK} mode=${SUBMIT_MODE}"

cd "${APP_DIR}"
if [[ "${MODULE}" == "storage" ]]; then
  bun api/oracle/storage-reporter.ts
else
  bun api/oracle/service-reporter.ts
fi
