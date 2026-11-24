// A polite web client for everything the recipe code asks of the outside world (the recipe APIs
// and, for sites an admin has switched on, robots.txt, sitemaps and recipe pages).
//
// What it promises:
//   - it names itself (User-Agent from config) so a site owner can see who is asking
//   - one request at a time per host, with a pause between requests to the same host
//   - a time limit per request and a size limit per answer
//   - when a site says "slow down" (429 or 503), it waits as long as the site asks, then tries
//     again a couple of times, and gives up if the wait is unreasonable
//   - http and https only, and never a web address with a user name or password in it
//   - it refuses addresses that point at this computer or this network (see below)
//   - redirects are followed a few times at most, and every hop is checked again; a redirect from
//     https to plain http is refused (it would send the page, and any login token, in the open),
//     and a login token only travels while the address keeps the same scheme, host and port
//   - a caller may add its own rule for redirects (`allowRedirect`), asked before the next
//     request is made
//
// THE ADDRESS RULE (a defence against being tricked into reading something on the home
// network): after a host name is turned into IP addresses, none of them may be private, loopback
// or link-local. The one exception is a host you named yourself in config.toml as your
// own Mealie or Tandoor server, which often lives on the home network. That exception is exact:
// it covers that host AND port only (an address with no port means 80 for http and 443 for
// https), not "the whole home network" and not the same machine's other ports. A redirect from
// your server to some other private address is still refused.
//
// A KNOWN GAP (DNS rebinding): the name is looked up for the check and looked up again by the
// built-in fetch when it connects, and fetch offers no way to say "connect to exactly the address
// you checked" while still verifying the site's TLS certificate for its name. So a hostile DNS
// server could give a public answer to the check and a private one to the connection. What we do
// instead: the check runs immediately before every single request attempt (after any politeness
// wait, again on every retry and every redirect hop), which shrinks the window to the moment
// between check and connect, but does not close it. This matters only for page fetching, which
// is off by default, is switched on per site by an admin, and is meant for well-known public
// recipe sites. The API providers talk to hosts named in config.toml.
//
// Tests give the client a fake `fetch`, a fake name lookup, a fake clock and sleep. A test that
// talks to a fake server on this computer must say so with `allowLoopbackForTests`; it is named
// that way so nobody turns it on for real use.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { blankOut } from "../secrets.ts";

export type HttpErrorKind = "bad-address" | "blocked-address" | "timeout" | "too-large" | "network" | "too-many-redirects" | "told-to-wait" | "redirect-refused";

export class HttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpResponse {
  status: number;
  text: string;
  bytes: Uint8Array; // the same answer, undecoded (a compressed sitemap needs this)
  finalUrl: string;
  headers: Headers;
}

// Asked before each redirect is followed, with the address it points to and the one it came
// from. Return null to follow it, or a sentence in plain words to refuse it (no request is made).
export type RedirectRule = (next: URL, from: URL) => string | null | Promise<string | null>;

export interface GetOptions {
  allowRedirect?: RedirectRule;
}

export interface PoliteClientOptions {
  userAgent: string;
  // The pause between two requests to the same host, in milliseconds.
  spacingMs: number;
  // Pauses for particular hosts ("host" or "host:port"), for example a faster one for an API.
  hostSpacingMs?: Record<string, number>;
  // Self-hosted servers the household named in config.toml, each as an exact endpoint: a web
  // address ("http://192.168.1.10:9000") or "host:port". An address with no port means the
  // scheme's usual one (80 or 443). Only these host-and-port pairs may be on a private address.
  privateHosts?: string[];
  timeoutMs?: number; // default 15 seconds
  maxBytes?: number; // default 2 MB
  maxRedirects?: number; // default 4
  maxRetries?: number; // default 2 (after a 429 or 503)
  maxWaitMs?: number; // the longest "please wait" we accept, default 60 seconds
  // Text to blank out of error messages, such as an API key that sits inside the address.
  redact?: string[];
  fetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Tests only: allow 127.0.0.1 and ::1 so a fake server on this computer can be reached.
  allowLoopbackForTests?: boolean;
}

const DEFAULTS = { timeoutMs: 15_000, maxBytes: 2_000_000, maxRedirects: 4, maxRetries: 2, maxWaitMs: 60_000 };

export class PoliteClient {
  private readonly nextFreeAt = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly resolve: (hostname: string) => Promise<string[]>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly privateHosts: Set<string>;
  private readonly limits: typeof DEFAULTS;

  constructor(private readonly options: PoliteClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.resolve = options.resolve ?? resolveAll;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.now = options.now ?? Date.now;
    this.privateHosts = new Set((options.privateHosts ?? []).map(endpointOfEntry));
    this.limits = {
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
      maxRedirects: options.maxRedirects ?? DEFAULTS.maxRedirects,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      maxWaitMs: options.maxWaitMs ?? DEFAULTS.maxWaitMs,
    };
  }

  // Fetches one page. Any answer the server gives (even 404 or 401) comes back as a response;
  // only a refusal by our own rules, a timeout, or a network failure throws.
  async get(rawUrl: string, headers: Record<string, string> = {}, options: GetOptions = {}): Promise<HttpResponse> {
    let url = this.parse(rawUrl);
    let sendHeaders = { ...headers };

    for (let hop = 0; ; hop++) {
      const response = await this.requestWithRetries(url, sendHeaders);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        if (hop >= this.limits.maxRedirects) throw new HttpError("too-many-redirects", `${this.describe(url)} sent me around in circles (more than ${this.limits.maxRedirects} redirects).`);
        const next = this.parse(new URL(location, url).toString());
        if (url.protocol === "https:" && next.protocol === "http:") {
          throw new HttpError("redirect-refused", `${this.describe(url)} tried to send me from https to plain http (${this.describe(next)}), so I stopped.`);
        }
        const refusal = options.allowRedirect ? await options.allowRedirect(next, url) : null;
        if (refusal !== null) throw new HttpError("redirect-refused", refusal);
        // A login token is for the exact place it was given to (scheme, host and port), not for
        // wherever it points us next.
        if (next.origin !== url.origin) sendHeaders = withoutAuthorization(sendHeaders);
        url = next;
        continue;
      }
      const bytes = await this.readBody(response, url);
      return { status: response.status, text: new TextDecoder().decode(bytes), bytes, finalUrl: url.toString(), headers: response.headers };
    }
  }

  // Checks the address itself: only http(s), no sign-in details inside it.
  private parse(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError("bad-address", `That is not a web address: ${this.clean(raw).slice(0, 80)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError("bad-address", `Only http and https addresses are allowed (${this.describe(url)}).`);
    if (url.username !== "" || url.password !== "") throw new HttpError("bad-address", "Web addresses with a user name or password in them are not allowed.");
    return url;
  }

  // One request, repeated after a 429 or 503 as the site asks.
  private async requestWithRetries(url: URL, headers: Record<string, string>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForTurn(url);
      // The address check comes AFTER the wait and straight before the request, so a name that
      // changes its answer while we were waiting is caught (see "DNS rebinding" at the top).
      await this.checkWhereItPoints(url);
      const response = await this.requestOnce(url, headers);
      if ((response.status !== 429 && response.status !== 503) || attempt >= this.limits.maxRetries) return response;

      const asked = retryAfterMs(response.headers.get("retry-after"), this.now());
      const waitMs = asked ?? 2000 * 2 ** attempt;
      await response.body?.cancel().catch(() => {});
      if (waitMs > this.limits.maxWaitMs) {
        throw new HttpError("told-to-wait", `${url.host} asked me to wait ${Math.ceil(waitMs / 1000)} seconds, which is too long, so I stopped. I will try again later.`);
      }
      this.nextFreeAt.set(url.host, Math.max(this.nextFreeAt.get(url.host) ?? 0, this.now() + waitMs));
    }
  }

  private async requestOnce(url: URL, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual", // we follow redirects ourselves so each hop is checked
        headers: { "user-agent": this.options.userAgent, accept: "application/json, text/html;q=0.8, */*;q=0.5", ...headers },
        signal: AbortSignal.timeout(this.limits.timeoutMs),
      });
    } catch (error) {
      throw this.networkError(error, url);
    }
  }

  // Reads the answer, stopping the moment it grows past the limit.
  private async readBody(response: Response, url: URL): Promise<Uint8Array> {
    const limit = this.limits.maxBytes;
    const tooLarge = () => new HttpError("too-large", `The answer from ${this.describe(url)} is larger than ${Math.round(limit / 1000)} KB, so I did not read it.`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw this.networkError(error, url);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  // The address rule described at the top of this file.
  private async checkWhereItPoints(url: URL): Promise<void> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const yours = this.privateHosts.has(endpointOf(url));
    let addresses: string[];
    if (isIP(hostname)) {
      addresses = [hostname];
    } else {
      try {
        addresses = await this.resolve(hostname);
      } catch {
        throw new HttpError("network", `I could not find ${hostname} (the name did not resolve).`);
      }
    }
    if (addresses.length === 0) throw new HttpError("network", `I could not find ${hostname} (the name did not resolve).`);
    for (const address of addresses) {
      if (!isNonPublicAddress(address)) continue;
      if (yours) continue; // a server the household named in config.toml
      if (this.options.allowLoopbackForTests && isLoopback(address)) continue;
      throw new HttpError("blocked-address", `I will not open ${this.describe(url)}: it points at a private or internal address, and it is not a server named in config.toml.`);
    }
  }

  // Waits until this host's turn comes. The turn is reserved first, so two callers at once
  // line up instead of both going now.
  private async waitForTurn(url: URL): Promise<void> {
    const spacing = this.options.hostSpacingMs?.[url.host] ?? this.options.hostSpacingMs?.[url.hostname] ?? this.options.spacingMs;
    const now = this.now();
    const at = Math.max(now, this.nextFreeAt.get(url.host) ?? 0);
    this.nextFreeAt.set(url.host, at + spacing);
    if (at > now) await this.sleep(at - now);
  }

  private networkError(error: unknown, url: URL): HttpError {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return new HttpError("timeout", `${this.describe(url)} took longer than ${Math.round(this.limits.timeoutMs / 1000)} seconds to answer.`);
    }
    return new HttpError("network", `I could not reach ${this.describe(url)} (${this.clean(error instanceof Error ? error.message : String(error)).slice(0, 120)}).`);
  }

  // Where, without the query part and with secrets blanked, for messages and logs.
  private describe(url: URL): string {
    return this.clean(`${url.origin}${url.pathname}`);
  }

  private clean(text: string): string {
    return blankOut(text, this.options.redact ?? []);
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

// "host:port" with the port made explicit, so "http://nas.lan" and "http://nas.lan:80" are the same
// endpoint and "http://nas.lan:8080" is not.
function endpointOf(url: URL): string {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
  return `${hostname}:${port}`;
}

// A config entry as an endpoint: a web address, or "host:port". Anything else (a bare host
// name with no port, for instance) is a mistake and is refused here rather than guessed at.
function endpointOfEntry(entry: string): string {
  const text = entry.trim();
  if (/^https?:\/\//i.test(text)) return endpointOf(new URL(text));
  const match = text.match(/^(\[[0-9a-f:.]+\]|[^:/\s]+):(\d{1,5})$/i);
  if (!match) throw new Error(`A private server must be written as a web address or host:port, not "${entry}".`);
  return `${match[1]!.replace(/^\[|\]$/g, "").toLowerCase()}:${Number(match[2])}`;
}

function withoutAuthorization(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"));
}

// "Retry-After" is either a number of seconds or a date. Null when absent or unreadable.
function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

async function resolveAll(hostname: string): Promise<string[]> {
  const found = await lookup(hostname, { all: true });
  return found.map((entry) => entry.address);
}

export function isLoopback(address: string): boolean {
  const v4 = embeddedV4(address);
  if (v4 !== null) return v4.startsWith("127.");
  return address.toLowerCase() === "::1";
}

// True for any address that is not an ordinary public one: private, loopback, link-local,
// unspecified, shared (carrier-grade NAT), multicast, reserved, and IPv6 look-alikes of those.
export function isNonPublicAddress(address: string): boolean {
  const v4 = embeddedV4(address);
  if (v4 !== null) return isNonPublicV4(v4);
  const lower = address.toLowerCase();
  if (isIP(lower) !== 6) return true; // not an address at all: refuse
  if (lower === "::" || lower === "::1") return true;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return true; // documentation
  return false;
}

// A plain IPv4 address, or the IPv4 inside an IPv6 wrapper such as ::ffff:127.0.0.1. Null for
// a real IPv6 address.
function embeddedV4(address: string): string | null {
  if (isIP(address) === 4) return address;
  const lower = address.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1]!;
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

function isNonPublicV4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number) as [number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
  if (a === 169 && b === 254) return true; // link-local, including cloud metadata servers
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}
