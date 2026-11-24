// Every rule written in docs/house-rules.md must be a rule the real profile parser accepts.
// The doc is a cookbook people copy from, so a rule that does not parse would stop their bot.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProfile } from "../src/data/profile.ts";

const DOC = readFileSync(join(import.meta.dir, "..", "docs", "house-rules.md"), "utf8");

// The text of every fenced code block in the doc.
function codeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      if (current === null) current = [];
      else {
        blocks.push(current.join("\n"));
        current = null;
      }
    } else if (current !== null) {
      current.push(line);
    }
  }
  return blocks;
}

// The rule lines in the blocks: every list line that has a check in square brackets.
// Dish-tag examples ("- Protein: chicken") have no brackets, so they are skipped.
function ruleLines(markdown: string): string[] {
  return codeBlocks(markdown)
    .flatMap((block) => block.split("\n"))
    .filter((line) => line.startsWith("- ") && line.includes("["));
}

// The smallest profile the parser accepts, with the given rule lines under "## Rules".
function profileAround(rules: string[]): string {
  return [
    "## Rules",
    ...rules,
    "## Usual Dishes",
    "## Also-Like Dishes",
    "## Staples",
    "## Dislikes",
    "## Vetoes",
    "## Lock Words",
    "## Thresholds",
    "- max-usual-dishes-per-week: 2",
    "- max-nights-per-protein: 2",
    "- repeat-window-weeks: 3",
    "- batching-window-seconds: 15",
  ].join("\n");
}

describe("house-rules cookbook", () => {
  const rules = ruleLines(DOC);

  test("has the promised amount of rules", () => {
    expect(new Set(rules).size).toBeGreaterThanOrEqual(25);
  });

  test("every rule line parses, and is a real check unless it says [advisory]", () => {
    for (const line of rules) {
      const parsed = parseProfile(profileAround([line])).rules;
      expect(parsed.length, line).toBe(1);
      if (!line.endsWith("[advisory]")) expect(parsed[0]!.check.kind, line).not.toBe("advisory");
    }
  });

  test("every sample ## Rules block parses with its rules intact", () => {
    const samples = codeBlocks(DOC).filter((block) => block.startsWith("## Rules"));
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const block of samples) {
      const lines = block.split("\n").filter((line) => line.startsWith("- "));
      expect(parseProfile(profileAround(lines)).rules.length).toBe(lines.length);
    }
  });
});
