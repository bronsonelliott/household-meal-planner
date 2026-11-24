// A fresh install has no data/ or state/ folder. The first saves must create them, not crash.
// (Found on the first live run: seeding the recipe sources failed with ENOENT.)

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLineDurably, writeFileAtomically } from "../src/data/files.ts";

describe("first writes on a fresh install", () => {
  test("an atomic write creates the missing folder", () => {
    const root = mkdtempSync(join(tmpdir(), "hmp-fresh-"));
    const target = join(root, "data", "recipe-sources.json");
    writeFileAtomically(target, "{}");
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  test("a journal append creates the missing folder", () => {
    const root = mkdtempSync(join(tmpdir(), "hmp-fresh-"));
    const target = join(root, "state", "inbox.jsonl");
    appendLineDurably(target, { ok: true });
    expect(existsSync(target)).toBe(true);
  });
});
