import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SPOONACULAR_API_KEY;
const SPOON = "https://api.spoonacular.com";

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

// Lets the frontend know whether a key is set (to show a friendly banner).
app.get("/api/config", (req, res) => {
  res.json({ hasKey: Boolean(API_KEY && API_KEY !== "your_key_here") });
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
  const cacheKey = `search:${type}:${query}:${diet}:${glutenFree}:${under500}:${number}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const params = {
      query,
      number,
      addRecipeNutrition: "true", // Per-serving nutrition for every result.
      instructionsRequired: "true",
      sort: query ? "popularity" : "random",
    };
    if (type) params.type = type; // e.g. "salad", "soup", "appetizer", "main course"
    if (diet) params.diet = diet;
    if (glutenFree) params.intolerances = "gluten"; // Optional celiac filter.
    if (under500) params.maxCalories = 500; // Calories per serving.
    const data = await spoonFetch("/recipes/complexSearch", params);
    const results = (data.results || []).map((r) => ({
      id: r.id,
      title: r.title,
      image: r.image,
      readyInMinutes: r.readyInMinutes,
      servings: r.servings,
      calories: nutrient(r.nutrition, "Calories"),
      glutenFree: r.glutenFree,
    }));
    const payload = { results };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
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
    res.status(e.status || 500).json({ error: e.message });
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
    ingredients: (r.extendedIngredients || []).map((i) => ({
      name: i.nameClean || i.name,
      amount: i.amount,
      unit: i.unit,
      aisle: (i.aisle || "Other").split(";")[0].trim() || "Other",
      original: i.original,
    })),
  };
}

app.listen(PORT, () => {
  console.log(`\n  🍽  At-Home Meal Planner running at http://localhost:${PORT}\n`);
  if (!API_KEY || API_KEY === "your_key_here") {
    console.log("  ⚠  No API key yet. Add SPOONACULAR_API_KEY to a .env file, then restart.\n");
  }
});
