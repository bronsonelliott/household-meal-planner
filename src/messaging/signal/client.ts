// signal-cli as a child process, spoken to over JSON-RPC on stdin/stdout.
//
// This file is only the wire: start the program, send a request, get one of four kinds of answer
// back, hear its notifications. What the messages mean is the adapter's business (adapter.ts).

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { DRY_RUN_DETAIL } from "../dry-run.ts";

export interface RpcError {
  code: number;
  message: string;
  data?: any;
}

// The four ways a call can end. Callers decide what each means; nothing here throws.
export type RpcAnswer =
  | { kind: "result"; result: any }
  | { kind: "error"; error: RpcError }
  | { kind: "timeout" }
  | { kind: "died" }
  // Dry run: this call would have sent something, so it was not made.
  | { kind: "dry-run" };

interface PendingCall {
  resolve: (answer: RpcAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

// The JSON-RPC methods that put something in front of a person.
const SENDING_METHODS = new Set(["send", "sendReaction"]);

export class SignalClient {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<string, PendingCall>();
  private exited = false;
  private stopping = false;
  private exitPromise: Promise<void>;

  // Set by the owner: every receive notification, and signal-cli exiting on its own.
  onReceive: (result: any) => void = () => {};
  onExit: (code: number | null) => void = () => {};

  constructor(
    command: string[],
    env: Record<string, string | undefined>,
    private timeoutMs: number,
    private log: (line: string) => void,
    private dryRun = false,
  ) {
    // stderr goes straight to the bridge's own stderr (the service's log).
    this.child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"], env });

    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => {
        this.handleExit(code);
        resolve();
      });
      this.child.on("error", (error) => {
        // For example, the signal-cli path does not exist. No "exit" event follows.
        this.log(`could not run signal-cli: ${error.message}`);
        this.handleExit(null);
        resolve();
      });
    });

    // Writing to a signal-cli that just died raises EPIPE here; the exit handler deals with
    // the consequences, so this only has to keep the error from crashing the bridge.
    this.child.stdin!.on("error", (error) => this.log(`signal-cli stdin: ${error.message}`));

    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => this.handleLine(line));
  }

  // Sends one request and waits for its answer, up to `timeoutMs`.
  call(method: string, params?: object, timeoutMs = this.timeoutMs): Promise<RpcAnswer> {
    if (this.dryRun && SENDING_METHODS.has(method)) return Promise.resolve({ kind: "dry-run" });
    if (this.exited) return Promise.resolve({ kind: "died" });

    const id = String(this.nextId++);
    const request = params ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", id, method };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log(`no answer to ${method} within ${timeoutMs} ms`);
        resolve({ kind: "timeout" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  // Stops signal-cli on purpose; onExit is not called.
  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.exited) {
      this.child.stdin!.end();
      this.child.kill("SIGTERM");
    }
    await this.exitPromise;
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`unreadable line from signal-cli: ${line.slice(0, 200)}`);
      return;
    }

    // An answer to one of our calls.
    if (message.id !== undefined && message.id !== null && ("result" in message || "error" in message)) {
      const call = this.pending.get(String(message.id));
      if (!call) {
        this.log(`late or unexpected answer for id ${message.id}`);
        return;
      }
      clearTimeout(call.timer);
      this.pending.delete(String(message.id));
      call.resolve("error" in message ? { kind: "error", error: message.error } : { kind: "result", result: message.result });
      return;
    }

    // A notification. In manual receive mode the envelope is wrapped in params.result.
    if (message.method === "receive") {
      this.onReceive(message.params?.result ?? message.params ?? {});
      return;
    }
    this.log(`ignored notification ${message.method}`);
  }

  private handleExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.resolve({ kind: "died" });
    }
    this.pending.clear();
    if (this.stopping) return;
    // Wait one turn, so whatever the "died" answers set off (like writing a send's
    // failure class) finishes before the owner reacts, which may be exiting the process.
    setTimeout(() => this.onExit(code), 0);
  }
}

// signal-cli's arguments, after the program itself.
export function signalCliLaunchArgs(dataDir: string, botNumber: string): string[] {
  return [
    "--config",
    dataDir,
    "-a",
    botNumber,
    // A new phone changes an adult's safety number; the allowlist keys on account IDs, which
    // do not change, so trusting the new identity keeps sends working without a manual step.
    "--trust-new-identities",
    "always",
    "jsonRpc",
    // Nothing is fetched from Signal's server until the bridge subscribes.
    "--receive-mode",
    "manual",
    "--ignore-attachments",
    "--ignore-stories",
    "--ignore-avatars",
    "--ignore-stickers",
  ];
}


export function describeAnswer(answer: RpcAnswer): string {
  switch (answer.kind) {
    case "result":
      return "ok";
    case "error":
      return `error ${answer.error.code}: ${answer.error.message}`;
    case "timeout":
      return "no answer before the timeout";
    case "died":
      return "signal-cli exited";
    case "dry-run":
      return DRY_RUN_DETAIL;
  }
}
