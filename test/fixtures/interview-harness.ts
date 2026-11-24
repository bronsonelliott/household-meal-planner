// A household with no profile, wired the way src/bridge.ts wires it, with only the chat app and
// the model faked: the real worker (with the interview on), the real messenger, the real failure
// policy and scheduler, a FakeAdapter (or the fake Telegram API, see telegram-e2e-interview), a
// fake clock, and a model whose readings of the adults' answers are scripted by the test.
//
// A test says what the "model" will read out of each message (`reads`), types as Alex and Sam
// (`say`), and looks at what the bot posted (`texts`), the files, and the journal.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../src/brain/claude.ts";
import { FAKE_CONVERSATION_ID, FakeAdapter } from "../../src/messaging/fake.ts";
import { startMessenger, type Messenger } from "../../src/messaging/messenger.ts";
import type { IncomingMessage, MessagingAdapter, SendOutcome } from "../../src/messaging/types.ts";
import { awaitingProfile } from "../../src/onboarding/awaiting.ts";
import {
  loadOnboardingState,
  onboardingStatePath,
  type ExtractionResult,
  type OnboardingExtractOutcome,
  type OnboardingExtractRequest,
  type OnboardingState,
} from "../../src/onboarding/state.ts";
import { ReplyTracker } from "../../src/ops/heartbeat.ts";
import { FailurePolicy, Scheduler } from "../../src/ops/scheduler.ts";
import { Worker } from "../../src/week/worker.ts";
import { CHICAGO_SCHEDULE, MON_TO_THU } from "./config-fixtures.ts";
import { TEST_MEMBERS } from "./fake-telegram-api.ts";
import { FakeClock, StubBrain, THURSDAY_10AM, isTestAdmin } from "./worker-harness.ts";

export const ALEX_IDENTITY = "1001";
export const SAM_IDENTITY = "1002";
export const STRANGER_IDENTITY = "9999";

type Who = "Alex" | "Sam";

// How the "model" reads one batch of answers.
export type Reader = (request: OnboardingExtractRequest) => OnboardingExtractOutcome | Promise<OnboardingExtractOutcome>;

export interface InterviewHarnessOptions {
  start?: number;
  mode?: "group" | "household-dms";
  dryRun?: boolean;
  // The profile file's text; null (the default) means none: a first-run household.
  profile?: string | null;
  makeAdapter?: () => MessagingAdapter;
  // Use the folders of an earlier household (a later run on the same files).
  dir?: string;
}

export class InterviewHarness {
  readonly dir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly profilePath: string;
  readonly clock: FakeClock;
  readonly brain = new StubBrain();
  readonly logs: string[] = [];
  readonly readers: Reader[] = [];
  // The "model" is down: every reading fails with this class until it is set back to null.
  modelDown: "other" | "auth" | null = null;
  readonly extractRequests: OnboardingExtractRequest[] = [];
  readonly alerts: string[] = [];
  readonly adapters: MessagingAdapter[] = [];
  readonly dryRun: boolean;
  readonly mode: "group" | "household-dms";

  worker!: Worker;
  scheduler!: Scheduler;
  policy!: FailurePolicy;
  messenger!: Messenger;
  adapter!: MessagingAdapter;
  // Set it, and the next message the bot posts goes out but the worker never hears how it went.
  dieAfterNextSend = false;
  private nextNative = 1;
  private savedCount = 0;

  constructor(private options: InterviewHarnessOptions = {}) {
    this.dir = options.dir ?? mkdtempSync(join(tmpdir(), "interview-test-"));
    this.dataDir = join(this.dir, "data");
    this.stateDir = join(this.dir, "state");
    this.profilePath = join(this.dataDir, "profile.md");
    this.clock = new FakeClock(options.start ?? THURSDAY_10AM);
    this.dryRun = options.dryRun ?? false;
    this.mode = options.mode ?? "group";
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.stateDir, { recursive: true });
    if (typeof options.profile === "string") writeFileSync(this.profilePath, options.profile);
  }

  get paths() {
    return {
      weeksDir: join(this.dataDir, "weeks"),
      logPath: join(this.dataDir, "log.md"),
      profileFiles: { profilePath: this.profilePath, lastChangePath: join(this.stateDir, "profile-last-change.json") },
      sourcesPath: join(this.dataDir, "recipe-sources.json"),
      catalogPath: join(this.dataDir, "recipe-catalog.json"),
      stateDir: this.stateDir,
    };
  }

  // The first start, or a restart: everything but the folders and the clock is new.
  // `settle: false` returns without waiting for the worker (for a start-up that is meant to get stuck).
  async boot(options: { settle?: boolean } = {}): Promise<void> {
    const adapter = this.options.makeAdapter?.() ?? new FakeAdapter({ conversationId: this.mode === "group" ? FAKE_CONVERSATION_ID : null });
    this.adapter = adapter;
    this.adapters.push(adapter);

    const replies = new ReplyTracker(this.stateDir, this.clock.now);
    const timers = { set: this.clock.set, clear: this.clock.clear };
    let messenger: Messenger | null = null;
    const log = (line: string) => {
      this.logs.push(line);
      if (process.env.OPS_DEBUG) console.log(`[${new Date(this.clock.now()).toISOString()}] ${line}`);
    };

    // The brain: the interview's reading is scripted, everything else is the stub.
    const brain = this.brain;
    brain.extractOnboarding = async (request) => {
      this.extractRequests.push(request);
      if (this.modelDown) throw new BrainError(this.modelDown, `test: the model is down (${this.modelDown})`);
      const reader = this.readers.shift();
      if (!reader) throw new Error("the test queued no reading for this batch");
      return reader(request);
    };

    this.policy = new FailurePolicy({
      stateDir: this.stateDir,
      brain,
      sendToConversation: (text) => messenger!.sendToConversation(text),
      flush: () => this.worker.flush(),
      checkAuth: async () => {
        if (this.modelDown === "auth") throw new BrainError("auth", "test: still logged out");
      },
      alert: async (text) => {
        this.alerts.push(text);
        return true;
      },
      replies,
      now: this.clock.now,
      timers,
      log,
    });

    this.worker = new Worker({
      paths: this.paths,
      brain: this.policy,
      isAdmin: isTestAdmin,
      send: async (text, key) => {
        const outcome = await messenger!.sendToConversation(text, key);
        // The "process dies" right after the message went out and before the worker wrote it down.
        if (this.dieAfterNextSend) {
          this.dieAfterNextSend = false;
          return new Promise<SendOutcome>(() => {});
        }
        return outcome;
      },
      markHandled: (id) => {
        replies.answered(id);
        messenger?.markHandled(id);
      },
      now: this.clock.now,
      quietWindowMs: 15_000,
      schedule: CHICAGO_SCHEDULE,
      timers,
      log,
      interview: {
        botName: "Dinner Bot",
        members: TEST_MEMBERS.map((member) => ({ id: member.id, name: member.name })),
        weeknights: MON_TO_THU,
        minDiscoveryNights: 1,
        dryRun: this.dryRun,
      },
      onProfileSaved: (commitId, mode) => {
        this.savedCount += 1;
        if (mode === "first-run") void this.scheduler.profileSaved(commitId);
      },
      onFailure: (error, what) => {
        if (what === "friday-draft") this.scheduler.noteDraftError(error);
        else this.policy.onMessageFailure(error);
      },
    });

    this.scheduler = new Scheduler({
      stateDir: this.stateDir,
      worker: this.worker,
      schedule: CHICAGO_SCHEDULE,
      now: this.clock.now,
      log,
      awaitingProfile: () => awaitingProfile({ stateDir: this.stateDir, profilePath: this.profilePath, dryRun: this.dryRun }),
      say: async (text, key) => messenger!.sendToConversation(text, key),
    });

    void this.worker.recover();
    void this.worker.startOnboarding();
    messenger = await startMessenger(adapter, {
      mode: this.mode,
      members: TEST_MEMBERS,
      stateDir: this.stateDir,
      dryRun: this.dryRun,
      onEvent: (event) => {
        replies.arrived(event.id);
        this.worker.enqueueMessage(event);
      },
      log,
      sleep: async () => {},
      now: this.clock.now,
      healthIntervalMs: 60 * 60 * 1000,
    });
    this.messenger = messenger;
    if (options.settle !== false) await this.settle();
  }

  // The bridge stops and starts again (the clock and every file stay).
  async restart(): Promise<void> {
    await this.worker.idle();
    await this.messenger.stop();
    this.readers.length = 0;
    await this.boot();
  }

  // The process dies where it stands (a job may be stuck mid-way), and the bridge starts again.
  async crash(): Promise<void> {
    await this.messenger.stop();
    this.dieAfterNextSend = false;
    this.readers.length = 0;
    await this.boot();
  }

  async stop(): Promise<void> {
    await this.messenger?.stop().catch(() => {});
  }

  // Waits until the worker and the policy have nothing running.
  async settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await this.worker.idle();
      await this.policy.idle();
    }
  }

  // ----- Typing -----

  // A message from an adult (or `identity`, for a stranger). Returns the journal ID the interview knows it by.
  async type(who: Who | "Stranger", text: string, options: { replyTo?: string; group?: boolean } = {}): Promise<string> {
    const identity = who === "Alex" ? ALEX_IDENTITY : who === "Sam" ? SAM_IDENTITY : STRANGER_IDENTITY;
    const nativeId = `m${this.nextNative++}`;
    const isGroup = options.group ?? this.mode === "group";
    const message: Partial<IncomingMessage> & { sender: IncomingMessage["sender"] } = {
      sender: { identity, displayName: who },
      nativeId,
      text,
      isGroup,
      timestamp: this.clock.now(),
      ...(options.replyTo !== undefined ? { replyToNativeId: options.replyTo, repliesToBot: true } : {}),
    };
    const sent = await (this.adapter as FakeAdapter).inject(message);
    return `${sent.platform}/${sent.conversationId}/${nativeId}`;
  }

  // Types a message and lets the quiet window pass, so the bot has answered when this returns.
  async say(who: Who | "Stranger", text: string, options: { replyTo?: string } = {}): Promise<string> {
    const id = await this.type(who, text, options);
    await this.pass();
    return id;
  }

  // Waits (in real time, briefly) for something the scheduler does in the background after a save.
  async eventually(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("eventually: condition not met in time");
      await Bun.sleep(5);
      await this.settle();
    }
  }

  // Lets the 15-second quiet window pass and everything finish.
  async pass(ms = 15_000): Promise<void> {
    this.clock.advance(ms);
    await this.settle();
  }

  // ----- Scripting the model -----

  // Queue how the "model" reads the next batch.
  reads(reader: Reader | ExtractionResult): void {
    this.readers.push(typeof reader === "function" ? reader : () => ({ ok: true, result: reader }));
  }

  // ----- Looking -----

  // Everything the bot posted, in order, across restarts.
  get sends(): Array<{ scope: "conversation" | "member"; memberId: string | null; text: string; nativeId?: string }> {
    return this.adapters.flatMap((adapter) => (adapter as FakeAdapter).sends);
  }

  // In a dry run nothing reaches the chat app: the would-be sends are written to a file instead.
  get texts(): string[] {
    if (!this.dryRun) return this.sends.map((send) => send.text);
    const file = join(this.stateDir, "dry-run-sends.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line).text as string);
  }

  get lastText(): string {
    return this.texts[this.texts.length - 1] ?? "";
  }

  // The native ID of the most recent post whose text contains `fragment`.
  idOfPost(fragment: string): string {
    const found = [...this.sends].reverse().find((send) => send.text.includes(fragment));
    if (!found?.nativeId) throw new Error(`no post containing "${fragment}" with a native ID`);
    return found.nativeId;
  }

  get state(): OnboardingState | null {
    const loaded = loadOnboardingState(onboardingStatePath(this.stateDir, this.dryRun));
    return loaded.kind === "ok" ? loaded.state : null;
  }

  get savedTimes(): number {
    return this.savedCount;
  }

  scriptSends(outcomes: SendOutcome[]): void {
    (this.adapter as FakeAdapter).scriptSends(outcomes);
  }
}
