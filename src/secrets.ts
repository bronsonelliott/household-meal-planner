// Handling of secrets (API keys, tokens, passwords) read from the environment.
//
// The rule that keeps them out of logs: clean a secret ONCE, then use that same cleaned value
// both for the request and for the list of things to blank out of messages. If the request used
// one spelling and the blanking list another, a leak would slip through.

// What a person pasted into .env, made into what is actually sent: surrounding spaces and
// newlines removed, and one pair of matching quotes if the value was written "like this".
export function cleanCredential(raw: string | undefined): string {
  let value = (raw ?? "").trim();
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first!)) value = value.slice(1, -1).trim();
  }
  return value;
}

// Every spelling of a secret that could show up in a message: as it is, and as it looks inside
// a web address (URL-encoded).
export function secretSpellings(secret: string): string[] {
  if (secret === "") return [];
  return [...new Set([secret, encodeURIComponent(secret)])];
}

// Blanks every spelling of every secret out of `text`.
export function blankOut(text: string, secrets: string[], replacement = "***"): string {
  let clean = text;
  for (const secret of secrets) {
    for (const spelling of secretSpellings(secret)) {
      if (spelling.length >= 4) clean = clean.split(spelling).join(replacement);
    }
  }
  return clean;
}
