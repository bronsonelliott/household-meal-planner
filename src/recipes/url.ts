// Web addresses: checking that one is safe to store, cleaning it up so the same recipe always
// gets the same id, and building a site's search link.

import { createHash } from "node:crypto";
import type { RecipeSource } from "./types.ts";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

// Query parameters that only track where a click came from. Anything starting "utm_" goes too.
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "msclkid", "igshid", "mc_cid", "mc_eid", "_ga", "ref", "ref_src", "cmpid", "trk"]);

// Only plain web addresses to a real public-looking host: http or https, no sign-in details in
// the address, no IP addresses, no "localhost" or other internal names.
export function checkWebUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "that doesn't look like a web address" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "only http and https web addresses work" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "web addresses with a user name or password in them aren't allowed" };
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { ok: false, reason: "IP addresses aren't allowed, only site names" };
  }
  const internal = host === "localhost" || /\.(localhost|local|internal|lan|home|test)$/.test(host);
  if (internal || !host.includes(".")) return { ok: false, reason: "that is not a public site name" };
  return { ok: true, url };
}

// "www.Example.com" -> "example.com"
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

export function hostOf(url: URL): string {
  return normalizeHost(url.hostname);
}

// Does `host` belong to the site `sourceHost`? The site itself or any of its subdomains.
export function hostMatches(host: string, sourceHost: string): boolean {
  return host === sourceHost || host.endsWith(`.${sourceHost}`);
}

// The address with tracking parameters, the fragment and a trailing slash removed, the host
// lowercased, and the remaining parameters in a fixed order. A link pasted twice from different
// places comes out as the same text.
export function canonicalUrl(url: URL): string {
  const clean = new URL(url.toString());
  clean.hash = "";
  const kept = [...clean.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  clean.search = "";
  for (const [key, value] of kept) clean.searchParams.append(key, value);
  let text = clean.toString();
  if (clean.pathname.length > 1 && clean.pathname.endsWith("/") && clean.search === "") text = text.replace(/\/$/, "");
  else if (clean.pathname.length > 1 && clean.pathname.endsWith("/")) text = text.replace(/\/\?/, "?");
  return text;
}

// A stable id for a recipe link: the same page gets the same id whether or not it was written
// with "www." or a tracking tail. Short, because the model has to copy it back exactly.
export function recipeIdFor(url: URL): string {
  const clean = new URL(canonicalUrl(url));
  clean.hostname = normalizeHost(clean.hostname);
  clean.protocol = "https:"; // http and https versions of a page are the same recipe
  const digest = createHash("sha256").update(clean.toString()).digest("hex");
  return `rcp-${digest.slice(0, 10)}`;
}

// A name from the last part of a recipe address: ".../recipes/chicken-tinga-tacos-123/" ->
// "Chicken Tinga Tacos". Trailing numbers and file endings are dropped.
export function nameFromUrl(url: URL): string {
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const slug = parts.length > 0 ? parts[parts.length - 1]! : "";
  const words = decodeURIComponent(slug.replace(/\.(html?|php|aspx?)$/i, ""))
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "" && !/^\d+$/.test(word));
  if (words.length === 0) return hostOf(url);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

// The source's search link for some words. Where "{q}" sits in the path the words are joined
// with "-" (like Food Network's search pages); in a query string they are joined with "+".
export function searchLink(source: Pick<RecipeSource, "searchUrl">, query: string): string {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  const template = source.searchUrl;
  const at = template.indexOf("{q}");
  const inQuery = at !== -1 && template.slice(0, at).includes("?");
  return template.replace("{q}", words.join(inQuery ? "+" : "-"));
}
