// Cuts a long reply into parts that each fit the platform's message limit.
//
// It prefers to cut at a blank line, then at a line break, then at a space, so a part does not
// end mid-sentence. Only a single word longer than the limit is cut in the middle.

export function splitMessage(text: string, maxChars: number): string[] {
  if (maxChars < 1) throw new Error("maxChars must be at least 1");
  const parts: string[] = [];
  let rest = text.trim();
  if (rest === "") return [""];

  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let cut = Math.max(window.lastIndexOf("\n\n"), -1);
    if (cut < maxChars / 2) cut = window.lastIndexOf("\n");
    if (cut < maxChars / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = maxChars; // one very long word: cut it where it stands
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  return parts.filter((part) => part !== "");
}
