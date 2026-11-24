// Fake TheMealDB, Mealie and Tandoor servers on this computer (loopback), with invented
// recipes. They record every request so a test can check what was asked, and with which login.

export interface SeenRequest {
  path: string;
  search: string;
  authorization: string | null;
  userAgent: string | null;
}

export interface FakeServer {
  url: string; // http://127.0.0.1:<port>
  host: string; // 127.0.0.1:<port>
  requests: SeenRequest[];
  stop(): void;
}

function serve(handler: (url: URL, request: Request) => Response | Promise<Response>): FakeServer {
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, search: url.search, authorization: request.headers.get("authorization"), userAgent: request.headers.get("user-agent") });
      return handler(url, request);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, host: `127.0.0.1:${server.port}`, requests, stop: () => void server.stop(true) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------------------------
// TheMealDB
// ---------------------------------------------------------------------------------------------

export interface MealFixture {
  id: string;
  name: string;
  category: string;
  area?: string;
  tags?: string;
  source?: string;
  instructions?: string;
  ingredients: Array<[measure: string, ingredient: string]>;
}

export function meal(id: string, name: string, category: string, ingredients: Array<[string, string]>, extra: Partial<MealFixture> = {}): MealFixture {
  return { id, name, category, ingredients, ...extra };
}

export const SAMPLE_MEALS: MealFixture[] = [
  meal("101", "Lemon Herb Chicken", "Chicken", [["2", "chicken thighs"], ["1 tbsp", "olive oil"], ["1", "lemon"]], { area: "Greek", tags: "Roast,Easy", instructions: "Heat the oven.\r\nRoast the chicken.\r\n\r\nServe." }),
  meal("102", "Pepper Beef Stew", "Beef", [["500g", "beef chuck"], ["2", "carrots"], ["1 cup", "stock"]], { area: "Irish", source: "https://recipes.example.org/pepper-beef-stew?utm_source=x" }),
  meal("103", "Garden Noodle Bowl", "Vegetarian", [["200g", "noodles"], ["1", "carrot"], ["", "soy sauce"]], { area: "Unknown" }),
  meal("104", "Baked Cod Parcels", "Seafood", [["2", "cod fillets"], ["1", "lemon"]]),
  meal("901", "Sticky Toffee Pudding", "Dessert", [["1 cup", "dates"]]),
  meal("902", "Pancake Stack", "Breakfast", [["1 cup", "flour"]]),
];

export interface FakeMealDbOptions {
  meals?: MealFixture[];
  key?: string; // the key the fake accepts in the address
  failLookups?: string[]; // meal ids whose lookup answers 500
}

export function startFakeMealDb(options: FakeMealDbOptions = {}): FakeServer & { baseUrl: string } {
  const meals = options.meals ?? SAMPLE_MEALS;
  const key = options.key ?? "1";
  const server = serve((url) => {
    const prefix = `/api/json/v1/${key}/`;
    if (!url.pathname.startsWith(prefix)) return json({ error: "bad key" }, 401);
    const endpoint = url.pathname.slice(prefix.length);
    if (endpoint === "categories.php") return json({ categories: [{ strCategory: "Beef" }] });
    if (endpoint === "list.php") return json({ meals: [...new Set(meals.map((m) => m.category))].map((strCategory) => ({ strCategory })) });
    if (endpoint === "filter.php") {
      const wanted = meals.filter((m) => m.category === url.searchParams.get("c"));
      return json({ meals: wanted.length === 0 ? null : wanted.map((m) => ({ strMeal: m.name, idMeal: m.id })) });
    }
    if (endpoint === "lookup.php") {
      const id = url.searchParams.get("i") ?? "";
      if (options.failLookups?.includes(id)) return json({ error: "boom" }, 500);
      const found = meals.find((m) => m.id === id);
      return json({ meals: found ? [mealDbRow(found)] : null });
    }
    return json({ error: "unknown" }, 404);
  });
  return { ...server, baseUrl: `${server.url}/api/json/v1/${key}/` };
}

function mealDbRow(m: MealFixture): Record<string, unknown> {
  const row: Record<string, unknown> = {
    idMeal: m.id,
    strMeal: m.name,
    strCategory: m.category,
    strArea: m.area ?? "Unknown",
    strInstructions: m.instructions ?? "Cook it.",
    strTags: m.tags ?? null,
    strSource: m.source ?? "",
  };
  for (let n = 1; n <= 20; n++) {
    const entry = m.ingredients[n - 1];
    row[`strIngredient${n}`] = entry ? entry[1] : n % 2 === 0 ? "" : null;
    row[`strMeasure${n}`] = entry ? entry[0] : n % 2 === 0 ? " " : null;
  }
  return row;
}

// ---------------------------------------------------------------------------------------------
// Mealie
// ---------------------------------------------------------------------------------------------

export const MEALIE_TOKEN = "mealie-test-token-DO-NOT-LOG";

export interface FakeMealieOptions {
  count?: number; // recipes, named recipe-1 .. recipe-N
  token?: string;
  failDetails?: string[]; // slugs whose detail answers 500
  groupSlug?: string; // when set, details carry it
  overrides?: Record<string, Record<string, unknown>>;
}

export function startFakeMealie(options: FakeMealieOptions = {}): FakeServer {
  const count = options.count ?? 3;
  const token = options.token ?? MEALIE_TOKEN;
  return serve((url, request) => {
    if (url.pathname === "/api/app/about") return json({ version: "v2.0.0" });
    if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ detail: "Unauthorized" }, 401);
    if (url.pathname === "/api/recipes") {
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("perPage"));
      const all = Array.from({ length: count }, (_, i) => ({ id: `id-${i + 1}`, slug: `recipe-${i + 1}`, name: `Recipe ${i + 1}` }));
      return json({ page, per_page: perPage, total: count, total_pages: Math.ceil(count / perPage), items: all.slice((page - 1) * perPage, page * perPage) });
    }
    const slug = url.pathname.replace("/api/recipes/", "");
    if (options.failDetails?.includes(slug)) return json({ detail: "boom" }, 500);
    const n = Number(slug.replace("recipe-", ""));
    if (!Number.isInteger(n) || n < 1 || n > count) return json({ detail: "not found" }, 404);
    return json({
      id: `id-${n}`,
      slug,
      name: `Recipe ${n}`,
      ...(options.groupSlug ? { groupSlug: options.groupSlug } : {}),
      recipeIngredient: [{ display: "1 cup rice", note: "" }, { display: "", originalText: "2 chicken thighs" }, { display: "", originalText: "", note: "" }],
      recipeInstructions: [{ title: "", text: "Boil the rice." }, { title: "", text: "  " }, { title: "", text: "Serve." }],
      recipeCategory: [{ name: "Dinner" }],
      tags: [{ name: "quick" }, { name: "Dinner" }],
      ...(options.overrides?.[slug] ?? {}),
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Tandoor
// ---------------------------------------------------------------------------------------------

export const TANDOOR_TOKEN = "tandoor-test-token-DO-NOT-LOG";

export interface FakeTandoorOptions {
  count?: number;
  token?: string;
  failDetails?: string[]; // recipe ids whose detail answers 500
}

export function startFakeTandoor(options: FakeTandoorOptions = {}): FakeServer {
  const count = options.count ?? 3;
  const token = options.token ?? TANDOOR_TOKEN;
  return serve((url, request) => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return json({ detail: "Authentication credentials were not provided." }, 401);
    if (url.pathname === "/api/recipe/") {
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("page_size"));
      const all = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Dish ${i + 1}` }));
      const results = all.slice((page - 1) * size, page * size);
      return json({ count, next: page * size < count ? `http://elsewhere.invalid/api/recipe/?page=${page + 1}` : null, previous: null, results });
    }
    const id = url.pathname.replace("/api/recipe/", "").replace("/", "");
    if (options.failDetails?.includes(id)) return json({ detail: "boom" }, 500);
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1 || n > count) return json({ detail: "not found" }, 404);
    return json({
      id: n,
      name: `Dish ${n}`,
      keywords: [{ id: 1, name: "weeknight", label: "weeknight" }],
      steps: [
        {
          instruction: "Brown the beef.",
          ingredients: [
            { amount: 1.5, unit: { name: "lb" }, food: { name: "ground beef" }, note: "" },
            { amount: 0, unit: null, food: { name: "salt" }, note: "to taste", no_amount: true },
            { is_header: true, amount: 0, unit: null, food: { name: "For the sauce" }, note: "" },
          ],
        },
        { instruction: "Simmer.", ingredients: [{ amount: 2, unit: null, food: { name: "tomatoes" }, note: "chopped" }] },
      ],
    });
  });
}
