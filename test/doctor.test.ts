// `bun run doctor`: plain-words OK or a list of problems; starts nothing, sends nothing.

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/doctor.ts";
import { exampleConfigText } from "./fixtures/config-fixtures.ts";

const EXAMPLE_PROFILE = join(import.meta.dir, "..", "data.example", "profile.md");
const KEY = "sk-ant-doctor-test-DO-NOT-PRINT";

// A folder with config.toml and data/profile.md, the way a household would set it up.
function household(options: { config?: string; profile?: string | null } = {}): { env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  writeFileSync(join(dir, "config.toml"), options.config ?? exampleConfigText());
  mkdirSync(join(dir, "data"));
  if (options.profile === undefined) copyFileSync(EXAMPLE_PROFILE, join(dir, "data", "profile.md"));
  else if (options.profile !== null) writeFileSync(join(dir, "data", "profile.md"), options.profile);
  return { env: { HMP_CONFIG: join(dir, "config.toml"), ANTHROPIC_API_KEY: KEY } };
}

describe("bun run doctor", () => {
  test("the example setup is OK, in plain words, and says nothing was started or sent", () => {
    const report = runDoctor(household().env);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    const text = report.lines.join("\n");
    expect(text).toContain("All good. Your setup looks ready.");
    expect(text).toContain("friday at 16:00, America/New_York");
    expect(text).toContain("Nothing was started and nothing was sent.");
  });

  test("never prints a secret, even a valid one", () => {
    const report = runDoctor(household().env);
    expect(report.lines.join("\n")).not.toContain(KEY);
  });

  test("a bad config lists every problem, each naming its setting", () => {
    const { env } = household({ config: exampleConfigText((t) => t.replace('timezone = "America/New_York"', 'timezone = "Nowhere/Land"').replace('role = "admin"', 'role = "adult"')) });
    const report = runDoctor(env);
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toBe("Not ready yet. 2 things to fix:");
    expect(report.problems.some((p) => p.startsWith("config: schedule.timezone"))).toBe(true);
    expect(report.problems.some((p) => p.startsWith("config: No member has role"))).toBe(true);
  });

  test("a missing config file says how to make one", () => {
    const report = runDoctor({ HMP_CONFIG: join(tmpdir(), "no-such-folder", "config.toml") });
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toContain("config.example.toml");
  });

  test("a missing profile, or a profile with a bad grocery section, is reported", () => {
    expect(runDoctor(household({ profile: null }).env).problems[0]).toContain("there is no profile.md");

    const bad = "## Grocery Sections\n- Produce\n";
    const text = "# P\n## Rules\n## Usual Dishes\n### Soup\n- Protein: none\n- Dairy: cream\n## Also-Like Dishes\n## Staples\n## Dislikes\n## Vetoes\n## Lock Words\n- lock it\n## Thresholds\n";
    const report = runDoctor(household({ profile: bad + text }).env);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("profile:");
  });

  test("a missing secret is named by its variable only", () => {
    const { env } = household();
    delete (env as Record<string, string | undefined>).ANTHROPIC_API_KEY;
    const report = runDoctor(env);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(["secrets: The environment variable ANTHROPIC_API_KEY is not set. It should hold the model API key."]);
  });

  test("it runs from the command line, prints the verdict, and exits 0 when ready", async () => {
    const { env } = household();
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "doctor.ts")], { env: { PATH: process.env.PATH ?? "", ...env } });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("All good");
    expect(run.stdout.toString()).not.toContain(KEY);

    const broken = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "doctor.ts")], { env: { PATH: process.env.PATH ?? "", HMP_CONFIG: "/no/such/config.toml" } });
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout.toString()).toContain("Not ready yet");
  });
});

describe("doctor: tags no dish carries", () => {
  test("warns, without failing, when a rule's tag is on no dish", () => {
    const { readFileSync } = require("node:fs");
    const profile = readFileSync(EXAMPLE_PROFILE, "utf8").replace("- At least one pasta night a week. [min pasta 1]", "- Sushi twice a week. [min sushi 2]");
    const report = runDoctor(household({ profile }).env);
    expect(report.ok).toBe(true);
    expect(report.warnings?.[0]).toContain('needs a dish tagged "sushi"');
    expect(report.lines.join("\n")).toContain("Worth a look (not blocking):");
  });

  test("the example profile has no warnings", () => {
    const report = runDoctor(household().env);
    expect(report.warnings).toEqual([]);
    expect(report.lines.join("\n")).not.toContain("Worth a look");
  });
});
