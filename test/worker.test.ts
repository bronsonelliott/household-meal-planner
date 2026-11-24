// The serial worker: quiet-window batching, the provenance checks, target-week resolution,
// applying change sets, the Friday draft's send-outcome rule, rollover, and crash recovery.
// The brain is a stub that returns canned change sets; the clock is fake.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendWeek } from "../src/data/log.ts";
import type { Operation } from "../src/week/changeset.ts";
import { loadWeek, saveWeek, weekPath, type WeekFile } from "../src/week/state.ts";
import { BatchJournal, journalPath } from "../src/week/journal.ts";
import { postedMarkerPath, sendUnknownMarkerPath } from "../src/week/worker.ts";
import { draftedWeek, LEMON_PASTA, night, TACOS } from "./fixtures/week-fixtures.ts";
import {
  answer,
  FRIDAY_4PM,
  FRIDAY_6PM,
  GROUP_TARGET,
  message,
  MONDAY_9AM,
  setupHarness,
  THURSDAY_10AM,
  WEDNESDAY_NOON,
  type Harness,
} from "./fixtures/worker-harness.ts";

const COMING = "2026-10-05";

// Pushes messages through the quiet window and waits for the worker to finish.
async function deliver(h: Harness, worker: ReturnType<Harness["makeWorker"]>, ...events: ReturnType<typeof message>[]) {
  for (const event of events) worker.enqueueMessage(event);
  h.clock.advance(15_000);
  await worker.idle();
}

function comingWeek(h: Harness): WeekFile {
  return loadWeek(h.paths.weeksDir, COMING);
}

function logText(h: Harness): string {
  return existsSync(h.paths.logPath) ? readFileSync(h.paths.logPath, "utf8") : "";
}

// The records the checker reads from <stateDir>/send-failures.jsonl.
function sendFailures(h: Harness): any[] {
  const path = join(h.paths.stateDir, "send-failures.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const LEMON_CHOICE = {
  kind: "new" as const,
  name: "Lemon garlic pasta",
  protein: "vegetarian",
  tags: ["pasta", "quick"],
  ingredients: LEMON_PASTA.ingredients,
};

const BRISKET_FILL = [
  {
    weekOf: COMING,
    night: "sunday" as const,
    dish: "Smoked brisket",
    ingredients: [
      { section: "Meat & Fish" as const, text: "brisket, 12 lb" },
      { section: "Spices" as const, text: "brisket rub" },
    ],
  },
];

const DRAFTED_LINES = [
  "Monday: Chicken tacos (Mexican night)",
  "Tuesday: Spaghetti and meatballs (pasta night)",
  "Wednesday: Shrimp fried rice (quick weeknight)",
  "Thursday: Sausage and peppers (quick weeknight)",
  "Friday: Out (Friday is eating out)",
  "Saturday: Burgers",
  "Sunday: Smoked brisket (big cook)",
];

// The list for the drafted week with ground beef and tortillas on the have-list.
const LOCK_LIST = [
  "Grocery list for Oct 5 to Oct 11 (dinners only):",
  "",
  "Vegetables",
  "- white onion (x2)",
  "- cilantro",
  "- bell peppers, 3",
  "",
  "Frozen Foods",
  "- peas and carrots",
  "",
  "Meat & Fish",
  "- chicken thighs, 2 lb",
  "- shrimp, 1 lb",
  "- smoked sausage, 1 lb",
  "- brisket, 12 lb",
  "",
  "Spices",
  "- brisket rub",
  "",
  "Condiments",
  "- salsa verde",
  "",
  "Sauces & Oils",
  "- marinara, 1 jar",
  "",
  "Breads",
  "- burger buns",
  "",
  "Dairy",
  "- parmesan",
  "- eggs, 3",
  "",
  "Pasta & Rice",
  "- spaghetti, 1 lb",
  "- jasmine rice",
  "",
  "Check before you buy",
  "- Olive oil",
  "- Salt",
  "- Garlic",
  "- Butter",
].join("\n");

const LOCKED_LOG_ENTRY = [
  "## Week of 2026-10-05",
  "- Dates: 2026-10-05 to 2026-10-11",
  "- Status: locked",
  "- Monday: Chicken tacos (chicken)",
  "- Tuesday: Spaghetti and meatballs (beef)",
  "- Wednesday: Shrimp fried rice (fish)",
  "- Thursday: Sausage and peppers (pork)",
  "- Friday: Out (none)",
  "- Saturday: Burgers (beef)",
  "- Sunday: Smoked brisket (beef)",
].join("\n");

describe("revising a drafted week", () => {
  test("a swap changes Tuesday and restates the other six nights word for word", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const m = message("Sam", "we had spaghetti last week, different pasta", FRIDAY_6PM);
    h.brain.next(
      answer(
        [{ sourceMessageId: m.id, action: "swap", nights: [{ night: "tuesday", rule: "pasta night", dish: LEMON_CHOICE }] }],
        "Swapped Tuesday to a different pasta.",
      ),
    );

    await deliver(h, worker, m);

    expect(h.sent).toEqual([
      [
        "Swapped Tuesday to a different pasta.",
        "",
        "Dinners for Oct 5 to Oct 11:",
        "",
        "• Monday: Chicken tacos (Mexican night)",
        "• Tuesday: Lemon garlic pasta (pasta night)",
        "• Wednesday: Shrimp fried rice (quick weeknight)",
        "• Thursday: Sausage and peppers (quick weeknight)",
        "• Friday: Out (Friday is eating out)",
        "• Saturday: Burgers",
        "• Sunday: Smoked brisket (big cook)",
      ].join("\n"),
    ]);
    expect(h.handled).toEqual([m.id]);
    expect(comingWeek(h).nights.tuesday).toEqual(night(LEMON_PASTA, { changedBy: "Sam", swappedFromDraft: true }));

    const request = h.brain.handled[0]!;
    expect(request.kind).toBe("messages");
    if (request.kind === "messages") {
      expect(request.messages.map((event) => event.text)).toEqual(["we had spaghetti last week, different pasta"]);
      expect(request.context.comingWeek.status).toBe("drafted");
    }
  });

  test("two messages 10 seconds apart make one batch and one restated week with both changes", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const a = message("Sam", "Monday spaghetti instead", FRIDAY_6PM);
    const b = message("Alex", "and shrimp fried rice Saturday", FRIDAY_6PM + 10_000);
    h.brain.next(
      answer(
        [
          { sourceMessageId: a.id, action: "pin", nights: [{ night: "monday", rule: "pasta night", dish: { kind: "profile", name: "Spaghetti and meatballs" } }] },
          { sourceMessageId: b.id, action: "pin", nights: [{ night: "saturday", rule: null, dish: { kind: "profile", name: "Shrimp fried rice" } }] },
        ],
        "Done.",
      ),
    );

    worker.enqueueMessage(a);
    h.clock.advance(10_000);
    worker.enqueueMessage(b);
    h.clock.advance(14_999);
    await worker.idle();
    expect(h.brain.handled.length).toBe(0); // the window restarted with the second message
    h.clock.advance(1);
    await worker.idle();

    expect(h.brain.handled.length).toBe(1);
    expect(h.sent).toEqual([
      [
        "Done.",
        "",
        "Dinners for Oct 5 to Oct 11:",
        "",
        "• Monday: Spaghetti and meatballs (pasta night, Sam's pick)",
        "• Tuesday: Spaghetti and meatballs (pasta night)",
        "• Wednesday: Shrimp fried rice (quick weeknight)",
        "• Thursday: Sausage and peppers (quick weeknight)",
        "• Friday: Out (Friday is eating out)",
        "• Saturday: Shrimp fried rice (Alex's pick)",
        "• Sunday: Smoked brisket (big cook)",
      ].join("\n"),
    ]);
    expect(h.handled).toEqual([a.id, b.id]);
  });

  test("when two adults want different dishes for one night, the later message wins and the line names both", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const a = message("Sam", "Tuesday tacos", FRIDAY_6PM);
    const b = message("Alex", "no, Tuesday burgers", FRIDAY_6PM + 5_000);
    h.brain.next(
      answer([
        { sourceMessageId: b.id, action: "pin", nights: [{ night: "tuesday", rule: null, dish: { kind: "new", name: "Burgers", protein: "beef", tags: ["red-meat"], ingredients: [] } }] },
        { sourceMessageId: a.id, action: "pin", nights: [{ night: "tuesday", rule: "Mexican night", dish: { kind: "profile", name: "Chicken tacos" } }] },
      ]),
    );

    await deliver(h, worker, a, b);

    expect(h.sent[0]).toContain("\n• Tuesday: Burgers (Alex's pick, Sam asked for Chicken tacos)\n");
    expect(comingWeek(h).nights.tuesday?.dish).toBe("Burgers");
    expect(comingWeek(h).nights.tuesday?.pinnedBy).toBe("Alex");
  });

  test("'swap Saturday' on Friday evening changes next week's Saturday and posts no list delta for this week", async () => {
    const h = setupHarness(FRIDAY_6PM);
    const current: WeekFile = { ...draftedWeek(), weekOf: "2026-09-28", status: "current", lockedAt: "2026-09-25T22:00:00.000Z", postedList: [] };
    saveWeek(h.paths.weeksDir, current);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const currentBefore = readFileSync(weekPath(h.paths.weeksDir, "2026-09-28"), "utf8");
    const worker = h.makeWorker();
    const m = message("Alex", "swap Saturday for something with chicken", FRIDAY_6PM);
    h.brain.next(
      answer(
        [{ sourceMessageId: m.id, action: "swap", nights: [{ night: "saturday", rule: null, dish: { kind: "profile", name: "Chicken tacos" } }] }],
        "Saturday's now chicken tacos.",
      ),
    );

    await deliver(h, worker, m);

    expect(comingWeek(h).nights.saturday?.dish).toBe("Chicken tacos");
    expect(readFileSync(weekPath(h.paths.weeksDir, "2026-09-28"), "utf8")).toBe(currentBefore);
    expect(h.sent[0]).toContain("Dinners for Oct 5 to Oct 11:");
    expect(h.sent[0]).not.toContain("List changes");
    expect(h.sent[0]).not.toContain("Sep 28");
  });

  test("a deliberate silence posts nothing and marks the message handled", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const m = message("Sam", "can you grab the kids at 5?", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: m.id, action: "none" }]));

    await deliver(h, worker, m);

    expect(h.sent).toEqual([]);
    expect(h.handled).toEqual([m.id]);
    expect(h.logs).toContain(`model chose silence for ${m.id}: nothing to say`);
  });

  test("a failed brain call leaves the message unhandled, and flush retries it", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const m = message("Sam", "Tuesday tacos", FRIDAY_6PM);
    h.brain.next(() => {
      throw new Error("overloaded");
    });

    await deliver(h, worker, m);
    expect(h.handled).toEqual([]);
    expect(h.sent).toEqual([]);

    h.brain.next(answer([{ sourceMessageId: m.id, action: "pin", nights: [{ night: "tuesday", rule: null, dish: { kind: "profile", name: "Chicken tacos" } }] }]));
    await worker.flush();
    await worker.idle();
    expect(h.handled).toEqual([m.id]);
    expect(h.brain.handled.length).toBe(2);
    expect(comingWeek(h).nights.tuesday?.dish).toBe("Chicken tacos");
  });
});

describe("provenance checks on the model's operations", () => {
  test("'don't lock it yet' does not lock, and the reply offers to lock when ready", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const m = message("Sam", "don't lock it yet", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: m.id, action: "lock" }], "No problem."));

    await deliver(h, worker, m);

    expect(h.sent).toEqual([`No problem.\nI didn't lock the week: the message didn't say to lock it. Say "lock it" when you're ready.`]);
    expect(comingWeek(h).status).toBe("drafted");
    expect(logText(h)).toBe("");
  });

  test("a lock whose source message has no lock word is dropped and the reply says so", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const m = message("Alex", "looks good", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: m.id, action: "lock" }]));

    await deliver(h, worker, m);

    expect(h.sent).toEqual([`I didn't lock the week: the message didn't say to lock it. Say "lock it" when you're ready.`]);
    expect(comingWeek(h).status).toBe("drafted");
  });

  test("an operation naming a message outside the batch is dropped", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const m = message("Alex", "lock it", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: "someone-else:1", action: "lock" }]));

    await deliver(h, worker, m);

    expect(h.sent[0]).toBe("I didn't lock the week: it pointed at a message that isn't part of this conversation. Say \"lock it\" when you're ready.");
    expect(comingWeek(h).status).toBe("drafted");
  });

  test("'swap Tuesday for tacos' changes only the week; a rule without rule words is dropped", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const profileBefore = readFileSync(h.paths.profileFiles.profilePath, "utf8");
    const worker = h.makeWorker();
    const m = message("Sam", "swap Tuesday for tacos", FRIDAY_6PM);
    h.brain.next(
      answer([
        { sourceMessageId: m.id, action: "rule", prose: "Tacos on Tuesdays", check: { kind: "advisory" } },
        { sourceMessageId: m.id, action: "pin", nights: [{ night: "tuesday", rule: "Mexican night", dish: { kind: "profile", name: "Chicken tacos" } }] },
      ]),
    );

    await deliver(h, worker, m);

    expect(readFileSync(h.paths.profileFiles.profilePath, "utf8")).toBe(profileBefore);
    expect(h.sent[0]).toStartWith(
      `I didn't add the rule "Tacos on Tuesdays": house rules only change on words like "add a rule," "never," "always," or "from now on".\n\nDinners for Oct 5 to Oct 11:`,
    );
    expect(comingWeek(h).nights.tuesday?.dish).toBe("Chicken tacos");
  });

  test("'add a rule: no fish on weeknights' adds the rule and confirms it with the undo offer", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const m = message("Sam", "add a rule: no fish on weeknights", FRIDAY_6PM);
    h.brain.next(
      answer([{ sourceMessageId: m.id, action: "rule", prose: "No fish on weeknights", check: { kind: "forbid", tag: "fish", nights: "weeknights" } }]),
    );

    await deliver(h, worker, m);

    expect(readFileSync(h.paths.profileFiles.profilePath, "utf8")).toContain("- No fish on weeknights [forbid fish weeknights]\n");
    expect(h.sent).toEqual([
      `Sam added the rule "No fish on weeknights" (checked as: forbid fish weeknights). Say "undo" within 30 minutes to take it back.`,
    ]);
  });
});

describe("locking and the list", () => {
  test("a have-list, then 'lock it': the list leaves them off, has the check block, and the week is logged", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();

    const have = message("Sam", "we have ground beef and tortillas", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: have.id, action: "have", items: ["ground beef", "tortillas"] }], "Noted."));
    await deliver(h, worker, have);
    expect(h.sent).toEqual(["Noted."]);

    const lock = message("Alex", "lock it", FRIDAY_6PM + 60_000);
    h.brain.next(answer([{ sourceMessageId: lock.id, action: "lock" }], "Locking it."));
    h.brain.nextFill(BRISKET_FILL);
    await deliver(h, worker, lock);

    expect(h.brain.fillRequests).toEqual([[{ weekOf: COMING, night: "sunday", dish: "Smoked brisket", pool: "usual", publisherLines: null }]]);
    expect(h.sent[1]).toBe(`Locking it.\nLocked the week of Oct 5.\n\n${LOCK_LIST}`);
    expect(logText(h)).toContain(LOCKED_LOG_ENTRY + "\n");

    const week = comingWeek(h);
    expect(week.status).toBe("locked");
    expect(week.lockedAt).toBe(new Date(FRIDAY_6PM + 30_000).toISOString()); // the clock, not the message timestamp
    expect(week.nights.sunday?.ingredients).toEqual(BRISKET_FILL[0]!.ingredients);
    expect(week.postedList).not.toBeNull();
  });

  test("'Tuesday tacos, we have tortillas, lock it' applies the swap, the have-list, then the lock", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const m = message("Alex", "Tuesday tacos, we have tortillas, lock it", FRIDAY_6PM);
    // The model listed the lock first; the harness still locks last within the message.
    h.brain.next(
      answer([
        { sourceMessageId: m.id, action: "lock" },
        { sourceMessageId: m.id, action: "pin", nights: [{ night: "tuesday", rule: "Mexican night", dish: { kind: "profile", name: "Chicken tacos" } }] },
        { sourceMessageId: m.id, action: "have", items: ["tortillas"] },
      ]),
    );
    h.brain.nextFill(BRISKET_FILL);

    await deliver(h, worker, m);

    const reply = h.sent[0]!;
    expect(reply).toContain("\n• Tuesday: Chicken tacos (Mexican night, Alex's pick)\n");
    expect(reply).toContain("\n- chicken thighs, 2 lb + 2 lb\n");
    expect(reply).not.toContain("tortillas");
    expect(reply.indexOf("Dinners for Oct 5 to Oct 11:")).toBeLessThan(reply.indexOf("Grocery list for"));
    expect(logText(h)).toContain("- Tuesday: Chicken tacos (chicken) (swapped from draft)\n");
    expect(comingWeek(h).status).toBe("locked");
  });

  test("'lock it' with no draft says there's nothing to lock and changes nothing", async () => {
    const h = setupHarness(THURSDAY_10AM);
    const worker = h.makeWorker();
    const m = message("Alex", "lock it", THURSDAY_10AM);
    h.brain.next(answer([{ sourceMessageId: m.id, action: "lock" }]));

    await deliver(h, worker, m);

    expect(h.sent).toEqual(["There's nothing to lock yet: the week of Oct 5 hasn't been drafted. Want me to draft it now?"]);
    expect(existsSync(weekPath(h.paths.weeksDir, COMING))).toBe(false);
    expect(logText(h)).toBe("");
  });

  test("a second lock with no changes re-posts the list and logs nothing new", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const first = message("Alex", "lock it", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: first.id, action: "lock" }]));
    h.brain.nextFill(BRISKET_FILL);
    await deliver(h, worker, first);
    const firstList = h.sent[0]!.slice(h.sent[0]!.indexOf("Grocery list for"));

    const second = message("Sam", "lock it", FRIDAY_6PM + 60_000);
    h.brain.next(answer([{ sourceMessageId: second.id, action: "lock" }]));
    await deliver(h, worker, second);

    expect(h.sent[1]).toBe(`The week of Oct 5 was already locked.\n\n${firstList}`);
    expect(count(logText(h), "## Week of 2026-10-05")).toBe(1);
    expect(h.brain.fillRequests.length).toBe(1);
  });

  test("a change after lock plus a lock word posts only the delta and updates the log entry", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const first = message("Alex", "lock it", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: first.id, action: "lock" }]));
    h.brain.nextFill(BRISKET_FILL);
    await deliver(h, worker, first);

    const change = message("Sam", "actually lemon pasta Tuesday, lock it", FRIDAY_6PM + 60_000);
    h.brain.next(
      answer([
        { sourceMessageId: change.id, action: "pin", nights: [{ night: "tuesday", rule: "pasta night", dish: LEMON_CHOICE }] },
        { sourceMessageId: change.id, action: "lock" },
      ]),
    );
    await deliver(h, worker, change);

    const reply = h.sent[1]!;
    expect(reply).toContain("\n• Tuesday: Lemon garlic pasta (pasta night, Sam's pick)\n");
    expect(reply).not.toContain("Grocery list for");
    expect(reply.endsWith(
      [
        "List changes for Oct 5 to Oct 11:",
        "Add (Fruits): lemons, 2",
        "Add (Pasta & Rice): linguine, 1 lb",
        "Drop (Sauces & Oils): marinara, 1 jar",
        "Drop (Dairy): parmesan",
        "Drop (Pasta & Rice): spaghetti, 1 lb",
        "Change (Meat & Fish): ground beef, 2 lb (was ground beef, 1 lb + 2 lb)",
      ].join("\n"),
    )).toBe(true);
    const log = logText(h);
    expect(count(log, "## Week of 2026-10-05")).toBe(1);
    expect(log).toContain("- Changed after lock: Tuesday: Lemon garlic pasta (vegetarian)");
    expect(comingWeek(h).nights.tuesday?.changedAfterLock).toBe(true);
  });

  test("a past night reported during the week is logged under that week, with no list", async () => {
    const h = setupHarness(WEDNESDAY_NOON);
    saveWeek(h.paths.weeksDir, { ...draftedWeek(), status: "current", postedList: [] });
    appendWeek(h.paths.logPath, { weekOf: COMING, status: "locked", nights: [] });
    const worker = h.makeWorker();
    const m = message("Sam", "we did pizza instead on Monday", WEDNESDAY_NOON);
    h.brain.next(answer([{ sourceMessageId: m.id, action: "report", text: "we did pizza instead on Monday" }]));

    await deliver(h, worker, m);

    expect(h.sent).toEqual(["Logged it under the week of Oct 5."]);
    expect(logText(h)).toContain("- Report: we did pizza instead on Monday");
  });
});

describe("seeding, which week, and the Friday draft", () => {
  test("Thursday 'Tuesday tacos, Sunday brisket' pins Tuesday and asks once about Sunday; the answer pins next week", async () => {
    const h = setupHarness(THURSDAY_10AM);
    const worker = h.makeWorker();
    const seed = message("Sam", "Tuesday tacos, Sunday brisket", THURSDAY_10AM);
    h.brain.next(
      answer([
        {
          sourceMessageId: seed.id,
          action: "pin",
          nights: [
            { night: "tuesday", rule: null, dish: { kind: "profile", name: "Chicken tacos" } },
            { night: "sunday", rule: null, dish: { kind: "profile", name: "Smoked brisket" } },
          ],
        },
      ]),
    );
    await deliver(h, worker, seed);

    expect(h.sent).toEqual([
      [
        "This week or next? Sunday could be Oct 4 or Oct 11. I left it alone for now.",
        "",
        "Dinners for Oct 5 to Oct 11:",
        "",
        "• Monday: (open)",
        "• Tuesday: Chicken tacos (Sam's pick)",
        "• Wednesday: (open)",
        "• Thursday: (open)",
        "• Friday: (open)",
        "• Saturday: (open)",
        "• Sunday: (open)",
      ].join("\n"),
    ]);
    expect(comingWeek(h).status).toBe("seeding");
    expect(existsSync(weekPath(h.paths.weeksDir, "2026-09-28"))).toBe(false);

    const reply = message("Sam", "next", THURSDAY_10AM + 60_000);
    h.brain.next(answer([{ sourceMessageId: reply.id, action: "pin", nights: [{ night: "sunday", rule: null, dish: { kind: "profile", name: "Smoked brisket" } }] }]));
    await deliver(h, worker, reply);

    expect(comingWeek(h).nights.sunday?.pinnedBy).toBe("Sam");
    expect(h.sent[1]).toContain("\n• Sunday: Smoked brisket (Sam's pick)");
  });

  test("pins set Thursday survive a restart and the Friday draft keeps them", async () => {
    const h = setupHarness(THURSDAY_10AM);
    const seed = message("Sam", "Tuesday tacos, and next Sunday brisket", THURSDAY_10AM);
    h.brain.next(
      answer([
        {
          sourceMessageId: seed.id,
          action: "pin",
          nights: [
            { night: "tuesday", rule: null, dish: { kind: "profile", name: "Chicken tacos" } },
            { night: "sunday", rule: null, dish: { kind: "profile", name: "Smoked brisket" } },
          ],
        },
      ]),
    );
    await deliver(h, h.makeWorker(), seed);

    // Restart: a fresh worker at Friday 4 PM.
    h.clock.nowMs = FRIDAY_4PM;
    const worker = h.makeWorker();
    h.brain.next((request) => {
      const id = request.triggerId;
      const ops: Operation[] = [
        {
          sourceMessageId: id,
          action: "swap",
          nights: [
            { night: "monday", rule: "pasta night", dish: { kind: "profile", name: "Spaghetti and meatballs" } },
            { night: "tuesday", rule: null, dish: { kind: "profile", name: "Smoked brisket" } }, // a pinned night: ignored
            { night: "wednesday", rule: "quick weeknight", dish: { kind: "profile", name: "Shrimp fried rice" } },
            { night: "thursday", rule: "quick weeknight", dish: { kind: "new", name: "Sausage and peppers", protein: "pork", tags: ["quick"], ingredients: [] } },
            { night: "friday", rule: "Friday is eating out", dish: { kind: "out" } },
            { night: "saturday", rule: null, dish: { kind: "new", name: "Burgers", protein: "beef", tags: ["red-meat"], ingredients: [] } },
            { night: "sunday", rule: null, dish: { kind: "profile", name: "Spaghetti and meatballs" } }, // pinned: ignored
          ],
        },
      ];
      return { changeSet: { operations: ops }, reply: { kind: "silent", reason: "draft" } };
    });

    const result = await worker.enqueueFridayDraft({ late: false });

    expect(result).toEqual({ kind: "posted", weekOf: COMING, outcome: "sent" });
    expect(h.sent[1]).toBe(
      [
        "Here's the draft for Oct 5 to Oct 11:",
        "",
        "• Monday: Spaghetti and meatballs (pasta night)",
        "• Tuesday: Chicken tacos (Sam's pick)",
        "• Wednesday: Shrimp fried rice (quick weeknight)",
        "• Thursday: Sausage and peppers (quick weeknight)",
        "• Friday: Out (Friday is eating out)",
        "• Saturday: Burgers",
        "• Sunday: Smoked brisket (Sam's pick)",
        "",
        "Anything to use up, or anything you want different this week?",
      ].join("\n"),
    );
    expect(comingWeek(h).status).toBe("drafted");
    expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(true);
    const request = h.brain.handled[1]!;
    expect(request.kind).toBe("friday-draft");
    if (request.kind === "friday-draft") expect(request.weekOf).toBe(COMING);
  });

  test("pins that put chicken on three nights are kept and the draft carries the one-line note", async () => {
    const h = setupHarness(FRIDAY_4PM);
    const seeded = draftedWeek();
    seeded.status = "seeding";
    for (const name of ["monday", "tuesday", "wednesday"] as const) seeded.nights[name] = night(TACOS, { pinnedBy: "Sam", changedBy: "Sam" });
    for (const name of ["thursday", "friday", "saturday", "sunday"] as const) seeded.nights[name] = null;
    saveWeek(h.paths.weeksDir, seeded);
    const worker = h.makeWorker();
    h.brain.next((request) => ({
      changeSet: {
        operations: [
          {
            sourceMessageId: request.triggerId,
            action: "swap",
            nights: [
              { night: "tuesday", rule: null, dish: { kind: "new", name: "Burgers", protein: "beef", tags: [], ingredients: [] } },
              { night: "thursday", rule: "quick weeknight", dish: { kind: "profile", name: "Shrimp fried rice" } },
              { night: "friday", rule: "Friday is eating out", dish: { kind: "out" } },
              { night: "saturday", rule: null, dish: { kind: "away" } },
              { night: "sunday", rule: "big cook", dish: { kind: "profile", name: "Smoked brisket" } },
            ],
          },
        ],
      },
      reply: { kind: "text", text: "Kept chicken three nights because you pinned them." },
    }));

    await worker.enqueueFridayDraft({ late: false });

    expect(h.sent[0]).toBe(
      [
        "Here's the draft for Oct 5 to Oct 11:",
        "",
        "• Monday: Chicken tacos (Mexican night, Sam's pick)",
        "• Tuesday: Chicken tacos (Mexican night, Sam's pick)",
        "• Wednesday: Chicken tacos (Mexican night, Sam's pick)",
        "• Thursday: Shrimp fried rice (quick weeknight)",
        "• Friday: Out (Friday is eating out)",
        "• Saturday: Away",
        "• Sunday: Smoked brisket (big cook)",
        "",
        "Anything to use up, or anything you want different this week?",
        "",
        "Kept chicken three nights because you pinned them.",
      ].join("\n"),
    );
    expect(comingWeek(h).nights.saturday?.protein).toBeNull();
  });

  test("'skip next week' marks the week skipped and the Friday tick posts nothing", async () => {
    const h = setupHarness(THURSDAY_10AM);
    const worker = h.makeWorker();
    const m = message("Alex", "skip next week, we're at the lake", THURSDAY_10AM);
    h.brain.next(answer([{ sourceMessageId: m.id, action: "skip" }]));
    await deliver(h, worker, m);

    expect(h.sent).toEqual(["Skipping the week of Oct 5. I won't post a draft for it."]);
    expect(comingWeek(h).status).toBe("skipped");

    h.clock.nowMs = FRIDAY_4PM;
    const result = await worker.enqueueFridayDraft({ late: false });
    expect(result).toEqual({ kind: "nothing-to-post", weekOf: COMING, status: "skipped" });
    expect(h.sent.length).toBe(1);
    expect(h.brain.handled.length).toBe(1);
    expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(true);
  });

  test("'we're home after all' puts a skipped week back to empty", async () => {
    const h = setupHarness(THURSDAY_10AM);
    saveWeek(h.paths.weeksDir, { ...draftedWeek(), status: "skipped", nights: { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null } });
    const worker = h.makeWorker();
    const m = message("Sam", "we're home after all", THURSDAY_10AM);
    h.brain.next(answer([{ sourceMessageId: m.id, action: "unskip" }]));
    await deliver(h, worker, m);

    expect(h.sent).toEqual(["The week of Oct 5 is back on, and a draft is coming."]);
    expect(comingWeek(h).status).toBe("empty");
  });

  // A skipped week already has its Friday posted marker, so without clearing it the scheduler
  // would never draft the week and it would lapse on Monday.
  describe("unskipping after the Friday marker was written", () => {
    const SATURDAY_10AM = Date.parse("2026-10-03T15:00:00Z"); // Sat Oct 3, 10:00 AM
    const SUNDAY_12_05PM = Date.parse("2026-10-04T17:05:00Z"); // Sun Oct 4, 12:05 PM: past the deadline
    const errorPath = (h: Harness) => join(h.paths.stateDir, `friday-error-${COMING}.json`);

    function skippedWithMarker(atMs: number) {
      const h = setupHarness(atMs);
      const empty = { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null };
      saveWeek(h.paths.weeksDir, { ...draftedWeek(), status: "skipped", nights: empty });
      writeFileSync(postedMarkerPath(h.paths.stateDir, COMING), JSON.stringify({ outcome: "nothing-to-post", status: "skipped" }) + "\n");
      writeFileSync(errorPath(h), "{}\n");
      return h;
    }

    test("before Sunday noon: the markers are cleared so the scheduler drafts it, and the reply says so", async () => {
      const h = skippedWithMarker(SATURDAY_10AM);
      const m = message("Sam", "we're home after all", SATURDAY_10AM);
      h.brain.next(answer([{ sourceMessageId: m.id, action: "unskip" }]));
      await deliver(h, h.makeWorker(), m);

      expect(comingWeek(h).status).toBe("empty");
      expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(false);
      expect(existsSync(errorPath(h))).toBe(false);
      expect(h.sent).toEqual(["The week of Oct 5 is back on, and a draft is coming."]);
    });

    test("past Sunday noon: the marker stays, and the reply says no draft is coming", async () => {
      const h = skippedWithMarker(SUNDAY_12_05PM);
      const m = message("Sam", "we're home after all", SUNDAY_12_05PM);
      h.brain.next(answer([{ sourceMessageId: m.id, action: "unskip" }]));
      await deliver(h, h.makeWorker(), m);

      expect(comingWeek(h).status).toBe("empty");
      expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(true);
      expect(h.sent.length).toBe(1);
      expect(h.sent[0]).toContain("back on");
      expect(h.sent[0]).toContain("won't post a draft");
      expect(h.sent[0]).toContain("Tell me the dinners you want");
    });

    test("replaying the batch after a crash (markers already gone) does not error and replies once", async () => {
      const h = skippedWithMarker(SATURDAY_10AM);
      const m = message("Sam", "we're home after all", SATURDAY_10AM);
      h.brain.next(answer([{ sourceMessageId: m.id, action: "unskip" }]));
      await deliver(h, h.makeWorker(), m);

      // Crash after the markers were deleted, before anything else was journaled.
      const journal = readFileSync(journalPath(h.paths.stateDir), "utf8").trim().split("\n");
      writeFileSync(journalPath(h.paths.stateDir), journal[0] + "\n");
      h.sent = [];
      h.handled = [];

      const worker = h.makeWorker();
      await worker.recover();
      await worker.idle();

      expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(false);
      expect(h.sent).toEqual(["The week of Oct 5 is back on, and a draft is coming."]);
      expect(h.handled).toEqual([m.id]);
      expect(h.brain.handled.length).toBe(1);
    });
  });
});

describe("the Friday draft's send outcome", () => {
  function queueDraft(h: Harness) {
    h.brain.next((request) => ({
      changeSet: {
        operations: [
          {
            sourceMessageId: request.triggerId,
            action: "swap",
            nights: (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const).map((name) => ({
              night: name,
              rule: null,
              dish: { kind: "profile" as const, name: "Chicken tacos" },
            })),
          },
        ],
      },
      reply: { kind: "silent", reason: "draft" },
    }));
  }

  // The draft may have reached the phones, so the stored week is the draft: replies then act on
  // the nights the adults may be reading, and nothing is ever posted a second time.
  test("Unknown: a send-unknown marker, the week is saved as drafted, and a retry posts nothing", async () => {
    const h = setupHarness(FRIDAY_4PM);
    const worker = h.makeWorker();
    queueDraft(h);
    h.outcomes.push({ kind: "unknown", detail: "no answer" });

    expect(await worker.enqueueFridayDraft({ late: false })).toEqual({ kind: "send-unknown", weekOf: COMING });
    expect(existsSync(sendUnknownMarkerPath(h.paths.stateDir, COMING))).toBe(true);
    expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(false);
    expect(comingWeek(h).status).toBe("drafted");
    expect(comingWeek(h).nights.tuesday?.dish).toBe("Chicken tacos");

    expect(await worker.enqueueFridayDraft({ late: false })).toEqual({ kind: "send-unknown", weekOf: COMING });
    expect(h.sent.length).toBe(1);
    expect(h.brain.handled.length).toBe(1);
  });

  test("Failed: no marker and the week stays pre-draft, so the next retry drafts and sends again", async () => {
    const h = setupHarness(FRIDAY_4PM);
    const worker = h.makeWorker();
    queueDraft(h);
    h.outcomes.push({ kind: "failed", detail: "rate limited" });

    expect(await worker.enqueueFridayDraft({ late: false })).toEqual({ kind: "send-failed", weekOf: COMING, detail: "rate limited" });
    expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(false);
    expect(existsSync(sendUnknownMarkerPath(h.paths.stateDir, COMING))).toBe(false);
    expect(comingWeek(h).status).toBe("empty");

    h.clock.advance(10 * 60_000);
    queueDraft(h);
    expect(await worker.enqueueFridayDraft({ late: true })).toEqual({ kind: "posted", weekOf: COMING, outcome: "sent" });
    expect(h.sent[1]).toStartWith("(late) Here's the draft for Oct 5 to Oct 11:");
  });

  test("Partial: counts as posted, the week is drafted, and it is never re-posted", async () => {
    const h = setupHarness(FRIDAY_4PM);
    const worker = h.makeWorker();
    queueDraft(h);
    h.outcomes.push({ kind: "partial", timestamp: 1, failedMembers: [{ member: "x", type: "UNREGISTERED_FAILURE" }] });

    expect(await worker.enqueueFridayDraft({ late: false })).toEqual({ kind: "posted", weekOf: COMING, outcome: "partial" });
    expect(comingWeek(h).status).toBe("drafted");
    expect(await worker.enqueueFridayDraft({ late: false })).toEqual({ kind: "already-posted", weekOf: COMING });
    expect(h.sent.length).toBe(1);
  });

  test("a draft that leaves a night open is not posted", async () => {
    const h = setupHarness(FRIDAY_4PM);
    const worker = h.makeWorker();
    h.brain.next((request) => ({
      changeSet: { operations: [{ sourceMessageId: request.triggerId, action: "swap", nights: [{ night: "monday", rule: null, dish: { kind: "out" } }] }] },
      reply: { kind: "silent", reason: "draft" },
    }));

    const result = await worker.enqueueFridayDraft({ late: false });
    expect(result.kind).toBe("draft-failed");
    expect(h.sent).toEqual([]);
    expect(comingWeek(h).status).toBe("empty");
  });
});

describe("Monday rollover", () => {
  test("a drafted week that was never locked lapses and is logged as not locked with its nights", async () => {
    const h = setupHarness(MONDAY_9AM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();

    await worker.enqueueRollover();

    expect(comingWeek(h).status).toBe("lapsed");
    expect(logText(h)).toContain(LOCKED_LOG_ENTRY.replace("- Status: locked", "- Status: not locked") + "\n");

    await worker.enqueueRollover();
    expect(count(logText(h), "## Week of 2026-10-05")).toBe(1);
  });

  test("a locked week becomes current, and a message during the week targets it only with a qualifier", async () => {
    const h = setupHarness(MONDAY_9AM);
    saveWeek(h.paths.weeksDir, { ...draftedWeek(), status: "locked", lockedAt: "2026-10-02T22:00:00.000Z", postedList: [] });
    const worker = h.makeWorker();
    await worker.enqueueRollover();
    expect(comingWeek(h).status).toBe("current");
  });
});

describe("crash recovery at each write point", () => {
  // A crash mid-write leaves a partial last line with no newline. The next record must start
  // on its own line, or it is glued to the fragment and lost after the next restart.
  test("a record appended after a partial last line is read back on the next start", () => {
    const h = setupHarness(FRIDAY_6PM);
    const path = journalPath(h.paths.stateDir);
    writeFileSync(path, JSON.stringify({ type: "done", id: "old" }) + "\n" + '{"type":"batch","id":"cut-of');

    new BatchJournal(path, () => {}).append({ type: "done", id: "after-crash" });
    const reopened = new BatchJournal(path, () => {});

    expect(reopened.get("after-crash")?.done).toBe(true);
    expect(reopened.get("old")?.done).toBe(true);
  });

  // Runs one batch (a rule plus a pin) to completion, then returns what a crash at each point
  // would have left behind, so a fresh worker can be started against it.
  async function completedBatch() {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const profileBefore = readFileSync(h.paths.profileFiles.profilePath, "utf8");
    const weekBefore = readFileSync(weekPath(h.paths.weeksDir, COMING), "utf8");
    const m = message("Sam", "add a rule: no fish on weeknights. And lemon pasta Tuesday", FRIDAY_6PM);
    h.brain.next(
      answer(
        [
          { sourceMessageId: m.id, action: "rule", prose: "No fish on weeknights", check: { kind: "forbid", tag: "fish", nights: "weeknights" } },
          { sourceMessageId: m.id, action: "pin", nights: [{ night: "tuesday", rule: "pasta night", dish: LEMON_CHOICE }] },
        ],
        "Done.",
      ),
    );
    await deliver(h, h.makeWorker(), m);

    const journal = readFileSync(journalPath(h.paths.stateDir), "utf8").trim().split("\n");
    const firstReply = h.sent[0]!;
    const profileAfter = readFileSync(h.paths.profileFiles.profilePath, "utf8");
    const weekAfter = readFileSync(weekPath(h.paths.weeksDir, COMING), "utf8");

    // Keeps the journal lines up to and including the last one of the given type.
    const truncateJournalAfter = (type: string) => {
      const lastIndex = journal.map((line) => JSON.parse(line).type).lastIndexOf(type);
      writeFileSync(journalPath(h.paths.stateDir), journal.slice(0, lastIndex + 1).join("\n") + "\n");
    };
    const restoreBefore = () => {
      writeFileSync(h.paths.profileFiles.profilePath, profileBefore);
      writeFileSync(weekPath(h.paths.weeksDir, COMING), weekBefore);
    };
    h.sent = [];
    h.sendKeys = [];
    h.handled = [];
    return { h, m, journal, firstReply, profileAfter, weekAfter, truncateJournalAfter, restoreBefore };
  }

  test("the journal records the batch, then applied, then the reply's sending and outcome, then done", async () => {
    const { journal } = await completedBatch();
    expect(journal.map((line) => JSON.parse(line).type)).toEqual(["batch", "step-done", "applied", "sending", "outcome", "done"]);
  });

  test("crash after the journal record, before any file changed: applied once on restart, no model call", async () => {
    const { h, m, firstReply, profileAfter, weekAfter, truncateJournalAfter, restoreBefore } = await completedBatch();
    truncateJournalAfter("batch");
    restoreBefore();

    const worker = h.makeWorker(); // the stub brain has nothing queued: any call would fail
    await worker.recover();
    await worker.idle();

    expect(h.brain.handled.length).toBe(1);
    expect(readFileSync(h.paths.profileFiles.profilePath, "utf8")).toBe(profileAfter);
    expect(readFileSync(weekPath(h.paths.weeksDir, COMING), "utf8")).toBe(weekAfter);
    expect(h.sent).toEqual([firstReply]);
    expect(h.handled).toEqual([m.id]);
  });

  test("crash after the files changed, before the record was marked applied: nothing changes twice", async () => {
    const { h, m, weekAfter, truncateJournalAfter } = await completedBatch();
    truncateJournalAfter("batch");

    const worker = h.makeWorker();
    worker.enqueueMessage(m); // the inbox replays the unhandled message on start
    await worker.idle();

    const profile = readFileSync(h.paths.profileFiles.profilePath, "utf8");
    expect(count(profile, "No fish on weeknights")).toBe(1);
    expect(readFileSync(weekPath(h.paths.weeksDir, COMING), "utf8")).toBe(weekAfter);
    expect(h.brain.handled.length).toBe(1);
    expect(h.sent.length).toBe(1);
    expect(h.handled).toEqual([m.id]);
  });

  test("crash after applying, before the reply was sent: the reply goes out once", async () => {
    const { h, m, firstReply, truncateJournalAfter } = await completedBatch();
    truncateJournalAfter("applied");

    const worker = h.makeWorker();
    await worker.recover();
    await worker.idle();

    expect(h.sent).toEqual([firstReply]);
    expect(h.handled).toEqual([m.id]);
    expect(h.brain.handled.length).toBe(1);
  });

  // The worker cannot tell from its own journal what a half-finished send reached, so on restart
  // it hands the reply back to the sender under the same key. The sender knows per part and per
  // person what went out (see worker-messenger.test.ts for that with the real sender).
  test("crash mid-send (sending recorded, no outcome): the reply goes back through the sender with the same key", async () => {
    const { h, m, firstReply, truncateJournalAfter } = await completedBatch();
    const key = JSON.parse(readFileSync(journalPath(h.paths.stateDir), "utf8").trim().split("\n")[0]!).id;
    truncateJournalAfter("sending");

    const worker = h.makeWorker();
    await worker.recover();
    await worker.idle();

    expect(h.sent).toEqual([firstReply]);
    expect(h.sendKeys).toEqual([key]);
    expect(h.handled).toEqual([m.id]);
    const types = readFileSync(journalPath(h.paths.stateDir), "utf8").trim().split("\n").map((line) => JSON.parse(line).type);
    expect(types.slice(-2)).toEqual(["outcome", "done"]);
  });

  test("crash mid-send of a reply: the sender's answer is recorded, and a replay does not send again", async () => {
    const { h, m, truncateJournalAfter } = await completedBatch();
    truncateJournalAfter("sending");
    h.outcomes.push({ kind: "unknown", detail: "the bridge stopped during the send" });

    const worker = h.makeWorker();
    await worker.recover();
    worker.enqueueMessage(m); // the inbox replays the message too
    await worker.idle();

    expect(h.sent.length).toBe(1); // once, by the recovery
    expect(h.handled).toEqual([m.id, m.id]);
  });

  test("a lock replayed after a restart with its list already Sent posts nothing and logs nothing twice", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const lock = message("Alex", "lock it", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: lock.id, action: "lock" }]));
    h.brain.nextFill(BRISKET_FILL);
    await deliver(h, h.makeWorker(), lock);
    expect(h.sent.length).toBe(1);

    // The crash came after the outcome was recorded but before the message was marked handled.
    const journal = readFileSync(journalPath(h.paths.stateDir), "utf8").trim().split("\n");
    writeFileSync(journalPath(h.paths.stateDir), journal.filter((line) => JSON.parse(line).type !== "done").join("\n") + "\n");
    h.handled = [];

    const worker = h.makeWorker();
    worker.enqueueMessage(lock);
    await worker.idle();

    expect(h.sent.length).toBe(1);
    expect(count(logText(h), "## Week of 2026-10-05")).toBe(1);
    expect(h.handled).toEqual([lock.id]);
    expect(h.brain.handled.length).toBe(1);
  });

  // Starts a Friday draft whose send never returns, as if the bridge stopped mid-send: the
  // journal is left with the draft and "sending", and no outcome.
  async function interruptedDraft(): Promise<Harness> {
    const h = setupHarness(FRIDAY_4PM);
    h.hangSends = true;
    h.brain.next((request) => ({
      changeSet: {
        operations: [
          {
            sourceMessageId: request.triggerId,
            action: "swap",
            nights: (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const).map((name) => ({
              night: name,
              rule: null,
              dish: { kind: "out" as const },
            })),
          },
        ],
      },
      reply: { kind: "silent", reason: "draft" },
    }));
    void h.makeWorker().enqueueFridayDraft({ late: false });
    await Bun.sleep(0);
    await Bun.sleep(0);
    h.hangSends = false;
    return h;
  }

  test("a Friday draft interrupted mid-send goes back through the sender with its own key; Unknown from the sender leaves the send-unknown marker", async () => {
    const h = await interruptedDraft();
    h.outcomes.push({ kind: "unknown", detail: "the bridge stopped during the send" });
    const worker = h.makeWorker();
    await worker.recover();
    await worker.idle();

    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toContain("Monday");
    expect(h.sendKeys[0]).toStartWith("friday-draft:");
    expect(existsSync(sendUnknownMarkerPath(h.paths.stateDir, COMING))).toBe(true);
    expect(await worker.enqueueFridayDraft({ late: false })).toEqual({ kind: "send-unknown", weekOf: COMING });
  });

  test("a Friday draft interrupted mid-send, when the sender says it went out, is posted", async () => {
    const h = await interruptedDraft();
    const worker = h.makeWorker();
    await worker.recover();
    await worker.idle();

    expect(h.sent.length).toBe(1);
    expect(existsSync(postedMarkerPath(h.paths.stateDir, COMING))).toBe(true);
    expect(await worker.enqueueFridayDraft({ late: false })).toEqual({ kind: "already-posted", weekOf: COMING });
  });
});

describe("end-to-end walk with the stub brain: seed, draft, swap, lock, delta", () => {
  test("the log ends with the locked week and its change after lock", async () => {
    const h = setupHarness(THURSDAY_10AM);
    const worker = h.makeWorker();

    const seed = message("Sam", "next Tuesday tacos", THURSDAY_10AM);
    h.brain.next(answer([{ sourceMessageId: seed.id, action: "pin", nights: [{ night: "tuesday", rule: null, dish: { kind: "profile", name: "Chicken tacos" } }] }]));
    await deliver(h, worker, seed);
    expect(comingWeek(h).status).toBe("seeding");

    h.clock.nowMs = FRIDAY_4PM;
    h.brain.next((request) => ({
      changeSet: {
        operations: [
          {
            sourceMessageId: request.triggerId,
            action: "swap",
            nights: [
              { night: "monday", rule: "pasta night", dish: { kind: "profile", name: "Spaghetti and meatballs" } },
              { night: "wednesday", rule: null, dish: { kind: "profile", name: "Shrimp fried rice" } },
              { night: "thursday", rule: null, dish: LEMON_CHOICE },
              { night: "friday", rule: null, dish: { kind: "out" } },
              { night: "saturday", rule: null, dish: { kind: "away" } },
              { night: "sunday", rule: "big cook", dish: { kind: "profile", name: "Smoked brisket" } },
            ],
          },
        ],
      },
      reply: { kind: "silent", reason: "draft" },
    }));
    expect((await worker.enqueueFridayDraft({ late: false })).kind).toBe("posted");

    h.clock.nowMs = FRIDAY_6PM;
    const swap = message("Alex", "swap Wednesday for burgers", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: swap.id, action: "swap", nights: [{ night: "wednesday", rule: null, dish: { kind: "new", name: "Burgers", protein: "beef", tags: [], ingredients: [{ section: "Breads", text: "burger buns" }] } }] }]));
    await deliver(h, worker, swap);

    const lock = message("Sam", "lock it", FRIDAY_6PM + 60_000);
    h.brain.next(answer([{ sourceMessageId: lock.id, action: "lock" }]));
    h.brain.nextFill(BRISKET_FILL);
    await deliver(h, worker, lock);

    const change = message("Sam", "Thursday tacos instead", FRIDAY_6PM + 120_000);
    h.brain.next(answer([{ sourceMessageId: change.id, action: "pin", nights: [{ night: "thursday", rule: null, dish: { kind: "profile", name: "Chicken tacos" } }] }]));
    await deliver(h, worker, change);

    expect(logText(h)).toContain(
      [
        "## Week of 2026-10-05",
        "- Dates: 2026-10-05 to 2026-10-11",
        "- Status: locked",
        "- Monday: Spaghetti and meatballs (beef)",
        "- Tuesday: Chicken tacos (chicken)",
        "- Wednesday: Burgers (beef) (swapped from draft)",
        "- Thursday: Lemon garlic pasta (vegetarian)",
        "- Friday: Out (none)",
        "- Saturday: Away (none)",
        "- Sunday: Smoked brisket (beef)",
        "- Changed after lock: Thursday: Chicken tacos (chicken)",
      ].join("\n"),
    );
    expect(h.sent[h.sent.length - 1]).toContain("List changes for Oct 5 to Oct 11:");
    expect(h.handled.length).toBe(4);
  });
});

// The scheduler's entry point for the draft deadline: past Sunday noon with no draft posted, the coming week is
// skipped and counts as posted, so neither the scheduler nor the checker acts on it again.
describe("skipping a week whose draft never posted", () => {
  const SUNDAY_12_05PM = Date.parse("2026-10-04T17:05:00Z");

  test("a seeding week is skipped, the posted marker says why, and nothing is sent", async () => {
    const h = setupHarness(SUNDAY_12_05PM);
    const empty = { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null };
    saveWeek(h.paths.weeksDir, { ...draftedWeek(), status: "seeding", nights: { ...empty, tuesday: night(TACOS, { pinnedBy: "Sam" }) } });
    const worker = h.makeWorker();

    expect(await worker.enqueueMissedDraftSkip()).toEqual({ kind: "skipped", weekOf: COMING, previousStatus: "seeding" });
    expect(comingWeek(h).status).toBe("skipped");
    const marker = JSON.parse(readFileSync(postedMarkerPath(h.paths.stateDir, COMING), "utf8"));
    expect(marker.outcome).toBe("skipped-no-draft");
    expect(h.sent).toEqual([]);
    expect(h.brain.handled.length).toBe(0);

    expect(await worker.enqueueMissedDraftSkip()).toEqual({ kind: "already-posted", weekOf: COMING });
  });

  test("a week with a send-unknown marker is left alone", async () => {
    const h = setupHarness(SUNDAY_12_05PM);
    writeFileSync(sendUnknownMarkerPath(h.paths.stateDir, COMING), "{}\n");
    const worker = h.makeWorker();
    expect(await worker.enqueueMissedDraftSkip()).toEqual({ kind: "send-unknown", weekOf: COMING });
    expect(comingWeek(h).status).toBe("empty");
  });
});
