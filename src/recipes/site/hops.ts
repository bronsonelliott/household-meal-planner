// The rule for redirects while fetching from a site an admin switched on. A page we are allowed
// to fetch must not be able to send us somewhere we are not allowed to go: the destination is
// checked BEFORE it is requested.
//
// The rule is deliberately strict and simple: a redirect may only stay on the very same site
// (the host itself or its "www." twin, same port), and the new path must still be one
// robots.txt allows. That also covers "another source": any other host, whether it is a source
// that is blocked, one that is not switched on for fetching, or no source at all, is refused.

import type { RedirectRule } from "../http.ts";
import type { RecipeSource } from "../types.ts";
import { normalizeHost } from "../url.ts";
import type { RobotsRules } from "./robots.ts";

// `rules` is null when robots.txt itself is being fetched (there are no rules to ask yet).
export function siteHopRule(source: RecipeSource, rules: RobotsRules | null): RedirectRule {
  return (next, from) => {
    if (normalizeHost(next.hostname) !== source.host) return `${source.host} redirected to ${next.hostname}, which is a different site, so I did not follow it.`;
    if (next.port !== from.port) return `${source.host} redirected to a different port, so I did not follow it.`;
    if (rules && !rules.allows(next.pathname + next.search)) return `${source.host} redirected to ${next.pathname}, which its robots.txt does not allow, so I did not follow it.`;
    return null;
  };
}
