import { describe, expect, test } from "bun:test";
import { parseModelOutput } from "../src/brain/schema.ts";
import { DEFAULT_SECTIONS } from "./fixtures/config-fixtures.ts";

const parse = (answer: string, sections: readonly string[] = DEFAULT_SECTIONS) => parseModelOutput(answer, sections);

// A model answer with one operation and a silent reply, as the model would send it.
function answerWith(operation: Record<string, unknown>): string {
  return JSON.stringify({ operations: [operation], reply: { kind: "silent", reason: "nothing to say" } });
}

// A string the model could return that, written into profile.md as-is, would start a new
// "## Lock Words" section and replace the real lock words with "ok".
const INJECTED = "Liver\n## Lock Words\n- ok";

describe("model strings must be one line", () => {
  test("a plain veto still parses (control for the cases below)", () => {
    const parsed = parse(answerWith({ action: "veto", sourceMessageId: "m1", dish: "Liver" }));
    expect(parsed.ok).toBe(true);
  });

  test("a veto dish with a line break is rejected, naming the field", () => {
    const parsed = parse(answerWith({ action: "veto", sourceMessageId: "m1", dish: INJECTED }));
    expect(parsed).toEqual({ ok: false, problems: ["operations[0].dish must be one line, with no line breaks"] });
  });

  test("rule prose with a line break is rejected, naming the field", () => {
    const parsed = parse(
      answerWith({ action: "rule", sourceMessageId: "m1", prose: `Soup on Mondays.${INJECTED}`, check: { kind: "advisory" } }),
    );
    expect(parsed).toEqual({ ok: false, problems: ["operations[0].prose must be one line, with no line breaks"] });
  });

  test("an ingredient line with a line break is rejected, naming the field", () => {
    const parsed = parse(
      answerWith({
        action: "add-dish",
        sourceMessageId: "m1",
        pool: "usual",
        dish: {
          name: "Chicken soup",
          protein: "chicken",
          tags: ["quick"],
          ingredients: [{ section: "Meat & Fish", text: `chicken thighs, 2 lb\n## Lock Words\n- ok` }],
        },
      }),
    );
    expect(parsed).toEqual({
      ok: false,
      problems: ["operations[0].dish.ingredients[0].text must be one line, with no line breaks"],
    });
  });

  test("a list item with a line break is rejected, naming the list", () => {
    const parsed = parse(answerWith({ action: "have", sourceMessageId: "m1", items: ["rice", "eggs\r\n## Staples"] }));
    expect(parsed).toEqual({ ok: false, problems: ["operations[0].items must hold one-line strings, with no line breaks"] });
  });

  test("the Unicode line separator counts as a line break", () => {
    const parsed = parse(answerWith({ action: "veto", sourceMessageId: "m1", dish: "Liver\u2028## Lock Words" }));
    expect(parsed).toEqual({ ok: false, problems: ["operations[0].dish must be one line, with no line breaks"] });
  });
  test("a night's rule with a line break is rejected, naming the field", () => {
    const parsed = parse(
      answerWith({ action: "swap", sourceMessageId: "m1", nights: [{ night: "tuesday", rule: INJECTED, dish: { kind: "profile", name: "Chicken tacos" } }] }),
    );
    expect(parsed).toEqual({ ok: false, problems: ["operations[0].nights[0].rule must be one line, with no line breaks"] });
  });

  test("a set-aside rule with a line break is rejected", () => {
    const parsed = parse(
      JSON.stringify({ operations: [], reply: { kind: "silent", reason: "x" }, setAside: [{ rule: INJECTED, sourceMessageId: "m1" }] }),
    );
    expect(parsed).toEqual({ ok: false, problems: ["setAside rule must be one line, with no line breaks"] });
  });
});

describe("grocery sections in the model's answer", () => {
  const swapWith = (section: string) =>
    answerWith({
      action: "swap",
      sourceMessageId: "m1",
      nights: [{ night: "tuesday", rule: null, dish: { kind: "new", name: "Gnocchi", protein: "vegetarian", tags: [], ingredients: [{ section, text: "gnocchi, 1 lb" }] } }],
    });

  test("a section from a custom list is accepted and normalized to the list's spelling", () => {
    const parsed = parse(swapWith("produce"), ["Produce", "Butcher"]);
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).toContain('"section":"Produce"');
  });

  test("a section that is only on the default list is rejected under a custom list", () => {
    const parsed = parse(swapWith("Vegetables"), ["Produce", "Butcher"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join(" ")).toContain("use one of: Produce, Butcher");
  });

  test("an unknown section is rejected under the default list", () => {
    expect(parse(swapWith("Produce")).ok).toBe(false);
  });
});

describe("catalog and source dishes in the model's answer", () => {
  const swapWith = (dish: Record<string, unknown>) =>
    answerWith({ action: "swap", sourceMessageId: "m1", nights: [{ night: "tuesday", rule: null, dish }] });
  const dishOf = (parsed: ReturnType<typeof parse>) => {
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    return (parsed.value.changeSet.operations[0] as { nights: Array<{ dish: unknown }> }).nights[0]!.dish;
  };

  test("a catalog dish is an id and tags", () => {
    expect(dishOf(parse(swapWith({ kind: "catalog", id: "rcp-1a2b3c4d5e", tags: ["Quick"] })))).toEqual({ kind: "catalog", id: "rcp-1a2b3c4d5e", tags: ["quick"] });
    expect(dishOf(parse(swapWith({ kind: "catalog", id: "rcp-1a2b3c4d5e" })))).toEqual({ kind: "catalog", id: "rcp-1a2b3c4d5e", tags: [] });
  });

  test("a source dish is a source id, a name, optional protein, and tags", () => {
    expect(dishOf(parse(swapWith({ kind: "source", sourceId: "the-kitchn", name: "Chicken tinga", protein: "Chicken", tags: ["mexican"] })))).toEqual({
      kind: "source",
      sourceId: "the-kitchn",
      name: "Chicken tinga",
      tags: ["mexican"],
      protein: "chicken",
    });
    expect(dishOf(parse(swapWith({ kind: "source", sourceId: "the-kitchn", name: "Chicken tinga" })))).toEqual({
      kind: "source",
      sourceId: "the-kitchn",
      name: "Chicken tinga",
      tags: [],
    });
  });

  test("missing or multi-line fields are named in the problems", () => {
    expect(parse(swapWith({ kind: "catalog", tags: [] }))).toEqual({ ok: false, problems: ["operations[0].nights[0].dish.id must be a non-empty string"] });
    expect(parse(swapWith({ kind: "source", name: "Soup", tags: [] }))).toEqual({
      ok: false,
      problems: ["operations[0].nights[0].dish.sourceId must be a non-empty string"],
    });
    const lines = parse(swapWith({ kind: "source", sourceId: "the-kitchn", name: "Soup\n## Lock Words", tags: [] }));
    expect(lines).toEqual({ ok: false, problems: ["operations[0].nights[0].dish.name must be one line, with no line breaks"] });
  });

  test("the old kind is gone, and the message lists the real ones", () => {
    const parsed = parse(swapWith({ kind: "copy", name: "x" }));
    expect(parsed).toEqual({ ok: false, problems: ["operations[0].nights[0].dish.kind must be one of profile, catalog, source, new, out, away"] });
  });
});
