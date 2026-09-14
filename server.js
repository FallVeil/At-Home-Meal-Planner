import express from "express";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SPOONACULAR_API_KEY;
const SPOON = "https://api.spoonacular.com";

// Optional Claude-powered recipe import (from a link or a screenshot). When
// ANTHROPIC_API_KEY isn't set the import endpoints return a friendly 503 and the
// UI hides the Import button — everything else works exactly the same.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const IMPORT_MODEL = "claude-haiku-4-5"; // cheap + plenty capable for structuring a recipe
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

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
// Bulk read several keys at once; returns parsed values (null where absent).
async function redisMGetJSON(keys) {
  if (!keys.length) return [];
  const vals = await redisCmd(["MGET", ...keys]);
  return (vals || []).map((v) => {
    if (v == null) return null;
    try {
      return typeof v === "string" ? JSON.parse(v) : v;
    } catch {
      return null;
    }
  });
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

// Common GERD / reflux trigger ingredients, excluded when the "Low-acid" filter
// is on. This is a heuristic (the recipe API has no acidity filter), so it can't
// catch every trigger and may hide some otherwise-fine recipes. Plain black
// pepper is intentionally omitted — excluding it would wipe out most savoury
// results — while the sharper chilli/hot varieties are kept out.
const LOW_ACID_EXCLUDE = [
  "tomato", "citrus", "orange", "lemon", "lime", "grapefruit",
  "coffee", "espresso", "chocolate", "cocoa",
  "onion", "garlic", "vinegar",
  "mint", "peppermint", "spearmint",
  "wine", "alcohol", "chili", "cayenne", "jalapeno", "hot sauce", "salsa",
  "ketchup", "mustard", "pineapple", "soda", "cola",
].join(",");

app.use(express.json({ limit: "6mb" })); // headroom for base64 recipe screenshots

// ---------------------------------------------------------------------------
//  Household passcode gate
//  One shared passcode (APP_PASSCODE) locks the whole app — pages AND every
//  /api route — behind a signed, HttpOnly session cookie. No DB needed. When
//  APP_PASSCODE isn't set the gate is OFF, so local/dev use still works; set it
//  in Render to turn protection on. APP_SESSION_SECRET is optional (a random
//  cookie-signing key); if absent it's derived from the passcode, so changing
//  the passcode also invalidates old sessions.
// ---------------------------------------------------------------------------
app.set("trust proxy", 1); // Render terminates TLS at its proxy; trust X-Forwarded-*
// Households: each passcode unlocks its own isolated data namespace.
//   HOUSEHOLDS="andrew-katie:pass1,smiths:pass2"  (id:passcode, comma-separated)
// Split on the FIRST ":" so a passcode may contain ":" — an id may not, and
// neither an id nor a passcode may contain ",". Back-compat: if HOUSEHOLDS is
// empty but the old APP_PASSCODE is set, treat that as the single legacy
// household so nothing changes until other families are actually added.
const LEGACY_HOUSEHOLD_ID = process.env.LEGACY_HOUSEHOLD_ID || "andrew-katie";
const LOCAL_HOUSEHOLD_ID = "local"; // used when auth is off (local/dev)
function parseHouseholds() {
  const map = new Map(); // passcode -> household id
  (process.env.HOUSEHOLDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const i = pair.indexOf(":");
      if (i <= 0) return;
      const id = pair.slice(0, i).trim();
      const pass = pair.slice(i + 1).trim();
      if (id && pass) map.set(pass, id);
    });
  if (!map.size && process.env.APP_PASSCODE) map.set(process.env.APP_PASSCODE, LEGACY_HOUSEHOLD_ID);
  return map;
}
const HOUSEHOLDS = parseHouseholds(); // passcode -> id
const AUTH_ON = HOUSEHOLDS.size > 0;
// One server-wide signing key for all household cookies. Set APP_SESSION_SECRET
// in Render so sessions survive roster edits; otherwise it's derived from the
// current passcode set (changing the roster then invalidates old sessions).
const AUTH_SECRET =
  process.env.APP_SESSION_SECRET ||
  crypto.createHash("sha256").update([...HOUSEHOLDS.keys()].sort().join("|") + "::homebase").digest("hex");
const AUTH_COOKIE = "hb_auth";
const AUTH_DAYS = 30;

// Cookie body = base64url(JSON{ h: householdId, exp }) so it carries identity,
// signed with HMAC. base64url avoids colliding with the "body.sig" separator.
function authToken(householdId) {
  const body = Buffer.from(JSON.stringify({ h: householdId, exp: Date.now() + AUTH_DAYS * 86400000 })).toString(
    "base64url"
  );
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("hex");
  return `${body}.${sig}`;
}
// Returns the household id for a valid, unexpired, untampered token — else null.
function authHousehold(tok) {
  if (!tok || !tok.includes(".")) return null;
  const [body, sig] = tok.split(".");
  const expect = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; // tamper check
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p || typeof p.h !== "string" || !(Number(p.exp) > Date.now())) return null; // expired/malformed
    return p.h;
  } catch {
    return null;
  }
}
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
// Reachable without a session: the login screen + assets, and the crawler files.
// Everything else (app shell + all /api data) needs a valid cookie.
const AUTH_PUBLIC = new Set(["/login", "/login.html", "/api/login", "/robots.txt", "/manifest.webmanifest"]);
const authPublic = (p) => AUTH_PUBLIC.has(p) || p.startsWith("/icons/");

// Ask crawlers not to index anything (defence-in-depth with robots.txt + auth).
app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

// Exchange a household passcode for a session cookie bound to that household.
app.post("/api/login", (req, res) => {
  if (!AUTH_ON) return res.json({ ok: true });
  const given = String(req.body?.passcode ?? "");
  const ga = Buffer.from(given);
  let matchedId = null;
  for (const [pass, id] of HOUSEHOLDS) {
    const pb = Buffer.from(pass);
    if (ga.length === pb.length && crypto.timingSafeEqual(ga, pb)) {
      matchedId = id;
      break;
    }
  }
  if (!matchedId) return res.status(401).json({ error: "bad-passcode" });
  const secure = req.secure ? "; Secure" : ""; // Secure only over HTTPS (Render); not on http://localhost
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${authToken(matchedId)}; Max-Age=${AUTH_DAYS * 86400}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

// The gate itself: block anything non-public without a valid session, and tag
// the request with its household so data routes can scope their keys.
app.use((req, res, next) => {
  if (!AUTH_ON) {
    req.householdId = LOCAL_HOUSEHOLD_ID; // open mode (local/dev): single default household
    return next();
  }
  if (authPublic(req.path)) return next();
  const hh = authHousehold(readCookie(req, AUTH_COOKIE));
  if (hh) {
    req.householdId = hh;
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "auth-required" });
  return res.status(401).sendFile(path.join(__dirname, "public", "login.html")); // show passcode screen
});

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
// Also mirrored to Redis (when shared storage is on) so the search fallback pool
// survives Render's ephemeral disk being wiped on redeploy/cold-start.
const POOL_REDIS_KEY = "pool:v1";

// Full recipe details (ingredients/steps/nutrition) live under a shared global
// key — recipes aren't household-specific. Unlike the 6h memory cache and the
// 24h pool, this cache is PERSISTENT (no TTL): once a recipe is cached here it
// stays viewable forever, even after the daily Spoonacular quota is gone. Every
// recipe saved to a meal plan is cached here so plans are always openable.
const recipeKey = (id) => `recipe:v1:${id}`;

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
    if (storageEnabled) redisSetJSON(POOL_REDIS_KEY, fresh).catch(() => {}); // survive redeploys
  }, 3000);
}

// Merge the Redis-mirrored pool on startup so the home/search fallback still has
// recipes after Render wipes the local pool-cache.json file.
async function loadPoolFromRedis() {
  if (!storageEnabled) return;
  try {
    const arr = await redisGetJSON(POOL_REDIS_KEY);
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    for (const r of arr) {
      if (r && r.id != null && now - (r._t || 0) < POOL_TTL && !recipePool.has(r.id)) recipePool.set(r.id, r);
    }
    if (recipePool.size) console.log(`  Pool holds ${recipePool.size} saved recipes (incl. Redis).`);
  } catch {
    /* Redis hiccup — the disk pool (if any) still applies */
  }
}

// Resolve full details for a set of recipe ids using every cache layer before
// touching the API: 6h memory -> persistent Redis -> Spoonacular (results then
// written back to both caches). `allowFetch:false` stays cache-only (used when
// there's no API key). Returns { recipes:{id:recipe}, fetched, apiError } — on an
// API failure it still returns whatever was already cached, so saved recipes
// keep opening once the daily quota is gone.
async function resolveRecipes(ids, { allowFetch = true } = {}) {
  const recipes = {};
  let missing = [];
  for (const id of ids) {
    const c = cacheGet(`recipe:${id}`);
    if (c) recipes[id] = c;
    else missing.push(id);
  }
  if (missing.length && storageEnabled) {
    try {
      const vals = await redisMGetJSON(missing.map(recipeKey));
      const stillMissing = [];
      missing.forEach((id, i) => {
        if (vals[i]) {
          recipes[id] = vals[i];
          cacheSet(`recipe:${id}`, vals[i]); // warm the fast in-memory cache
        } else {
          stillMissing.push(id);
        }
      });
      missing = stillMissing;
    } catch {
      /* Redis hiccup — fall through to the API */
    }
  }
  let apiError = null;
  let fetched = 0;
  // Only numeric ids come from Spoonacular; imported recipes (imp_*) live purely
  // in our cache/Redis, so never send them to the upstream bulk lookup.
  const fetchable = missing.filter((id) => /^\d+$/.test(String(id)));
  if (fetchable.length && allowFetch) {
    try {
      const data = await spoonFetch("/recipes/informationBulk", {
        ids: fetchable.join(","),
        includeNutrition: "true",
      });
      for (const r of data) {
        const clean = normalizeRecipe(r);
        cacheSet(`recipe:${r.id}`, clean);
        recipes[r.id] = clean;
        fetched++;
        if (storageEnabled) redisSetJSON(recipeKey(r.id), clean).catch(() => {}); // persist forever
      }
    } catch (e) {
      apiError = e; // quota/key failure — caller still gets the cached hits above
    }
  }
  return { recipes, fetched, apiError };
}

// After a plan is saved, make sure every recipe in it has its full details in the
// persistent cache, so a planned recipe always opens even after the quota runs
// out. Best-effort: only fetches ids not already cached, so once warmed it costs
// a single (free) Redis read and no API calls.
async function cachePlanRecipes(plan) {
  if (!storageEnabled) return;
  if (!(API_KEY && API_KEY !== "your_key_here")) return;
  const ids = [
    ...new Set(
      Object.values(plan || {})
        .flat()
        .map((r) => r && r.id)
        .filter((x) => x != null)
        .map(String)
    ),
  ];
  if (!ids.length) return;
  try {
    const vals = await redisMGetJSON(ids.map(recipeKey));
    const missing = ids.filter((_, i) => !vals[i]);
    if (missing.length) await resolveRecipes(missing, { allowFetch: true });
  } catch {
    /* best effort — will retry on the next plan save */
  }
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
    importEnabled: Boolean(anthropic), // whether Claude recipe import is configured
    household: req.householdId, // which household this session belongs to
    authOn: AUTH_ON, // whether the passcode gate is active
  });
});

// ---- Weather (Open-Meteo: free, no API key, no signup) ----
// Defaults to Alton, IL; the frontend passes lat/lon from the saved Settings
// location. Cached briefly in memory so tab-switching doesn't re-hit the API.
const DEFAULT_WEATHER = { lat: 38.8906, lon: -90.1843 };
const weatherCache = new Map();
const WEATHER_TTL = 1000 * 60 * 10; // 10 minutes

// Classify a WMO code as a kind of precipitation (or null when it's dry), so we
// can spot the next change and tag it, e.g. "Rain in 2 hr".
function precipKind(code) {
  const c = Number(code);
  if (c >= 95) return { emoji: "⛈️", label: "Storms" };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { emoji: "❄️", label: "Snow" };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { emoji: "🌧️", label: "Rain" };
  if (c >= 51 && c <= 57) return { emoji: "🌦️", label: "Drizzle" };
  return null; // clear / cloudy / fog — nothing falling
}
// Look up to 6 hours ahead for the next flip in precipitation state. Returns a
// small tag { emoji, label, hours } — precip starting, or things clearing — or
// null when the next several hours look like more of the same.
function nextWeatherChange(cur, hourly) {
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.weather_code)) return null;
  const nowWet = precipKind(cur.weather_code);
  const curTime = cur.time || "";
  // Align to the first hourly slot at or after the current time.
  let start = hourly.time.findIndex((t) => t >= curTime);
  if (start < 0) start = 0;
  const probs = hourly.precipitation_probability || [];
  for (let k = 1; k <= 6; k++) {
    const i = start + k;
    if (i >= hourly.time.length) break;
    const kind = precipKind(hourly.weather_code[i]);
    if (!nowWet && kind) {
      // Precip beginning — require a non-trivial chance to avoid false alarms.
      const p = probs[i];
      if (p == null || p >= 35) return { emoji: kind.emoji, label: kind.label, hours: k };
    } else if (nowWet && !kind) {
      // It's currently wet and the sky opens up.
      return { emoji: "🌤️", label: "Clearing", hours: k };
    }
  }
  return null;
}

app.get("/api/weather", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const useLat = Number.isFinite(lat) ? lat : DEFAULT_WEATHER.lat;
  const useLon = Number.isFinite(lon) ? lon : DEFAULT_WEATHER.lon;
  const key = `${useLat.toFixed(3)},${useLon.toFixed(3)}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < WEATHER_TTL) return res.json(hit.data);
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", useLat);
    url.searchParams.set("longitude", useLon);
    url.searchParams.set("current", "temperature_2m,apparent_temperature,is_day,weather_code");
    url.searchParams.set("hourly", "weather_code,precipitation_probability");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "2");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    const j = await r.json();
    const cur = j.current || {};
    const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    const data = {
      temp: round(cur.temperature_2m),
      feels: round(cur.apparent_temperature),
      code: Number.isFinite(cur.weather_code) ? cur.weather_code : null,
      isDay: cur.is_day !== 0,
      soon: nextWeatherChange(cur, j.hourly),
    };
    weatherCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "Could not reach the weather service." });
  }
});

// Turn a typed town into coordinates (used by the Settings location field).
app.get("/api/geocode", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ results: [] });
  try {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", q);
    url.searchParams.set("count", "5");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`geocoding ${r.status}`);
    const j = await r.json();
    const results = (j.results || []).map((x) => ({
      name: x.name,
      admin1: x.admin1 || "",
      country: x.country_code || x.country || "",
      lat: x.latitude,
      lon: x.longitude,
    }));
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: "Could not look up that place." });
  }
});

// Every household's data lives under its own key prefix so families never see
// each other's plan, chores, calendar, etc.
const keyFor = (req, name) => `hh:${req.householdId}:${name}`;

// ---- Per-household plan + favorites (scoped by the session cookie) ----
app.get("/api/plan", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, plan: (await redisGetJSON(keyFor(req, "plan"))) || {} });
  } catch {
    res.status(502).json({ error: "Could not read the shared plan." });
  }
});
app.put("/api/plan", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    const plan = req.body?.plan || {};
    await redisSetJSON(keyFor(req, "plan"), plan);
    cachePlanRecipes(plan).catch(() => {}); // fire-and-forget: keep planned recipes viewable
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save the shared plan." });
  }
});
app.get("/api/favorites", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, favorites: (await redisGetJSON(keyFor(req, "favorites"))) || [] });
  } catch {
    res.status(502).json({ error: "Could not read favorites." });
  }
});
app.put("/api/favorites", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "favorites"), req.body?.favorites || []);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save favorites." });
  }
});
// Per-household list of manually imported recipe summaries (the full details
// live globally in recipe:v1:*; this is just the household's own library of them).
app.get("/api/imports", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, imports: (await redisGetJSON(keyFor(req, "imports"))) || [] });
  } catch {
    res.status(502).json({ error: "Could not read imported recipes." });
  }
});
app.put("/api/imports", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "imports"), req.body?.imports || []);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save imported recipes." });
  }
});
app.get("/api/grocery", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, grocery: (await redisGetJSON(keyFor(req, "grocery"))) || {} });
  } catch {
    res.status(502).json({ error: "Could not read grocery state." });
  }
});
app.put("/api/grocery", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "grocery"), req.body?.grocery || {});
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save grocery state." });
  }
});
app.get("/api/notes", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, notes: (await redisGetJSON(keyFor(req, "notes"))) || [] });
  } catch {
    res.status(502).json({ error: "Could not read notes." });
  }
});
app.put("/api/notes", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "notes"), req.body?.notes || []);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save notes." });
  }
});
app.get("/api/events", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, events: (await redisGetJSON(keyFor(req, "events"))) || [] });
  } catch {
    res.status(502).json({ error: "Could not read calendar events." });
  }
});
app.put("/api/events", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "events"), req.body?.events || []);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save calendar events." });
  }
});
app.get("/api/todos", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, todos: (await redisGetJSON(keyFor(req, "todos"))) || [] });
  } catch {
    res.status(502).json({ error: "Could not read the to-do list." });
  }
});
app.put("/api/todos", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "todos"), req.body?.todos || []);
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save the to-do list." });
  }
});
app.get("/api/tracker", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, tracker: (await redisGetJSON(keyFor(req, "tracker"))) || null });
  } catch {
    res.status(502).json({ error: "Could not read the tracker." });
  }
});
app.put("/api/tracker", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "tracker"), req.body?.tracker || {});
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save the tracker." });
  }
});

// Household settings (currently just the two people's names). Small shared blob
// so the names sync across devices like everything else.
app.get("/api/settings", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, settings: (await redisGetJSON(keyFor(req, "settings"))) || null });
  } catch {
    res.status(502).json({ error: "Could not read settings." });
  }
});
app.put("/api/settings", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "settings"), req.body?.settings || {});
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save settings." });
  }
});

// Store-mode layout (per-store aisle order + crowdsourced item->aisle map). A
// small shared blob that syncs across the household like everything else.
app.get("/api/store", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, store: (await redisGetJSON(keyFor(req, "store"))) || null });
  } catch {
    res.status(502).json({ error: "Could not read the store layout." });
  }
});
app.put("/api/store", async (req, res) => {
  if (!storageEnabled) return res.json({ enabled: false });
  try {
    await redisSetJSON(keyFor(req, "store"), req.body?.store || {});
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "Could not save the store layout." });
  }
});

// ===========================================================================
//  Recipe import (Claude) — turn a link or a screenshot into a real recipe
//  that flows through the normal card → plan → grocery-list machinery.
// ===========================================================================

// The grocery aisles the client groups by (must match AISLE_RULES in app.js so
// imported ingredients slot into the same sections). Claude picks one per item.
const IMPORT_AISLES = [
  "Produce", "Meat", "Seafood", "Cheese", "Milk, Eggs, Other Dairy",
  "Bakery/Bread", "Frozen", "Pasta and Rice", "Baking", "Cereal",
  "Canned and Jarred", "Condiments", "Oil, Vinegar, Salad Dressing",
  "Spices and Seasonings", "Nut butters, Jams, and Honey", "Beverages",
  "Alcoholic Beverages", "Savory Snacks", "Sweet Snacks", "Nuts",
  "Household", "Other",
];

const IMPORT_SYSTEM = `You extract a single cooking recipe from the text or image a user provides and return it as strict JSON.

Respond with ONLY a JSON object — no markdown, no code fences, no commentary. Use exactly this shape:
{
  "title": string,
  "image": string | null,          // an image URL if one is clearly present in the source, else null
  "readyInMinutes": integer | null, // total time in minutes if stated
  "servings": integer | null,
  "ingredients": [
    { "name": string,               // the shopping item, singular and lowercase (e.g. "chicken breast", "yellow onion")
      "amount": number | null,      // numeric quantity; convert fractions like 1/2 to 0.5; null if none
      "unit": string,               // e.g. "cup", "tbsp", "clove", "" if none
      "aisle": string }             // MUST be one of: ${IMPORT_AISLES.join(", ")}
  ],
  "steps": [ string ]               // ordered preparation steps, one sentence-group each
}

Rules:
- Keep ingredient "name" to the actual product to buy; put prep words (chopped, minced) out of the name where you can.
- For a quantity range like "1 to 2" or "2-3", use the lower number as "amount" and keep only the item itself in "name".
- Pick the single best "aisle" from the allowed list for each ingredient; use "Other" only if nothing fits.
- Do not invent ingredients or steps that aren't in the source.
- If the source is not a recipe (no ingredients or no steps), respond with exactly {"error":"not_a_recipe"}.`;

function requireAnthropic(res) {
  if (!anthropic) {
    res.status(503).json({
      error: "Recipe import isn't set up yet — add an ANTHROPIC_API_KEY on the server to enable it.",
    });
    return false;
  }
  return true;
}

function importError(e) {
  if (e && e.status === 401) return "The Claude API key was rejected. Double-check ANTHROPIC_API_KEY.";
  if (e && e.status === 429) return "Import is busy right now — please try again in a moment.";
  if (e && (e.status === 400 || e.status === 413)) return "That recipe was too large or malformed to import.";
  return "Couldn't import that recipe. Please try again.";
}

// Pull a usable JSON object out of the model's text response, tolerating stray
// prose or code fences around it.
function safeParseJSON(text) {
  const cleaned = (text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(cleaned.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
    return { error: "parse_failed" };
  }
}

// Block obviously-internal hosts so a pasted link can't be used to probe the
// server's own network (basic SSRF guard for a private family app).
function isPrivateHost(host) {
  const h = (host || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

// Fetch a recipe page and reduce it to text worth handing the model: the
// schema.org/Recipe JSON-LD block when present (cheapest + cleanest), otherwise
// the visible body text. Also returns a best-effort hero image URL.
async function fetchRecipePage(href) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let html;
  try {
    const r = await fetch(href, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; HomebaseRecipeImport/1.0; +https://homebase.app)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!r.ok) {
      const err = new Error(`Fetch ${r.status}`);
      err.status = r.status === 404 ? 404 : 502;
      throw err;
    }
    html = await r.text();
  } finally {
    clearTimeout(timer);
  }

  let image = null;
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) image = og[1];

  // Prefer JSON-LD Recipe data.
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try {
      data = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
    for (const node of nodes) {
      const t = node && node["@type"];
      const isRecipe = t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
      if (isRecipe) {
        if (!image && node.image) {
          image = typeof node.image === "string" ? node.image : node.image?.url || node.image?.[0]?.url || node.image?.[0] || null;
        }
        return { text: JSON.stringify(node).slice(0, 16000), image };
      }
    }
  }

  // Fallback: strip tags and hand over the visible text.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
  return { text, image };
}

async function parseRecipeWithClaude({ text, imageBase64, imageMediaType, sourceUrl }) {
  const content = [];
  if (imageBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: imageMediaType || "image/jpeg", data: imageBase64 },
    });
  }
  content.push({
    type: "text",
    text: text
      ? `Extract the recipe from this web page${sourceUrl ? ` (${sourceUrl})` : ""}:\n\n${text}`
      : "Extract the recipe shown in this image.",
  });
  const msg = await anthropic.messages.create({
    model: IMPORT_MODEL,
    max_tokens: 2000,
    system: IMPORT_SYSTEM,
    messages: [{ role: "user", content }],
  });
  const out = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return safeParseJSON(out);
}

const cleanAisle = (a) => (IMPORT_AISLES.includes(a) ? a : "Other");
function ingredientOriginal(i) {
  const qty = i.amount != null && i.amount > 0 ? String(Number(i.amount.toFixed ? i.amount.toFixed(2) : i.amount)).replace(/\.00$/, "") : "";
  return [qty, i.unit, i.name].filter(Boolean).join(" ").trim() || i.name;
}

// Turn a parsed recipe into the app's normalized shape, give it a stable custom
// id, and persist it to the recipe cache so /api/recipes can resolve it later
// (it never hits Spoonacular — the id isn't numeric).
async function finishImportedRecipe(parsed, { sourceUrl = null, image = null } = {}) {
  const id = "imp_" + crypto.randomBytes(6).toString("hex");
  const ingredients = (Array.isArray(parsed.ingredients) ? parsed.ingredients : [])
    .map((i) => {
      const name = (i.name || "").toString().trim();
      const amt = typeof i.amount === "number" ? i.amount : Number(i.amount);
      return {
        name,
        amount: Number.isFinite(amt) && amt > 0 ? amt : null,
        unit: (i.unit || "").toString().trim(),
        aisle: cleanAisle((i.aisle || "Other").toString().trim()),
        original: "",
      };
    })
    .filter((i) => i.name);
  ingredients.forEach((i) => (i.original = ingredientOriginal(i)));

  const recipe = {
    id,
    title: (parsed.title || "Imported recipe").toString().trim(),
    image: image || parsed.image || null,
    readyInMinutes: Number.isFinite(Number(parsed.readyInMinutes)) ? Number(parsed.readyInMinutes) : null,
    servings: Number.isFinite(Number(parsed.servings)) ? Number(parsed.servings) : null,
    sourceUrl: sourceUrl || null,
    glutenFree: false,
    nutrition: null,
    imported: true,
    steps: (Array.isArray(parsed.steps) ? parsed.steps : []).map((s) => (s || "").toString().trim()).filter(Boolean),
    ingredients,
  };

  cacheSet(`recipe:${id}`, recipe); // warm the fast in-memory cache
  if (storageEnabled) redisSetJSON(recipeKey(id), recipe).catch(() => {}); // persist forever

  const summary = {
    id,
    title: recipe.title,
    image: recipe.image,
    readyInMinutes: recipe.readyInMinutes,
    servings: recipe.servings,
    calories: null,
    imported: true,
  };
  return { summary, recipe };
}

// Import from a pasted link.
app.post("/api/import/url", async (req, res) => {
  if (!requireAnthropic(res)) return;
  const raw = (req.body && req.body.url ? req.body.url : "").toString().trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return res.status(400).json({ error: "That doesn't look like a valid link." });
  }
  if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: "Only http and https links can be imported." });
  if (isPrivateHost(url.hostname)) return res.status(400).json({ error: "That link can't be imported." });
  try {
    const { text, image } = await fetchRecipePage(url.href);
    if (!text || text.length < 40) {
      return res.status(422).json({ error: "Couldn't read that page. Try a screenshot of the recipe instead." });
    }
    const parsed = await parseRecipeWithClaude({ text, sourceUrl: url.href });
    if (parsed.error) {
      return res.status(422).json({ error: "That page didn't look like a recipe. Try a screenshot instead." });
    }
    const { summary, recipe } = await finishImportedRecipe(parsed, { sourceUrl: url.href, image });
    res.json({ summary, recipe });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 502).json({ error: importError(e) });
  }
});

// Import from a screenshot / photo (base64, no data: prefix).
const IMPORT_IMG_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
app.post("/api/import/image", async (req, res) => {
  if (!requireAnthropic(res)) return;
  const body = req.body || {};
  const image = typeof body.image === "string" ? body.image.replace(/^data:[^,]+,/, "") : "";
  if (!image) return res.status(400).json({ error: "No image was received." });
  if (image.length > 7_500_000) return res.status(413).json({ error: "That image is too large — try a smaller screenshot." });
  const mediaType = IMPORT_IMG_TYPES.has(body.mediaType) ? body.mediaType : "image/jpeg";
  try {
    const parsed = await parseRecipeWithClaude({ imageBase64: image, imageMediaType: mediaType });
    if (parsed.error) {
      return res.status(422).json({ error: "Couldn't find a recipe in that image." });
    }
    const { summary, recipe } = await finishImportedRecipe(parsed, {});
    res.json({ summary, recipe });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 502).json({ error: importError(e) });
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
  const lowAcid = ["1", "true", "yes"].includes(
    (req.query.lowacid || "").toString().toLowerCase()
  );
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0); // for "load more"
  const cacheKey = `search:${type}:${query}:${diet}:${glutenFree}:${under500}:${lowAcid}:${number}:${offset}`;
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
    if (lowAcid) params.excludeIngredients = LOW_ACID_EXCLUDE; // Heuristic GERD filter.
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
// Serves from the persistent cache first, so recipes saved to a plan stay
// viewable even with no API key or after the daily quota is exhausted.
app.get("/api/recipes", async (req, res) => {
  const ids = (req.query.ids || "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return res.json({ recipes: [] });

  const haveKey = Boolean(API_KEY && API_KEY !== "your_key_here");
  const { recipes, apiError } = await resolveRecipes(ids, { allowFetch: haveKey });
  const ordered = ids.map((id) => recipes[id]).filter(Boolean); // preserve requested order

  // If we resolved anything from cache, serve it even when the live API failed —
  // a saved recipe should never become unopenable just because quota ran out.
  if (ordered.length) return res.json({ recipes: ordered, stale: Boolean(apiError) });

  if (apiError) return res.status(apiError.status || 500).json({ error: friendlyError(apiError) });
  if (!haveKey) return requireKey(res); // no key and nothing cached → friendly 503
  res.json({ recipes: [] });
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

// One-time move of the original single-household data into its namespaced home.
// Copies meal:* → hh:{LEGACY_HOUSEHOLD_ID}:* once (guarded by a marker), never
// deletes the originals, and never overwrites an existing destination — so it's
// idempotent and fully reversible via the meal:* keys + a backup snapshot.
async function migrateLegacyKeys() {
  if (!storageEnabled) return;
  const MARKER = "hh:migrated:v1";
  const NAMES = ["plan", "favorites", "grocery", "notes", "tracker", "events", "todos", "settings"];
  try {
    if (await redisGetJSON(MARKER)) return; // already migrated
    let moved = 0;
    for (const name of NAMES) {
      const legacy = await redisGetJSON(`meal:${name}`);
      if (legacy == null) continue;
      const dest = `hh:${LEGACY_HOUSEHOLD_ID}:${name}`;
      if ((await redisGetJSON(dest)) != null) continue; // don't clobber existing
      await redisSetJSON(dest, legacy);
      moved++;
    }
    await redisSetJSON(MARKER, { at: new Date().toISOString(), to: LEGACY_HOUSEHOLD_ID });
    if (moved) console.log(`  Migrated ${moved} legacy key(s) → hh:${LEGACY_HOUSEHOLD_ID}:*`);
  } catch (e) {
    console.warn("  Legacy migration skipped (will retry next boot):", e.message);
  }
}

app.listen(PORT, () => {
  console.log(`\n  🍽  At-Home Meal Planner running at http://localhost:${PORT}\n`);
  if (!API_KEY || API_KEY === "your_key_here") {
    console.log("  ⚠  No API key yet. Add SPOONACULAR_API_KEY to a .env file, then restart.\n");
  }
  migrateLegacyKeys();
  loadPoolFromRedis(); // rehydrate the search-fallback pool after ephemeral-disk wipes
});
