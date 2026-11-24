// The bridge: the one long-running process the service manager keeps alive. Run it with
//
//   bun src/bridge.ts
//
// It wires the pieces together and does little itself:
//
//   messenger   the chat app's adapter (Signal today) plus the shared inbox journal, sends, the
//               lock file, and the health call. A failed start-up check or the adapter's
//               connection dying ends this process non-zero, so the service manager restarts it.
//   worker      the single writer for weeks, the profile, and the log
//   brain       the isolated model call, behind the failure policy
//   scheduler   the Friday draft and its retries, and the Monday rollover, ticked once a minute
//   heartbeat   touched after every healthy health call; `bun run check-health` watches it
//
// Settings come from config.toml (src/config.ts), found through HMP_CONFIG (default ./config.toml);
// HMP_DRY_RUN, HMP_STATE_DIR and HMP_DATA_DIR override it for tests and dry runs.

import { join } from "node:path";
import { createBrain } from "./brain/index.ts";
import { createClaudeCaller } from "./brain/claude.ts";
import { loadConfig } from "./config.ts";
import { readProfileStatus } from "./data/profile.ts";
import { createAlertNotifier } from "./ops/alerts.ts";
import { awaitingProfile } from "./onboarding/awaiting.ts";
import { loadOnboardingState, onboardingStatePath } from "./onboarding/state.ts";
import { ReplyTracker, touchHeartbeat } from "./ops/heartbeat.ts";
import { FailurePolicy, Scheduler } from "./ops/scheduler.ts";
import { RecipeRefresher } from "./recipes/refresh.ts";
import { SiteContext, siteStatePathFor } from "./recipes/site/context.ts";
import { registerConfiguredProviders } from "./recipes/providers/register.ts";
import { createAdapter } from "./messaging/index.ts";
import { startMessengerOrExit, type Messenger } from "./messaging/messenger.ts";
import { DEFAULT_TIMERS, Worker, type WorkerPaths } from "./week/worker.ts";

const TICK_MS = 60_000;

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

const app = loadConfig();
const dataDir = app.paths.dataDir;
const stateDir = app.paths.stateDir;
// The chat app. This is the only place that picks one; everything below sees the shared contract.
const adapter = createAdapter(app);

const paths: WorkerPaths = {
  weeksDir: join(dataDir, "weeks"),
  logPath: join(dataDir, "log.md"),
  profileFiles: { profilePath: join(dataDir, "profile.md"), lastChangePath: join(stateDir, "profile-last-change.json") },
  sourcesPath: join(dataDir, "recipe-sources.json"),
  catalogPath: join(dataDir, "recipe-catalog.json"),
  refreshStatusPath: join(dataDir, "recipe-refresh.json"),
  stateDir: stateDir,
};

// A profile that exists but cannot be read stops the bridge at start, with the reason (and the
// file is left alone). No profile at all is fine: the bot interviews the household in the chat
// and writes one once an adult approves it. Until then it uses the default batching window.
const profileStatus = readProfileStatus(paths.profileFiles.profilePath);
if (profileStatus.kind === "error") {
  console.error(profileStatus.message);
  process.exit(1);
}
const profile = profileStatus.kind === "ready" ? profileStatus.profile : null;
const DEFAULT_BATCHING_SECONDS = 15;

// A damaged interview file stops the bridge too: guessing could lose the household's answers.
const interviewFile = loadOnboardingState(onboardingStatePath(stateDir, app.dryRun));
if (interviewFile.kind === "corrupt") {
  console.error(interviewFile.message);
  process.exit(1);
}

// The messenger starts after the worker exists, because it hands over journaled messages the
// moment it goes live. Until it is up, anything that needs to send waits for it here.
let resolveMessenger: (messenger: Messenger) => void = () => {};
const messengerReady = new Promise<Messenger>((resolve) => (resolveMessenger = resolve));

const replies = new ReplyTracker(stateDir, Date.now);
const claudeOptions = {
  model: app.model.id,
  apiKeyEnv: app.model.apiKeyEnv,
  maxTokens: app.model.maxOutputTokens,
  timeoutMs: app.model.timeoutMs,
};
const checkAuth = createClaudeCaller(claudeOptions);
// Alerts to the admin (config.toml [alerts]). Every alert is also written to the log.
const notifier = createAlertNotifier(app.alerts, { env: process.env, echo: log, dryRun: app.dryRun });

const policy = new FailurePolicy({
  stateDir: stateDir,
  brain: createBrain({
    ...claudeOptions,
    settings: {
      timeZone: app.schedule.timeZone,
      weeknights: app.planning.weeknights,
      minDiscoveryNights: app.planning.minDiscoveryNights,
      botName: app.household.botName,
      memberNames: app.members.map((member) => member.name),
    },
    log,
  }),
  sendToConversation: async (text) => (await messengerReady).sendToConversation(text),
  flush: () => worker.flush(),
  // The auth stop's re-check: the smallest call that proves the API key works (a tiny answer limit).
  checkAuth: async () => {
    await checkAuth({ system: "Answer with the single word OK.", prompt: "OK?", maxTokens: 16 });
  },
  alert: async (text) => (await notifier.send(text)) !== "failed",
  alertsConfigured: notifier.configured,
  replies,
  now: Date.now,
  timers: DEFAULT_TIMERS,
  log,
});

// One web client and one daily budget for page fetching, shared by the chat commands and the background refresh.
const site = new SiteContext({ statePath: siteStatePathFor(paths.catalogPath), recipes: app.recipes, log });

const worker: Worker = new Worker({
  paths,
  brain: policy,
  send: async (text, key) => (await messengerReady).sendToConversation(text, key),
  site,
  isAdmin: (memberId) => app.members.some((member) => member.id === memberId && member.role === "admin"),
  markHandled: (id) => {
    // Handled means the reply went out or a deliberate silence was logged: either way, answered.
    replies.answered(id);
    void messengerReady.then((messenger) => messenger.markHandled(id));
  },
  now: Date.now,
  quietWindowMs: (profile?.thresholds.batchingWindowSeconds ?? DEFAULT_BATCHING_SECONDS) * 1000,
  schedule: app.schedule,
  interview: {
    botName: app.household.botName,
    members: app.members.map((member) => ({ id: member.id, name: member.name })),
    weeknights: app.planning.weeknights,
    minDiscoveryNights: app.planning.minDiscoveryNights,
    dryRun: app.dryRun,
  },
  // The first profile was just saved: the scheduler catches up on the draft (or says when it comes).
  onProfileSaved: (commitId, mode) => {
    if (mode === "first-run") void scheduler.profileSaved(commitId);
  },
  timers: DEFAULT_TIMERS,
  log,
  onFailure: (error, what) => {
    if (what === "friday-draft") scheduler.noteDraftError(error);
    else policy.onMessageFailure(error);
  },
});

const scheduler: Scheduler = new Scheduler({
  stateDir: stateDir,
  worker,
  schedule: app.schedule,
  now: Date.now,
  log,
  // No profile yet while the first interview runs: the draft waits, with one reminder a week.
  awaitingProfile: () => awaitingProfile({ stateDir, profilePath: paths.profileFiles.profilePath, dryRun: app.dryRun }),
  say: async (text, key) => (await messengerReady).sendToConversation(text, key),
});

// Finish anything the journal shows as unfinished before new messages are handled, then, with no
// profile, begin the interview (the welcome goes out once; a restart does not repeat it).
void worker.recover();
void worker.startOnboarding();

const messenger = await startMessengerOrExit(adapter, {
  mode: app.messaging.mode,
  members: app.members,
  stateDir,
  dryRun: app.dryRun,
  onEvent: (event) => {
    replies.arrived(event.id);
    worker.enqueueMessage(event);
  },
  onHealth: (result) => {
    if (!result.healthy) return;
    touchHeartbeat(stateDir, result.at);
    log("heartbeat touched");
  },
  log,
});
resolveMessenger(messenger);
log(`bridge running${app.dryRun ? " (DRY RUN: nothing is sent)" : ""}; data folder ${dataDir}`);

// Mealie and Tandoor become sources the first time config.toml names them.
registerConfiguredProviders(paths.sourcesPath, app.recipes, new Date().toISOString());

// The recipe APIs are asked in the background, never inside a planning call. The first tick
// refreshes anything older than recipes.refreshHours; later ticks only act when a source is due.
const refresher = new RecipeRefresher({
  sourcesPath: paths.sourcesPath,
  catalogPath: paths.catalogPath,
  statusPath: paths.refreshStatusPath!,
  recipes: app.recipes,
  site,
  env: process.env,
  now: Date.now,
  log,
});

async function everyMinute(): Promise<void> {
  void refresher.tick(); // not awaited: a slow recipe server must never delay the schedule
  await scheduler.tick();
}

void everyMinute();
setInterval(() => void everyMinute(), TICK_MS);

// The service manager (Docker, systemd, launchd) stops the job with SIGTERM. Stop the adapter and release the lock file on the way out,
// so the next start never mistakes a reused process ID for a running bridge.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal}: stopping`);
    void messenger.stop().finally(() => process.exit(0));
  });
}
