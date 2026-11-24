// A stand-in for signal-cli's `jsonRpc` mode, used only by tests.
//
// It reads one JSON-RPC request per line on stdin and answers on stdout, the same way
// signal-cli 0.14.8 does. Its answers and notifications replay the real captures in
// test/fixtures/envelopes/ unless a scenario file says otherwise.
//
// Usage: bun fake-signal-cli.ts --scenario <scenario.json> [the real signal-cli launch args...]
//
// Everything it sees (its launch args, JAVA_HOME, and each request) is appended to the
// scenario's `log` file as JSON lines, so tests can check exactly what reached "signal-cli".

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ENVELOPES_DIR = join(import.meta.dir, "envelopes");

// One answer to a request. `fixture` names a captured response file in envelopes/.
export type FakeReply =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
  | { fixture: string }
  | { noReply: true } // never answer (the client's timeout should fire)
  | { die: true }; // exit mid-call without answering

export interface FakeScenario {
  log?: string;
  listGroups?: FakeReply;
  getUserStatus?: FakeReply;
  // Answers for successive `send` calls. The last one repeats once the list runs out.
  send?: FakeReply[];
  // The answer to every `sendReaction` call (default: success).
  sendReaction?: FakeReply;
  // Notifications emitted right after the subscribeReceive answer: a fixture file name
  // from envelopes/, or an inline notification object.
  afterSubscribe?: Array<string | object>;
  // Notifications emitted right after the listGroups answer, so they arrive once the
  // bridge's start-up check has passed ("live" messages).
  afterListGroups?: Array<string | object>;
  // Exit (code 3) this many milliseconds after subscribeReceive is answered.
  exitAfterSubscribeMs?: number;
}

function readFixture(name: string): any {
  return JSON.parse(readFileSync(join(ENVELOPES_DIR, name), "utf8"));
}

function loadScenario(argv: string[]): FakeScenario {
  const index = argv.indexOf("--scenario");
  if (index === -1) return {};
  return JSON.parse(readFileSync(argv[index + 1], "utf8"));
}

const argv = process.argv.slice(2);
const scenario = loadScenario(argv);

function record(entry: object) {
  if (scenario.log) appendFileSync(scenario.log, JSON.stringify(entry) + "\n");
}

function write(message: object) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// Send `reply` as the answer to request `id`.
function answer(id: unknown, reply: FakeReply) {
  if ("noReply" in reply) return;
  if ("die" in reply) process.exit(2);
  if ("fixture" in reply) {
    const captured = readFixture(reply.fixture);
    const { id: _capturedId, ...rest } = captured;
    write({ ...rest, id });
    return;
  }
  if ("error" in reply) {
    write({ jsonrpc: "2.0", error: reply.error, id });
    return;
  }
  write({ jsonrpc: "2.0", result: reply.result, id });
}

record({ argv, javaHome: process.env.JAVA_HOME ?? null });

function emit(notifications: Array<string | object> | undefined) {
  for (const item of notifications ?? []) {
    write(typeof item === "string" ? readFixture(item) : item);
  }
}

let sendCount = 0;

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const request = JSON.parse(line);
  record({ request });

  switch (request.method) {
    case "subscribeReceive": {
      answer(request.id, { result: 0 });
      emit(scenario.afterSubscribe);
      if (scenario.exitAfterSubscribeMs !== undefined) {
        setTimeout(() => process.exit(3), scenario.exitAfterSubscribeMs);
      }
      break;
    }
    case "listGroups":
      answer(request.id, scenario.listGroups ?? { fixture: "rpc-listGroups-response.json" });
      emit(scenario.afterListGroups);
      break;
    case "getUserStatus":
      answer(request.id, scenario.getUserStatus ?? { fixture: "rpc-getUserStatus-self-response.json" });
      break;
    case "send": {
      const replies = scenario.send ?? [{ fixture: "rpc-send-group-success-response.json" }];
      const reply = replies[Math.min(sendCount, replies.length - 1)];
      sendCount += 1;
      answer(request.id, reply);
      break;
    }
    case "sendReaction":
      answer(request.id, scenario.sendReaction ?? { result: { timestamp: Date.now() } });
      break;
    default:
      answer(request.id, { error: { code: -32601, message: "Method not implemented" } });
  }
});

// signal-cli exits when its stdin closes; so does the fake.
lines.on("close", () => process.exit(0));
