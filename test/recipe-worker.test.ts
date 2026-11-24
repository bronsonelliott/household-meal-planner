// Recipe commands and linked dishes through the worker: commands are answered by code before
// the model, through the same journal as any batch, and a night keeps its own copy of the
// recipe or link it came from.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadSources } from "../src/recipes/sources.ts";
import { saveCatalog } from "../src/recipes/catalog.ts";
import { loadWeek, renderWeekLines, saveWeek } from "../src/week/state.ts";
import { BatchJournal, journalPath } from "../src/week/journal.ts";
import { draftedWeek } from "./fixtures/week-fixtures.ts";
import { answer, FRIDAY_6PM, message, setupHarness, type Harness } from "./fixtures/worker-harness.ts";
import { bookmarkRecipe, fetchedRecipe, recipeContext } from "./fixtures/brain-fixtures.ts";

const COMING = "2026-10-05";

async function say(h: Harness, worker: ReturnType<Harness["makeWorker"]>, who: "Alex" | "Sam", text: string, atMs: number) {
  const event = message(who, text, atMs);
  worker.enqueueMessage(event);
  h.clock.advance(15_000);
  await worker.idle();
  return event;
}

const sourcesOf = (h: Harness) => loadSources(h.paths.sourcesPath, "2026-10-02T23:00:00.000Z").sources;
const week = (h: Harness) => loadWeek(h.paths.weeksDir, COMING);

describe("recipe commands through the worker", () => {
  test("a command-only message is answered by code: no model call, one reply, marked handled", async () => {
    const h = setupHarness(FRIDAY_6PM);
    const worker = h.makeWorker();
    const event = await say(h, worker, "Sam", "sources", FRIDAY_6PM);

    expect(h.brain.handled).toEqual([]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toStartWith("Recipe sources:\n- Food Network (foodnetwork.com)");
    expect(h.handled).toEqual([event.id]);
  });

  test("a command is answered right away, without waiting out the quiet window", async () => {
    const h = setupHarness(FRIDAY_6PM);
    const worker = h.makeWorker();
    worker.enqueueMessage(message("Sam", "/recipes status", FRIDAY_6PM));
    await worker.idle(); // no clock advance
    expect(h.sent).toEqual(['No recipes are saved yet. Save one with "recipe save <web address> [name]".']);
  });

  test("admin-only commands follow the configured role: Alex (admin) may, Sam may not", async () => {
    const h = setupHarness(FRIDAY_6PM);
    const worker = h.makeWorker();
    await say(h, worker, "Sam", "sources add https://smittenkitchen.com", FRIDAY_6PM);
    expect(h.sent.at(-1)).toBe("Only an admin can add recipe sources.");
    expect(sourcesOf(h).map((source) => source.host)).not.toContain("smittenkitchen.com");

    await say(h, worker, "Alex", "sources add https://smittenkitchen.com", FRIDAY_6PM + 60_000);
    expect(h.sent.at(-1)).toStartWith("Added smittenkitchen.com");
    expect(sourcesOf(h).map((source) => source.host)).toContain("smittenkitchen.com");
  });

  test("any member can save a recipe link", async () => {
    const h = setupHarness(FRIDAY_6PM);
    const worker = h.makeWorker();
    await say(h, worker, "Sam", "recipe save https://www.thekitchn.com/recipes/chicken-tinga Chicken tinga", FRIDAY_6PM);
    expect(h.sent.at(-1)).toStartWith('Saved "Chicken tinga" (from The Kitchn).');
    expect(JSON.parse(readFileSync(h.paths.catalogPath, "utf8")).records).toHaveLength(1);
  });

  test("a message that mixes a command with other talk goes to the model, and runs no command", async () => {
    const h = setupHarness(FRIDAY_6PM);
    const worker = h.makeWorker();
    const event = message("Alex", "sources add https://smittenkitchen.com and swap Tuesday please", FRIDAY_6PM);
    h.brain.next(answer([], "I can't run commands from a longer message; send it on its own."));
    worker.enqueueMessage(event);
    h.clock.advance(15_000);
    await worker.idle();

    expect(h.brain.handled).toHaveLength(1);
    expect(sourcesOf(h).map((source) => source.host)).not.toContain("smittenkitchen.com");
  });

  test("a restart does not run a journaled command again or answer it twice", async () => {
    const h = setupHarness(FRIDAY_6PM);
    const first = h.makeWorker();
    const event = await say(h, first, "Alex", "sources add https://smittenkitchen.com", FRIDAY_6PM);
    expect(h.sent).toHaveLength(1);
    const savedFile = readFileSync(h.paths.sourcesPath, "utf8");

    const second = h.makeWorker();
    await second.recover();
    second.enqueueMessage(event); // the messenger hands over the same message again
    await second.idle();

    expect(h.sent).toHaveLength(1);
    expect(readFileSync(h.paths.sourcesPath, "utf8")).toBe(savedFile);
    const journal = new BatchJournal(journalPath(h.paths.stateDir), () => {});
    expect(journal.get(event.id)!.done).toBe(true);
  });

  test("a crash after the command ran but before its reply is sent finishes the reply without running it again", async () => {
    const h = setupHarness(FRIDAY_6PM);
    h.hangSends = true; // the process "dies" in the middle of the send
    const first = h.makeWorker();
    const event = message("Alex", "sources add https://smittenkitchen.com", FRIDAY_6PM);
    first.enqueueMessage(event);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const journal = new BatchJournal(journalPath(h.paths.stateDir), () => {});
    expect(journal.get(event.id)!.applied?.reply).toStartWith("Added smittenkitchen.com");
    expect(existsSync(h.paths.sourcesPath)).toBe(true);
    const savedFile = readFileSync(h.paths.sourcesPath, "utf8");

    h.hangSends = false;
    const second = h.makeWorker();
    await second.recover();
    expect(readFileSync(h.paths.sourcesPath, "utf8")).toBe(savedFile);
    expect(h.handled).toContain(event.id);
  });
});

describe("linked dishes in a planned week", () => {
  const TINGA = { kind: "source" as const, sourceId: "the-kitchn", name: "Chicken tinga", protein: "chicken", tags: ["mexican"] };

  function fills(...nights: Array<{ night: "tuesday" | "wednesday" | "sunday"; dish: string }>) {
    return nights.map(({ night, dish }) => ({
      weekOf: COMING,
      night,
      dish,
      ingredients: [{ section: "Meat & Fish" as const, text: `${dish} meat, 1 lb` }],
    }));
  }

  test("a suggested source dish keeps its search link; locking asks for its ingredients and labels them as the model's", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();

    const swap = message("Sam", "how about chicken tinga on Tuesday", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: swap.id, action: "swap", nights: [{ night: "tuesday", rule: "pasta night", dish: TINGA }] }], "Tinga it is."));
    worker.enqueueMessage(swap);
    h.clock.advance(15_000);
    await worker.idle();

    expect(h.sent[0]).toContain(
      "• Tuesday: Chicken tinga (pasta night) · suggested dish, search The Kitchn: https://www.thekitchn.com/search?q=chicken+tinga",
    );
    expect(week(h).nights.tuesday!.recipe).toEqual({
      origin: "source",
      recipeId: null,
      url: "https://www.thekitchn.com/search?q=chicken+tinga",
      sourceId: "the-kitchn",
      sourceName: "The Kitchn",
      ingredientProvenance: "generated",
    });

    const lock = message("Alex", "lock it", FRIDAY_6PM + 60_000);
    h.brain.next(answer([{ sourceMessageId: lock.id, action: "lock" }], "Locking."));
    h.brain.nextFill(fills({ night: "tuesday", dish: "Chicken tinga" }, { night: "sunday", dish: "Smoked brisket" }));
    worker.enqueueMessage(lock);
    h.clock.advance(15_000);
    await worker.idle();

    expect(h.brain.fillRequests[0]).toEqual([
      { weekOf: COMING, night: "tuesday", dish: "Chicken tinga", pool: "source", publisherLines: null },
      { weekOf: COMING, night: "sunday", dish: "Smoked brisket", pool: "usual", publisherLines: null },
    ]);
    expect(h.sent[1]).toContain("I wrote the ingredient lists for Chicken tinga myself, not from a recipe, so check them against the link.");
    expect(h.sent[1]).toContain("Want a recipe link? Just ask for: Chicken tinga.");
  });

  test("a saved link and a fetched recipe are chosen by catalog id; the fetched one hands its publisher lines to the lock", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const records = recipeContext([
      bookmarkRecipe("Sheet pan gnocchi", { id: "rcp-gnocchi0001", url: "https://www.thekitchn.com/sheet-pan-gnocchi" }),
      fetchedRecipe("Beef stew", "beef", { id: "rcp-stew00001", url: "https://www.themealdb.com/meal/52", ingredients: ["1 lb beef", "2 carrots"] }),
    ]).catalog;
    saveCatalog(h.paths.catalogPath, records);
    const worker = h.makeWorker();

    const swap = message("Sam", "gnocchi Tuesday and beef stew Sunday", FRIDAY_6PM);
    h.brain.next(
      answer(
        [
          {
            sourceMessageId: swap.id,
            action: "pin",
            nights: [
              { night: "tuesday", rule: null, dish: { kind: "catalog", id: "rcp-gnocchi0001", tags: ["pasta"] } },
              { night: "sunday", rule: null, dish: { kind: "catalog", id: "rcp-stew00001", tags: [] } },
            ],
          },
        ],
        "Done.",
      ),
    );
    worker.enqueueMessage(swap);
    h.clock.advance(15_000);
    await worker.idle();

    expect(h.sent[0]).toContain("• Tuesday: Sheet pan gnocchi (Sam's pick) · saved recipe: https://www.thekitchn.com/sheet-pan-gnocchi");
    expect(h.sent[0]).toContain("• Sunday: Beef stew (Sam's pick) · recipe from TheMealDB: https://www.themealdb.com/meal/52");

    const lock = message("Alex", "lock it", FRIDAY_6PM + 60_000);
    h.brain.next(answer([{ sourceMessageId: lock.id, action: "lock" }], "Locking."));
    h.brain.nextFill(fills({ night: "tuesday", dish: "Sheet pan gnocchi" }, { night: "sunday", dish: "Beef stew" }));
    worker.enqueueMessage(lock);
    h.clock.advance(15_000);
    await worker.idle();

    expect(h.brain.fillRequests[0]).toEqual([
      { weekOf: COMING, night: "tuesday", dish: "Sheet pan gnocchi", pool: "catalog", publisherLines: null },
      { weekOf: COMING, night: "sunday", dish: "Beef stew", pool: "catalog", publisherLines: ["1 lb beef", "2 carrots"] },
    ]);
    // Only the saved link's lines are the model's; the fetched recipe's came from the publisher.
    expect(h.sent[1]).toContain("I wrote the ingredient lists for Sheet pan gnocchi myself");
    expect(h.sent[1]).not.toContain("for Sheet pan gnocchi, Beef stew");
  });

  test("a locked week keeps its links after the source is removed and the saved recipe is replaced", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    saveCatalog(h.paths.catalogPath, recipeContext([bookmarkRecipe("Sheet pan gnocchi", { id: "rcp-gnocchi0001", url: "https://www.thekitchn.com/sheet-pan-gnocchi" })]).catalog);
    const worker = h.makeWorker();

    const swap = message("Sam", "gnocchi Tuesday, tinga Wednesday", FRIDAY_6PM);
    h.brain.next(
      answer(
        [
          {
            sourceMessageId: swap.id,
            action: "pin",
            nights: [
              { night: "tuesday", rule: null, dish: { kind: "catalog", id: "rcp-gnocchi0001", tags: ["pasta"] } },
              { night: "wednesday", rule: null, dish: TINGA },
            ],
          },
        ],
        "Done.",
      ),
    );
    worker.enqueueMessage(swap);
    h.clock.advance(15_000);
    await worker.idle();

    const lock = message("Alex", "lock it", FRIDAY_6PM + 60_000);
    h.brain.next(answer([{ sourceMessageId: lock.id, action: "lock" }], "Locking."));
    h.brain.nextFill(fills({ night: "tuesday", dish: "Sheet pan gnocchi" }, { night: "wednesday", dish: "Chicken tinga" }, { night: "sunday", dish: "Smoked brisket" }));
    worker.enqueueMessage(lock);
    h.clock.advance(15_000);
    await worker.idle();

    const lockedFile = readFileSync(`${h.paths.weeksDir}/${COMING}.json`, "utf8");
    const linesBefore = renderWeekLines(week(h));
    expect(week(h).status).toBe("locked");

    // The admin removes the source, and the saved recipe is rewritten with another link.
    await say(h, worker, "Alex", "sources remove thekitchn.com", FRIDAY_6PM + 120_000);
    expect(h.sent.at(-1)).toStartWith("Removed The Kitchn.");
    saveCatalog(h.paths.catalogPath, recipeContext([bookmarkRecipe("Sheet pan gnocchi", { id: "rcp-gnocchi0001", url: "https://elsewhere.example.com/other" })], ["the-kitchn"]).catalog);
    // Any later change to the week must not touch the links on untouched nights.
    const later = message("Sam", "we have onions", FRIDAY_6PM + 180_000);
    h.brain.next(answer([{ sourceMessageId: later.id, action: "have", items: ["onions"] }], "Noted."));
    worker.enqueueMessage(later);
    h.clock.advance(15_000);
    await worker.idle();

    expect(sourcesOf(h).map((source) => source.id)).not.toContain("the-kitchn");
    expect(renderWeekLines(week(h))).toEqual(linesBefore);
    const after = JSON.parse(readFileSync(`${h.paths.weeksDir}/${COMING}.json`, "utf8"));
    const before = JSON.parse(lockedFile);
    expect(after.nights.tuesday.recipe).toEqual(before.nights.tuesday.recipe);
    expect(after.nights.wednesday.recipe).toEqual(before.nights.wednesday.recipe);
    expect(after.nights.tuesday.recipe.url).toBe("https://www.thekitchn.com/sheet-pan-gnocchi");
  });

  test("a source id that is not configured leaves the night alone and says so", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    const worker = h.makeWorker();
    const swap = message("Sam", "tinga Tuesday", FRIDAY_6PM);
    h.brain.next(answer([{ sourceMessageId: swap.id, action: "swap", nights: [{ night: "tuesday", rule: null, dish: { ...TINGA, sourceId: "nowhere" } }] }], "Done."));
    worker.enqueueMessage(swap);
    h.clock.advance(15_000);
    await worker.idle();
    expect(h.sent[0]).toContain(`"nowhere" isn't one of the recipe sources, so I left Tuesday alone.`);
    expect(week(h).nights.tuesday!.dish).toBe("Spaghetti and meatballs");
  });

  test("a damaged sources file does not stop planning; the log says why", async () => {
    const h = setupHarness(FRIDAY_6PM);
    saveWeek(h.paths.weeksDir, draftedWeek());
    writeFileSync(h.paths.sourcesPath, "{ broken");
    const worker = h.makeWorker();
    const m = message("Sam", "thanks", FRIDAY_6PM);
    h.brain.next(answer([], null));
    worker.enqueueMessage(m);
    h.clock.advance(15_000);
    await worker.idle();
    expect(h.brain.handled).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("recipe sources not used"))).toBe(true);
  });
});
