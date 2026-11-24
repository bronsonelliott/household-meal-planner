// A fake recipe website on this computer (loopback), with invented pages. The program is told
// the site is "recipes.example.com"; `fetch` here quietly redirects that name to the fake
// server, so the real address rules (no private addresses, redirect checks) still run on the
// name the program sees.

export const SITE_HOST = "recipes.example.com";

export interface SiteRequest {
  path: string; // path and query
  headers: Headers;
}

export type Route = string | { status?: number; body?: string | Uint8Array; headers?: Record<string, string> } | ((request: Request) => Response);

export interface FakeSite {
  requests: SiteRequest[];
  routes: Map<string, Route>;
  set(path: string, route: Route): void;
  remove(path: string): void;
  // How many times a path was asked for.
  count(path: string): number;
  fetch: typeof fetch;
  stop(): void;
}

export function startFakeSite(): FakeSite {
  const requests: SiteRequest[] = [];
  const routes = new Map<string, Route>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname + url.search, headers: request.headers });
      const route = routes.get(url.pathname + url.search) ?? routes.get(url.pathname);
      if (route === undefined) return new Response("not found", { status: 404 });
      if (typeof route === "function") return route(request);
      if (typeof route === "string") return new Response(route, { headers: { "content-type": "text/html" } });
      return new Response((route.body ?? "") as BodyInit, { status: route.status ?? 200, headers: route.headers ?? { "content-type": "text/html" } });
    },
  });
  return {
    requests,
    routes,
    set: (path, route) => void routes.set(path, route),
    remove: (path) => void routes.delete(path),
    count: (path) => requests.filter((request) => request.path === path || request.path.split("?")[0] === path).length,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname !== SITE_HOST) throw new Error(`the fake site only answers for ${SITE_HOST}, not ${url.hostname}`);
      return fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init);
    }) as typeof fetch,
    stop: () => void server.stop(true),
  };
}

// ---------------------------------------------------------------------------------------------
// Pages and files
// ---------------------------------------------------------------------------------------------

export const THREE_INGREDIENTS = ["1 lb chicken thighs", "2 tbsp olive oil", "1 tsp salt"];

// A recipe page whose recipe data is the given JSON-LD (an object or array, or raw text for a broken block).
export function pageWith(jsonLd: unknown, head = ""): string {
  const block = typeof jsonLd === "string" ? jsonLd : JSON.stringify(jsonLd);
  return `<!doctype html><html><head><title>x</title>${head}<script type="application/ld+json">${block}</script></head><body><h1>x</h1></body></html>`;
}

export function recipeJson(name: string, ingredients: string[] = THREE_INGREDIENTS, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name,
    recipeIngredient: ingredients,
    recipeInstructions: [{ "@type": "HowToStep", text: "Mix everything." }, { "@type": "HowToStep", text: "Cook it." }],
    ...extra,
  };
}

export const recipePage = (name: string, ingredients?: string[], extra?: Record<string, unknown>, head?: string): string => pageWith(recipeJson(name, ingredients, extra), head);

export function sitemapXml(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
}

export function sitemapIndexXml(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;
}

export const at = (path: string): string => `https://${SITE_HOST}${path}`;
