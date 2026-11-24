// The polite web client: its manners (spacing, size and time limits, backing off) and its address
// rule (nothing private unless it is a server named in config.toml). Most tests use a fake
// `fetch`; the loopback ones use a real server on this computer.

import { describe, expect, test } from "bun:test";
import { HttpError, isNonPublicAddress, PoliteClient, type PoliteClientOptions } from "../src/recipes/http.ts";
import { startFakeMealDb } from "./fixtures/fake-recipe-apis.ts";

const PUBLIC = async () => ["93.184.216.34"];

// A fake fetch that records what it was asked and answers from a script.
function scripted(answers: Array<Response | ((url: string, init: RequestInit) => Response)>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return typeof next === "function" ? next(url, init) : next.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(options: Partial<PoliteClientOptions> & { fetch: typeof fetch }): PoliteClient {
  return new PoliteClient({ userAgent: "test-agent/1.0", spacingMs: 0, resolve: PUBLIC, sleep: async () => {}, ...options });
}

const ok = (body = "{}") => new Response(body, { status: 200 });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected the client to refuse");
}

describe("the address rule", () => {
  test("a table of addresses: private, loopback, link-local and friends are non-public", () => {
    const refused = ["127.0.0.1", "127.9.9.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "2001:db8::1"];
    for (const address of refused) expect(isNonPublicAddress(address)).toBe(true);
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isNonPublicAddress(address)).toBe(false);
  });

  test("an address typed as a private IP is refused and never fetched", async () => {
    const { fetchImpl, calls } = scripted([ok()]);
    const http = client({ fetch: fetchImpl });
    for (const url of ["http://127.0.0.1/", "http://10.0.0.5:8080/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://192.168.1.20/"]) {
      expect((await refusal(http.get(url))).kind).toBe("blocked-address");
    }
    expect(calls).toEqual([]);
  });

  test("a name that resolves to a private address is refused, even when another answer is public", async () => {
    const { fetchImpl, calls } = scripted([ok()]);
    const privateOnly = client({ fetch: fetchImpl, resolve: async () => ["10.0.0.5"] });
    expect((await refusal(privateOnly.get("https://recipes.example.org/"))).kind).toBe("blocked-address");
    const mixed = client({ fetch: fetchImpl, resolve: async () => ["93.184.216.34", "192.168.0.9"] });
    expect((await refusal(mixed.get("https://recipes.example.org/"))).kind).toBe("blocked-address");
    expect(calls).toEqual([]);
    const fine = client({ fetch: fetchImpl });
    expect((await fine.get("https://recipes.example.org/")).status).toBe(200);
  });

  test("a server named in config.toml may be private, but only that host and port", async () => {
    const { fetchImpl, calls } = scripted([ok()]);
    const http = client({ fetch: fetchImpl, privateHosts: ["192.168.1.20:9000", "http://mealie.lan"], resolve: async () => ["192.168.1.20"] });
    expect((await http.get("http://192.168.1.20:9000/api/app/about")).status).toBe(200);
    expect((await http.get("http://mealie.lan/api/app/about")).status).toBe(200);
    expect((await refusal(http.get("http://192.168.1.20:9001/"))).kind).toBe("blocked-address"); // other port
    expect((await refusal(http.get("http://192.168.1.21:9000/"))).kind).toBe("blocked-address"); // other machine
    expect(calls.length).toBe(2);
  });

  test("a redirect to a private address is refused, even from a configured server", async () => {
    const { fetchImpl, calls } = scripted([redirect("http://169.254.169.254/latest/meta-data"), ok()]);
    const http = client({ fetch: fetchImpl, privateHosts: ["192.168.1.20:9000"] });
    expect((await refusal(http.get("http://192.168.1.20:9000/api/recipes"))).kind).toBe("blocked-address");
    expect(calls.map((call) => call.url)).toEqual(["http://192.168.1.20:9000/api/recipes"]);
  });

  test("a public site that redirects to a name resolving privately is refused on that hop", async () => {
    const { fetchImpl } = scripted([redirect("https://internal.example.org/x"), ok()]);
    const http = client({ fetch: fetchImpl, resolve: async (host) => (host === "internal.example.org" ? ["10.0.0.7"] : ["93.184.216.34"]) });
    expect((await refusal(http.get("https://recipes.example.org/"))).kind).toBe("blocked-address");
  });

  test("web addresses with a user name or password, or not http(s), are refused", async () => {
    const { fetchImpl, calls } = scripted([ok()]);
    const http = client({ fetch: fetchImpl });
    for (const url of ["https://user:secret@recipes.example.org/", "https://user@recipes.example.org/", "ftp://recipes.example.org/", "file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      expect((await refusal(http.get(url))).kind).toBe("bad-address");
    }
    // A redirect cannot smuggle credentials in either.
    const sneaky = scripted([redirect("https://u:p@recipes.example.org/")]);
    expect((await refusal(client({ fetch: sneaky.fetchImpl }).get("https://recipes.example.org/"))).kind).toBe("bad-address");
    expect(calls).toEqual([]);
  });

  test("the test-only loopback allowance reaches a fake server on this computer, and nothing else", async () => {
    const fake = startFakeMealDb();
    try {
      const blocked = new PoliteClient({ userAgent: "t", spacingMs: 0 });
      expect((await refusal(blocked.get(fake.baseUrl + "categories.php"))).kind).toBe("blocked-address");
      const allowed = new PoliteClient({ userAgent: "t", spacingMs: 0, allowLoopbackForTests: true });
      const answer = await allowed.get(fake.baseUrl + "categories.php");
      expect(answer.status).toBe(200);
      expect(fake.requests.length).toBe(1);
      expect((await refusal(allowed.get("http://10.0.0.1/"))).kind).toBe("blocked-address"); // still not a general bypass
    } finally {
      fake.stop();
    }
  });
});

describe("private servers are exact endpoints", () => {
  test("an address with no port allows its scheme's usual port only, never another port", async () => {
    const { fetchImpl, calls } = scripted([ok()]);
    const http = client({ fetch: fetchImpl, privateHosts: ["http://192.168.1.10"], resolve: async () => ["192.168.1.10"] });
    expect((await http.get("http://192.168.1.10/api")).status).toBe(200);
    expect((await http.get("http://192.168.1.10:80/api")).status).toBe(200);
    expect((await refusal(http.get("http://192.168.1.10:8080/api"))).kind).toBe("blocked-address");
    expect((await refusal(http.get("https://192.168.1.10/api"))).kind).toBe("blocked-address"); // 443 was not named
    expect(calls.length).toBe(2);
  });

  test("an https address means port 443, and host:port entries match that port exactly", async () => {
    const { fetchImpl } = scripted([ok()]);
    const http = client({ fetch: fetchImpl, privateHosts: ["https://nas.lan", "nas.lan:9000"], resolve: async () => ["192.168.1.30"] });
    expect((await http.get("https://nas.lan:443/")).status).toBe(200);
    expect((await http.get("http://nas.lan:9000/")).status).toBe(200);
    expect((await refusal(http.get("http://nas.lan/"))).kind).toBe("blocked-address"); // port 80
    expect((await refusal(http.get("https://nas.lan:8443/"))).kind).toBe("blocked-address");
  });

  test("a bare host name with no port is a configuration mistake, not a wide exception", () => {
    expect(() => client({ fetch: scripted([ok()]).fetchImpl, privateHosts: ["mealie.lan"] })).toThrow();
  });
});

describe("redirects", () => {
  test("a login header follows a redirect on the same host but is dropped when it leaves", async () => {
    const same = scripted([redirect("/moved"), ok()]);
    await client({ fetch: same.fetchImpl }).get("https://recipes.example.org/a", { authorization: "Bearer abc" });
    expect(same.calls[1]!.url).toBe("https://recipes.example.org/moved");
    expect(same.calls[1]!.headers.authorization).toBe("Bearer abc");

    const leaving = scripted([redirect("https://other.example.net/b"), ok()]);
    await client({ fetch: leaving.fetchImpl }).get("https://recipes.example.org/a", { authorization: "Bearer abc" });
    expect(leaving.calls[1]!.headers.authorization).toBeUndefined();
    expect(leaving.calls[1]!.headers["user-agent"]).toBe("test-agent/1.0");
  });

  test("a redirect from https to plain http is refused, and the http address is never requested", async () => {
    const { fetchImpl, calls } = scripted([redirect("http://recipes.example.org/plain"), ok()]);
    const error = await refusal(client({ fetch: fetchImpl }).get("https://recipes.example.org/a", { authorization: "Bearer abc" }));
    expect(error.kind).toBe("redirect-refused");
    expect(calls.map((call) => call.url)).toEqual(["https://recipes.example.org/a"]);
  });

  test("the login header is kept only while scheme, host and port are all the same", async () => {
    const otherPort = scripted([redirect("https://recipes.example.org:8443/b"), ok()]);
    await client({ fetch: otherPort.fetchImpl }).get("https://recipes.example.org/a", { authorization: "Bearer abc" });
    expect(otherPort.calls[1]!.headers.authorization).toBeUndefined();

    const upgrade = scripted([redirect("https://recipes.example.org/b"), ok()]); // http -> https on the same host
    await client({ fetch: upgrade.fetchImpl }).get("http://recipes.example.org/a", { authorization: "Bearer abc" });
    expect(upgrade.calls[1]!.headers.authorization).toBeUndefined();

    const same = scripted([redirect("https://recipes.example.org:443/b"), ok()]);
    await client({ fetch: same.fetchImpl }).get("https://recipes.example.org/a", { authorization: "Bearer abc" });
    expect(same.calls[1]!.headers.authorization).toBe("Bearer abc");
  });

  test("a caller's redirect rule is asked before the next request, and a refusal means no request", async () => {
    const { fetchImpl, calls } = scripted([redirect("https://elsewhere.example.net/x"), ok()]);
    const asked: string[] = [];
    const error = await refusal(
      client({ fetch: fetchImpl }).get("https://recipes.example.org/a", {}, { allowRedirect: (next) => (asked.push(next.href), "not that way") }),
    );
    expect(error.kind).toBe("redirect-refused");
    expect(error.message).toBe("not that way");
    expect(asked).toEqual(["https://elsewhere.example.net/x"]);
    expect(calls.length).toBe(1);
  });

  test("it gives up after too many redirects", async () => {
    const { fetchImpl, calls } = scripted([redirect("/again")]);
    const error = await refusal(client({ fetch: fetchImpl, maxRedirects: 3 }).get("https://recipes.example.org/"));
    expect(error.kind).toBe("too-many-redirects");
    expect(calls.length).toBe(4);
  });
});

describe("the address check runs right before each request", () => {
  test("a name that turns private while we wait for our turn is refused at request time", async () => {
    let answer = ["93.184.216.34"];
    let clock = 0;
    const { fetchImpl, calls } = scripted([ok()]);
    const http = client({
      fetch: fetchImpl,
      spacingMs: 5000,
      now: () => clock,
      resolve: async () => answer,
      // While we wait the name starts answering with a private address.
      sleep: async (ms) => {
        clock += ms;
        answer = ["10.0.0.5"];
      },
    });
    expect((await http.get("https://recipes.example.org/first")).status).toBe(200); // no wait: the first request goes at once
    const error = await refusal(http.get("https://recipes.example.org/second")); // waits 5 s, and the name changed meanwhile
    expect(error.kind).toBe("blocked-address");
    expect(calls.length).toBe(1);
  });

  test("it is checked again on every retry after a 429", async () => {
    let lookups = 0;
    let clock = 0;
    const { fetchImpl, calls } = scripted([new Response("slow down", { status: 429, headers: { "retry-after": "2" } }), ok()]);
    const http = client({
      fetch: fetchImpl,
      now: () => clock,
      resolve: async () => (++lookups === 1 ? ["93.184.216.34"] : ["192.168.0.9"]),
      sleep: async (ms) => void (clock += ms),
    });
    expect((await refusal(http.get("https://recipes.example.org/"))).kind).toBe("blocked-address");
    expect(lookups).toBe(2);
    expect(calls.length).toBe(1); // the retry was never sent
  });

  test("it is checked again on every redirect hop, after that hop's wait", async () => {
    const lookedUp: string[] = [];
    const { fetchImpl, calls } = scripted([redirect("https://other.example.net/b"), ok()]);
    const http = client({
      fetch: fetchImpl,
      resolve: async (host) => (lookedUp.push(host), host === "other.example.net" ? ["10.1.1.1"] : ["93.184.216.34"]),
    });
    expect((await refusal(http.get("https://recipes.example.org/a"))).kind).toBe("blocked-address");
    expect(lookedUp).toEqual(["recipes.example.org", "other.example.net"]);
    expect(calls.length).toBe(1);
  });
});

describe("manners", () => {
  test("it says who it is", async () => {
    const { fetchImpl, calls } = scripted([ok()]);
    await client({ fetch: fetchImpl }).get("https://recipes.example.org/");
    expect(calls[0]!.headers["user-agent"]).toBe("test-agent/1.0");
  });

  test("requests to one host are spaced; another host is not held up", async () => {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const { fetchImpl } = scripted([ok()]);
    const http = client({
      fetch: fetchImpl,
      spacingMs: 5000,
      hostSpacingMs: { "api.example.org": 1000 },
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await http.get("https://recipes.example.org/1");
    await http.get("https://recipes.example.org/2");
    await http.get("https://recipes.example.org/3");
    expect(sleeps).toEqual([5000, 5000]);
    await http.get("https://api.example.org/1"); // different host: no wait
    await http.get("https://api.example.org/2"); // its own, shorter, pause
    expect(sleeps).toEqual([5000, 5000, 1000]);
  });

  test("two requests started together line up instead of both going now", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const { fetchImpl } = scripted([ok()]);
    const http = client({ fetch: fetchImpl, spacingMs: 2000, now: () => clock, sleep: async (ms) => void sleeps.push(ms) });
    await Promise.all([http.get("https://recipes.example.org/1"), http.get("https://recipes.example.org/2"), http.get("https://recipes.example.org/3")]);
    expect(sleeps.sort((a, b) => a - b)).toEqual([2000, 4000]);
  });

  test("429 with Retry-After: waits as told, tries again, and a long wait is declined", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const options = { now: () => clock, sleep: async (ms: number) => void (sleeps.push(ms), (clock += ms)) };
    const busy = new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
    const retry = scripted([busy, ok("fine")]);
    const answer = await client({ fetch: retry.fetchImpl, ...options }).get("https://recipes.example.org/");
    expect(answer.text).toBe("fine");
    expect(retry.calls.length).toBe(2);
    expect(sleeps).toEqual([7000]);

    const long = scripted([new Response("", { status: 503, headers: { "retry-after": "3600" } })]);
    const error = await refusal(client({ fetch: long.fetchImpl, ...options }).get("https://recipes.example.org/"));
    expect(error.kind).toBe("told-to-wait");
    expect(long.calls.length).toBe(1);
  });

  test("a Retry-After given as a date is understood, and a stubborn 429 comes back as an answer after the retries", async () => {
    let clock = Date.parse("2026-11-24T12:00:00Z");
    const sleeps: number[] = [];
    const options = { now: () => clock, sleep: async (ms: number) => void (sleeps.push(ms), (clock += ms)) };
    const dated = scripted([new Response("", { status: 429, headers: { "retry-after": "Tue, 24 Nov 2026 12:00:09 GMT" } }), ok()]);
    await client({ fetch: dated.fetchImpl, ...options }).get("https://recipes.example.org/");
    expect(sleeps[0]).toBe(9000);

    const stubborn = scripted([new Response("", { status: 429, headers: { "retry-after": "1" } })]);
    const answer = await client({ fetch: stubborn.fetchImpl, maxRetries: 2, ...options }).get("https://recipes.example.org/");
    expect(answer.status).toBe(429);
    expect(stubborn.calls.length).toBe(3);
  });

  test("an answer over the size limit is not read, whether the size is declared or not", async () => {
    const declared = scripted([new Response("x", { status: 200, headers: { "content-length": "5000000" } })]);
    expect((await refusal(client({ fetch: declared.fetchImpl, maxBytes: 1000 }).get("https://recipes.example.org/"))).kind).toBe("too-large");

    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(400));
      },
    });
    const streamed = scripted([() => new Response(stream, { status: 200 })]);
    expect((await refusal(client({ fetch: streamed.fetchImpl, maxBytes: 1000 }).get("https://recipes.example.org/"))).kind).toBe("too-large");

    const small = scripted([ok("tiny")]);
    expect((await client({ fetch: small.fetchImpl, maxBytes: 1000 }).get("https://recipes.example.org/")).text).toBe("tiny");
  });

  test("a server that never answers times out", async () => {
    const hang = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const error = await refusal(client({ fetch: hang, timeoutMs: 30 }).get("https://recipes.example.org/"));
    expect(error.kind).toBe("timeout");
  });

  test("a secret that sits in an address is blanked out of error messages", async () => {
    const down = (async () => {
      throw new Error("connect failed for https://api.example.org/v1/SUPER-SECRET-KEY/list");
    }) as unknown as typeof fetch;
    const error = await refusal(client({ fetch: down, redact: ["SUPER-SECRET-KEY"] }).get("https://api.example.org/v1/SUPER-SECRET-KEY/list"));
    expect(error.message).not.toContain("SUPER-SECRET-KEY");
    expect(error.message).toContain("***");
  });
});
