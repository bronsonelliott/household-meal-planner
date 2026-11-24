// A stand-in for src/bridge.ts so tests can watch the process exit code.
// It does what the bridge's messenger start must do: startMessengerOrExit, which exits non-zero on
// a failed start-up check or when the adapter's connection dies.
//
// Usage: bun run-messenger.ts <config.json>

import { readFileSync } from "node:fs";
import { startMessengerOrExit } from "../../src/messaging/messenger.ts";
import { SignalAdapter } from "../../src/messaging/signal/adapter.ts";
import type { TestConfig } from "./signal-harness.ts";

const config: TestConfig = JSON.parse(readFileSync(process.argv[2], "utf8"));

await startMessengerOrExit(new SignalAdapter(config.signal), {
  mode: config.mode,
  members: config.members,
  stateDir: config.stateDir,
  dryRun: config.dryRun,
  retryDelaysMs: config.retryDelaysMs,
  healthIntervalMs: config.healthIntervalMs,
  onEvent: (event) => console.log(`event ${event.id}`),
  log: (line) => console.log(line),
});
