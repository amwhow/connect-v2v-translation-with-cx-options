#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <transcript-api-url>"
  echo "Example: $0 https://abc123.execute-api.us-east-1.amazonaws.com/transcripts"
  exit 1
fi

TRANSCRIPT_API_URL="$1"

WEBAPP_BUCKET="$(npm run --silent echo:web-app-bucket)"
WEBAPP_PREFIX="$(npm run --silent echo:web-app-root-prefix)"
OBJECT_KEY="${WEBAPP_PREFIX}frontend-config.js"

TMP_DIR="$(mktemp -d)"
CONFIG_PATH="${TMP_DIR}/frontend-config.js"

aws s3 cp "s3://${WEBAPP_BUCKET}/${OBJECT_KEY}" "${CONFIG_PATH}"

CONFIG_PATH="${CONFIG_PATH}" TRANSCRIPT_API_URL="${TRANSCRIPT_API_URL}" node - <<'NODE'
const fs = require("fs");

const configPath = process.env.CONFIG_PATH;
const transcriptApiUrl = process.env.TRANSCRIPT_API_URL;

const content = fs.readFileSync(configPath, "utf8");
const match = content.match(/window\.WebappConfig\s*=\s*(\{[\s\S]*\})/);
if (!match) {
  throw new Error("Unable to locate window.WebappConfig in frontend-config.js");
}

const config = JSON.parse(match[1]);
config.transcriptApiUrl = transcriptApiUrl;
fs.writeFileSync(configPath, `window.WebappConfig = ${JSON.stringify(config)}`);
NODE

aws s3 cp "${CONFIG_PATH}" "s3://${WEBAPP_BUCKET}/${OBJECT_KEY}" --content-type "text/javascript"

echo "Updated s3://${WEBAPP_BUCKET}/${OBJECT_KEY} with transcriptApiUrl=${TRANSCRIPT_API_URL}"
