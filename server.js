import express from "express";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SPOONACULAR_API_KEY;
const SPOON = "https://api.spoonacular.com";

// Optional shared storage (Upstash Redis REST) so the plan + favorites sync
// across devices. If these env vars aren't set, the app falls back to
// per-device localStorage and everything still works.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const storageEnabled = Boolean(REDIS_URL && REDIS_TOKEN);

async function redisCmd(command) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Redis ${r.status}`);
  return (await r.json()).result;
}
async function redisGetJSON(key) {
  const v = await redisCmd(["GET", key]);
  if (v == null) return null;
  try {
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch {
    return null;
  }
}
async function redisSetJSON(key, obj) {
  await redisCmd(["SET", key, JSON.stringify(obj)]);
}

// Spoonacular tags recipes with many overlapping dishTypes, so type=X alone
// leaks (salads into entrees, etc.). We post-filter results: keep a recipe only
// if its dishTypes hit an "include" tag and none of the "exclude" tags.
const CATEGORY_FILTERS = {
  salad: { include: ["salad"], exclude: [] },
  soup: { include: ["soup"], exclude: [] },
  appetizer: {
    include: ["appetizer", "starter", "fingerfood", "antipasti", "antipasto", "hor d'oeuvre", "snack"],
    exclude: ["salad", "soup", "main course", "main dish"],
  },
  "main course": {
    include: ["main course", "main dish"],
    exclude: ["salad", "soup", "appetizer", "starter", "dessert"],
  },
};

app.use(express.json());
// "no-cache" = browsers may store files but must revalidate (via ETag) each load,
// so updated CSS/JS always take effect after a deploy while unchanged files 304.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

// Tiny in-memory cache so repeated recipe lookups don't burn API quota.
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  cache.delete(key);
  return null;
}
function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
}

// A running pool of every recipe card we've successfully fetched. When the API
// is unavailable (e.g. daily quota hit), searches fall back to matching cards
// from here so the app still shows something useful instead of an error.
// It's persisted to disk and kept for 24h, so the home screen still has recipes
// after the server sleeps/restarts.
const recipePool = new Map();
const POOL_MAX = 500;
const POOL_TTL = 1000 * 60 * 60 * 24; // 24 hours
const POOL_FILE = path.join(__dirname, "pool-cache.json");

function addToPool(r) {
  recipePool.set(r.id, {
    id: r.id,
    title: r.title,
    image: r.image,
    readyInMinutes: r.readyInMinutes,
    servings: r.servings,
    calories: nutrient(r.nutrition, "Calories"),
    glutenFree: r.glutenFree,
    dishTypes: (r.dishTypes || []).map((s) => s.toLowerCase()),
    _t: Date.now(), // when we last saw it (for the 24h window)
  });
  if (recipePool.size > POOL_MAX) {
    recipePool.delete(recipePool.keys().next().value); // drop oldest
  }
  schedulePoolSave();
}

// Best-effort matches from the pool, honoring the same filters as a live search.
function fallbackFromPool({ type, query, glutenFree, under500, number }) {
  const rule = CATEGORY_FILTERS[type];
  const q = query.toLowerCase();
  const now = Date.now();
  let items = [...recipePool.values()].filter((r) => now - (r._t || 0) < POOL_TTL);
  if (glutenFree) items = items.filter((r) => r.glutenFree);
  if (under500) items = items.filter((r) => r.calories != null && r.calories <= 500);
  if (q) items = items.filter((r) => r.title.toLowerCase().includes(q));
  if (rule) {
    items = items.filter((r) => {
      const dt = r.dishTypes || [];
      return rule.include.some((t) => dt.includes(t)) && !rule.exclude.some((t) => dt.includes(t));
    });
  }
  return items.slice(0, number).map(({ dishTypes, _t, ...card }) => card);
}

// Load the saved pool on startup, dropping anything older than 24h.
function loadPoolFromDisk() {
  try {
    const arr = JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
    const now = Date.now();
    for (const r of arr) {
      if (r && r.id != null && now - (r._t || 0) < POOL_TTL) recipePool.set(r.id, r);
    }
    if (recipePool.size) console.log(`  Loaded ${recipePool.size} saved recipes (pool cache).`);
  } catch {
    /* no cache file yet — fine */
  }
}

// Persist the pool, debounced so bursts of adds write at most once every few seconds.
let poolSaveTimer = null;
function schedulePoolSave() {
  if (poolSaveTimer) return;
  poolSaveTimer = setTimeout(() => {
    poolSaveTimer = null;
    const now = Date.now();
    const fresh = [...recipePool.values()].filter((r) => now - (r._t || 0) < POOL_TTL);
    fs.writeFile(POOL_FILE, JSON.stringify(fresh), () => {});
  }, 3000);
}

// Turn raw upstream errors into friendly messages for the UI.
function friendlyError(e) {
  if (e.status === 402) {
    return "Daily recipe limit reached on the free Spoonacular plan. It resets once a day — please try again tomorrow.";
  }
  if (e.status === 401) {
    return "The Spoonacular API key was rejected. Double-check SPOONACULAR_API_KEY.";
  }
  return e.message || "Something went wrong fetching recipes.";
}

function requireKey(res) {
  if (!API_KEY || API_KEY === "your_key_here") {
    res.status(503).json({
      error:
        "No Spoonacular API key configured. Copy .env.example to .env and add your free key, then restart the server.",
    });
    return false;
  }
  return true;
}

async function spoonFetch(urlPath, params = {}) {
  const url = new URL(SPOON + urlPath);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apiKey", API_KEY);
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(`Spoonacular ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Lets the frontend know whether a key is set (to show a friendly banner)
// and whether cross-device sync storage is configured.
app.get("/api/config", (req, res) => {
  res.json({
    hasKey: Boolean(API_KEY && API_KEY !== "your_key_here"),
    storage: storageEnabled,
  });
});

// ---- Shared plan + favorites (one household, no accounts) ----
app.get("/api/plan", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, plan: (await redisGetJSON("meal:plan")) || {} });
  } catch {
    res.status(502).json({ error: "Could not read the shared plan." });
  }
});
app.put("/api/plan", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON("meal:plan", req.body?.plan || {});
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save the shared plan." });
  }
});
app.get("/api/favorites", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, favorites: (await redisGetJSON("meal:favorites")) || [] });
  } catch {
    res.status(502).json({ error: "Could not read favorites." });
  }
});
app.put("/api/favorites", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON("meal:favorites", req.body?.favorites || []);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save favorites." });
  }
});
app.get("/api/grocery", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, grocery: (await redisGetJSON("meal:grocery")) || {} });
  } catch {
    res.status(502).json({ error: "Could not read grocery state." });
  }
});
app.put("/api/grocery", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON("meal:grocery", req.body?.grocery || {});
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save grocery state." });
  }
});
app.get("/api/notes", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, notes: (await redisGetJSON("meal:notes")) || [] });
  } catch {
    res.status(502).json({ error: "Could not read notes." });
  }
});
app.put("/api/notes", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON("meal:notes", req.body?.notes || []);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save notes." });
  }
});
app.get("/api/tracker", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, tracker: (await redisGetJSON("meal:tracker")) || null });
  } catch {
    res.status(502).json({ error: "Could not read the tracker." });
  }
});
app.put("/api/tracker", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON("meal:tracker", req.body?.tracker || {});
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save the tracker." });
  }
});

// Search recipes by title/keyword, optionally within a dish-type category.
//   type=appetizer|soup|salad|main course -> category filter
//   gf=1     -> filter to gluten-free (default on in the UI, but optional)
//   under500 -> cap at 500 calories per serving
app.get("/api/search", async (req, res) => {
  if (!requireKey(res)) return;
  const query = (req.query.query || "").toString().trim();
  const number = Math.min(parseInt(req.query.number, 10) || 12, 24);
  const diet = (req.query.diet || "").toString().trim();
  const type = (req.query.type || "").toString().trim(); // dish-type category
  const glutenFree = ["1", "true", "yes"].includes(
    (req.query.gf || "").toString().toLowerCase()
  );
  const under500 = ["1", "true", "yes"].includes(
    (req.query.under500 || "").toString().toLowerCase()
  );
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0); // for "load more"
  const cacheKey = `search:${type}:${query}:${diet}:${glutenFree}:${under500}:${number}:${offset}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const rule = CATEGORY_FILTERS[type];
    // Over-fetch a little when we'll post-filter a category, so enough survive
    // — but keep it modest to conserve the daily API quota.
    const fetchNumber = rule ? Math.min(number + 6, 18) : number;
    const params = {
      query,
      number: fetchNumber,
      offset,
      addRecipeNutrition: "true", // Per-serving nutrition for every result.
      addRecipeInformation: "true", // Ensures dishTypes are present for filtering.
      instructionsRequired: "true",
      sort: "popularity", // stable order so "load more" (offset) paginates cleanly
    };
    if (type) params.type = type; // e.g. "salad", "soup", "appetizer", "main course"
    if (diet) params.diet = diet;
    if (glutenFree) params.intolerances = "gluten"; // Optional celiac filter.
    if (under500) params.maxCalories = 500; // Calories per serving.
    const data = await spoonFetch("/recipes/complexSearch", params);
    (data.results || []).forEach(addToPool); // remember these for offline fallback

    let items = data.results || [];
    if (rule) {
      items = items.filter((r) => {
        const dt = (r.dishTypes || []).map((s) => s.toLowerCase());
        const included = rule.include.some((t) => dt.includes(t));
        const excluded = rule.exclude.some((t) => dt.includes(t));
        return included && !excluded;
      });
    }

    const results = items.slice(0, number).map((r) => ({
      id: r.id,
      title: r.title,
      image: r.image,
      readyInMinutes: r.readyInMinutes,
      servings: r.servings,
      calories: nutrient(r.nutrition, "Calories"),
      glutenFree: r.glutenFree,
    }));
    const nextOffset = offset + fetchNumber;
    const hasMore = nextOffset < (data.totalResults || 0);
    const payload = { results, hasMore, nextOffset };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    // API unavailable (e.g. quota): on the first page, serve matching saved
    // recipes if we have any. "Load more" (offset > 0) has nothing more offline.
    if (offset === 0) {
      const fallback = fallbackFromPool({ type, query, glutenFree, under500, number });
      if (fallback.length) {
        return res.json({ results: fallback, stale: true, hasMore: false });
      }
    }
    res.status(e.status || 500).json({ error: friendlyError(e) });
  }
});

// Full details (with ingredients) for one or more recipe ids: /api/recipes?ids=1,2,3
app.get("/api/recipes", async (req, res) => {
  if (!requireKey(res)) return;
  const ids = (req.query.ids || "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return res.json({ recipes: [] });

  const missing = [];
  const recipes = {};
  for (const id of ids) {
    const c = cacheGet(`recipe:${id}`);
    if (c) recipes[id] = c;
    else missing.push(id);
  }

  try {
    if (missing.length) {
      const data = await spoonFetch("/recipes/informationBulk", {
        ids: missing.join(","),
        includeNutrition: "true",
      });
      for (const r of data) {
        const clean = normalizeRecipe(r);
        cacheSet(`recipe:${r.id}`, clean);
        recipes[r.id] = clean;
      }
    }
    // Preserve requested order.
    res.json({ recipes: ids.map((id) => recipes[id]).filter(Boolean) });
  } catch (e) {
    res.status(e.status || 500).json({ error: friendlyError(e) });
  }
});

function nutrient(nutrition, name) {
  const n = (nutrition?.nutrients || []).find((x) => x.name === name);
  return n ? Math.round(n.amount) : null;
}

function summarizeNutrition(nutrition) {
  if (!nutrition) return null;
  return {
    calories: nutrient(nutrition, "Calories"),
    protein: nutrient(nutrition, "Protein"),
    carbs: nutrient(nutrition, "Carbohydrates"),
    fat: nutrient(nutrition, "Fat"),
  };
}

function recipeSteps(r) {
  // Split a chunk into sentences, repairing run-ons where a period is jammed
  // against the next Capitalized word (a common flaw in the source data), e.g.
  // "Cut into cubes.Bring to a boil.Chop celery." -> three separate steps.
  const splitSentences = (chunk) =>
    (chunk || "")
      .replace(/<[^>]+>/g, " ") // strip HTML tags
      .replace(/\s+/g, " ") // collapse whitespace
      .replace(/\.(?=[A-Z])/g, ". ") // add the missing space after a crammed period
      .split(/(?<=\.)\s+/) // split on sentence boundaries, keeping the period
      .map((s) => s.trim())
      .filter((s) => s.length > 2);

  // Process each structured step individually so real step boundaries are kept.
  const analyzed = r.analyzedInstructions?.[0]?.steps;
  if (analyzed && analyzed.length) return analyzed.flatMap((s) => splitSentences(s.step));
  if (r.instructions) return splitSentences(r.instructions);
  return [];
}

function normalizeRecipe(r) {
  return {
    id: r.id,
    title: r.title,
    image: r.image,
    readyInMinutes: r.readyInMinutes,
    servings: r.servings,
    sourceUrl: r.sourceUrl,
    glutenFree: r.glutenFree,
    nutrition: summarizeNutrition(r.nutrition),
    steps: recipeSteps(r),
    ingredients: (r.extendedIngredients || []).map((i) => ({
      name: i.nameClean || i.name,
      amount: i.amount,
      unit: i.unit,
      aisle: (i.aisle || "Other").split(";")[0].trim() || "Other",
      original: i.original,
    })),
  };
}

loadPoolFromDisk();

app.listen(PORT, () => {
  console.log(`\n  🍽  At-Home Meal Planner running at http://localhost:${PORT}\n`);
  if (!API_KEY || API_KEY === "your_key_here") {
    console.log("  ⚠  No API key yet. Add SPOONACULAR_API_KEY to a .env file, then restart.\n");
  }
});
