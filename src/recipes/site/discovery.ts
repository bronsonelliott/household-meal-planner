// Finding recipe pages without crawling: only the sitemaps a site publishes (named in its
// robots.txt, or /sitemap.xml). We never follow links on pages and never use a site's search.

import { gunzipSync } from "node:zlib";

// A sitemap that unpacks to more than this is refused (a "zip bomb" defence).
const MAX_UNPACKED_BYTES = 20_000_000;

export interface ParsedSitemap {
  kind: "index" | "pages";
  locations: string[]; // the addresses inside: other sitemaps (index) or pages
}

// The text of a sitemap from its bytes. A file that starts with the gzip marker is unpacked
// (that is how "sitemap.xml.gz" files arrive; a server that unpacks them for us is fine too).
export function sitemapText(bytes: Uint8Array): string {
  const packed = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const raw = packed ? gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES }) : bytes;
  return new TextDecoder().decode(raw);
}

// Reads <loc> addresses with plain text matching (no XML parser, so nothing in the file can
// pull in other files). `<sitemapindex>` lists more sitemaps; `<urlset>` lists pages.
export function parseSitemap(xml: string): ParsedSitemap {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "index" : "pages";
  const locations: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)) {
    const address = match[1]!.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (address !== "") locations.push(address);
  }
  return { kind, locations };
}

// ---------------------------------------------------------------------------------------------
// Does an address look like a recipe page?
// ---------------------------------------------------------------------------------------------

// Per-site rules for sites whose recipe addresses look different: host (no "www.") -> regular
// expressions on the path. Empty by default. A site listed here uses ONLY its own rules.
export const HOST_RECIPE_PATTERNS: Record<string, string[]> = {};

const NOT_A_PAGE = /\.(?:jpe?g|png|gif|webp|svg|pdf|xml|json|css|js|mp4|zip)$/i;
const LISTING_PAGES = /\/(?:category|categories|tag|tags|author|authors|page|feed|collection|collections|roundup|search)(?:\/|$)/i;

// "/recipe/x", "/recipes/x" and "/something-recipe" look like recipes; "/recipes/" alone and
// category or tag pages do not. This is only a first filter: a page is confirmed by reading it.
export function looksLikeRecipe(address: string, host: string, overrides: Record<string, string[]> = HOST_RECIPE_PATTERNS): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const path = url.pathname.toLowerCase();
  if (NOT_A_PAGE.test(path)) return false;
  const own = overrides[host];
  if (own) return own.some((pattern) => new RegExp(pattern, "i").test(url.pathname));
  if (LISTING_PAGES.test(path)) return false;
  const inFolder = /\/recipes?\/[^/]+/.test(path);
  const lastPart = path.split("/").filter((part) => part !== "").pop() ?? "";
  return inFolder || /-recipe(?:s)?(?:$|-|\.)/.test(lastPart) || lastPart.endsWith("-recipe");
}
