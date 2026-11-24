#!/usr/bin/env bash
# Run signal-cli by hand against the bot's account, with the same Java, data folder, and
# number the bridge uses (all read from config.toml), so the commands in docs/platforms/signal.md stay one short line.
#   scripts/signal-cli.sh --version
#   scripts/signal-cli.sh listGroups
# Stop the bridge first (stop the service): a second signal-cli on the account waits
# for the first instead of failing.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Bun reads and checks config.toml (HMP_CONFIG picks another file) and prints the four settings.
SETTINGS="$(bun -e '
  import { loadConfig } from "./src/config.ts";
  const signal = loadConfig().messaging.signal;
  console.log(JSON.stringify({ cli: signal.cliPath, data: signal.dataDir, java: signal.javaHome, bot: signal.botNumber }));
')"

SIGNAL_CLI="$(jq -r '.cli' <<<"$SETTINGS")"
JAVA="$(jq -r '.java' <<<"$SETTINGS")"
if [ -n "$JAVA" ]; then export JAVA_HOME="$JAVA"; fi

if [ "${1:-}" = "--version" ]; then
  exec "$SIGNAL_CLI" --version
fi

exec "$SIGNAL_CLI" --config "$(jq -r '.data' <<<"$SETTINGS")" -a "$(jq -r '.bot' <<<"$SETTINGS")" "$@"
