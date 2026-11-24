// The one live model call. Skipped unless HMP_LIVE_TEST=1 and an API key is set.
//
// It makes one real, small call with the household's own API key and checks that the reply
// parses against the change-set schema. It costs a fraction of a cent.
//
// Run it on purpose:  HMP_LIVE_TEST=1 ANTHROPIC_API_KEY=... bun test test/brain.live.test.ts
// (HMP_MODEL overrides the model; the key variable is the one named in config.toml.)

import { describe, expect, test } from "bun:test";
import { createClaudeCaller } from "../src/brain/claude.ts";
import { buildSystemPrompt } from "../src/brain/index.ts";
import { parseModelOutput } from "../src/brain/schema.ts";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_GROCERY_SECTIONS } from "../src/data/profile.ts";

const app = process.env.HMP_LIVE_TEST === "1" ? loadConfig() : null;
const RUN = app !== null && Boolean(process.env[app.model.apiKeyEnv]);

describe("live model call", () => {
  test.skipIf(!RUN)(
    "one real call with the household's API key returns a reply that parses",
    async () => {
      const config = app!;
      const call = createClaudeCaller({
        model: process.env.HMP_MODEL || config.model.id,
        apiKeyEnv: config.model.apiKeyEnv,
        maxTokens: config.model.maxOutputTokens,
        timeoutMs: config.model.timeoutMs,
      });
      const answer = await call({
        system: buildSystemPrompt({
          timeZone: config.schedule.timeZone,
          weeknights: config.planning.weeknights,
          minDiscoveryNights: config.planning.minDiscoveryNights,
          botName: config.household.botName,
          memberNames: config.members.map((member) => member.name),
        }),
        prompt: '# Task\nThis is a connection test, not a real request. Answer with no operations and a silent reply whose reason is "connection test".',
      });

      const parsed = parseModelOutput(answer.text, DEFAULT_GROCERY_SECTIONS);
      if (!parsed.ok) console.log(answer.text);
      expect(parsed.ok).toBe(true);
    },
    150_000,
  );
});
