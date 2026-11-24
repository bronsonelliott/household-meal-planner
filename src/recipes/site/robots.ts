// robots.txt, read the way RFC 9309 describes.
//
//   - Rules are grouped under "User-agent" lines. We use the group(s) naming our product token
//     (the first word of our User-Agent, such as "household-meal-planner"); only when none
//     does, the "*" group(s). Groups that name us are merged.
//   - Within the chosen rules the LONGEST matching pattern wins; if an Allow and a Disallow are
//     equally long, Allow wins. "*" matches any run of characters and a trailing "$" means "the
//     path ends here".
//   - "Sitemap:" lines are global. A "Content-Signal:" line (a newer convention) can say
//     "ai-input=no"; our use feeds a model, so we treat that as a refusal.
//
// How the file's own answer is treated (also from the RFC):
//   2xx            read it
//   4xx (404 ...)  no robots.txt, so no restrictions from it
//   5xx, no reply  we cannot know, so we assume everything is off limits (and try again later)
// A 429 ("slow down") is treated like a 5xx: the polite thing is to wait.

export type RobotsFetchStatus = "ok" | "none" | "unavailable";

// What was fetched and cached for a host: the raw text, so the cache can be re-read later.
export interface RobotsInfo {
  status: RobotsFetchStatus;
  text: string;
  fetchedAt: string; // ISO time
  origin: string; // where robots.txt was found, after redirects, e.g. "https://www.example.com"
  httpStatus?: number;
  error?: string; // plain words, when unavailable
}

export interface RobotsRules {
  status: RobotsFetchStatus;
  // The site's own sitemap addresses.
  sitemaps: string[];
  // The raw Content-Signal line that applied to us, or null.
  contentSignal: string | null;
  // True when that line says ai-input=no.
  aiInputBlocked: boolean;
  // May we fetch this path (with its query, e.g. "/recipes/x?y=1")?
  allows(pathAndQuery: string): boolean;
}

// The first word of our User-Agent, lowercase: "household-meal-planner/0.1 (x)" -> "household-meal-planner".
export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/)[0] ?? "").toLowerCase();
}

interface Group {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
  signals: string[];
}

export function parseRobots(info: Pick<RobotsInfo, "status" | "text">, userAgent: string): RobotsRules {
  if (info.status === "none") return { status: "none", sitemaps: [], contentSignal: null, aiInputBlocked: false, allows: () => true };
  if (info.status === "unavailable") return { status: "unavailable", sitemaps: [], contentSignal: null, aiInputBlocked: false, allows: () => false };

  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of info.text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group; one after a rule starts a new group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], signals: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "sitemap") {
      if (value !== "") sitemaps.push(value);
    } else if (field === "allow" || field === "disallow") {
      // A rule before any User-agent line belongs to no group and is ignored.
      if (current && value !== "") current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "content-signal") {
      if (current) current.signals.push(value);
    }
  }

  const token = productToken(userAgent);
  const named = groups.filter((group) => group.agents.includes(token));
  const chosen = named.length > 0 ? named : groups.filter((group) => group.agents.includes("*"));
  const rules = chosen.flatMap((group) => group.rules).map((rule) => ({ allow: rule.allow, pattern: rule.pattern, regex: patternToRegex(rule.pattern) }));
  const signals = chosen.flatMap((group) => group.signals);

  return {
    status: "ok",
    sitemaps,
    contentSignal: signals.length > 0 ? signals.join("; ") : null,
    aiInputBlocked: signals.some(sayNoToAiInput),
    allows(pathAndQuery: string): boolean {
      const path = normalizeEscapes(pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`);
      let best: { allow: boolean; length: number } | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        const length = rule.pattern.length;
        if (best === null || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { allow: rule.allow, length };
      }
      return best === null ? true : best.allow;
    },
  };
}

// "search=yes, ai-train=no, ai-input=no" -> true
function sayNoToAiInput(signal: string): boolean {
  return signal.split(",").some((part) => /^\s*ai-input\s*=\s*no\s*$/i.test(part));
}

// A robots pattern as a regular expression that must match from the start of the path.
function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = normalizeEscapes(body)
    .split("*")
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

// "%2f" and "%2F" are the same thing: write every escape in capitals before comparing.
function normalizeEscapes(text: string): string {
  return text.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}
