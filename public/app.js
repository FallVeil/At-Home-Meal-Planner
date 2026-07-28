// ============================================================
//  State
// ============================================================
const PLAN_KEY = "mealPlanner.plan.v2";
const OLD_WEEK_KEY = "mealPlanner.week.v1";

// plan = { "YYYY-MM-DD" (Monday of the week): [ {recipe}, ... ] }
const WEEKS_SHOWN = 5; // this week + the next four
let plan = loadPlan();
let windowStart = startOfWeek(new Date()); // Monday of the first week shown (defaults to this week)
let targetWeek = weekKeyOf(new Date()); // week new dishes get added to
let activeCategory = ""; // dish-type filter for search
let groceryWeek = null; // which week the Grocery tab is currently showing

function loadPlan() {
  try {
    const p = JSON.parse(localStorage.getItem(PLAN_KEY));
    if (p && typeof p === "object" && !Array.isArray(p)) return p;
  } catch {
    /* ignore */
  }
  // One-time migration: fold an old single-week list into the current week.
  try {
    const old = JSON.parse(localStorage.getItem(OLD_WEEK_KEY));
    if (Array.isArray(old) && old.length) {
      const migrated = { [weekKeyOf(new Date())]: old };
      localStorage.setItem(PLAN_KEY, JSON.stringify(migrated));
      localStorage.removeItem(OLD_WEEK_KEY);
      return migrated;
    }
  } catch {
    /* ignore */
  }
  return {};
}
function savePlan() {
  localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
  updatePlanCount();
  schedulePlanPush();
}
const weekDishes = (key) => plan[key] || [];
const inWeek = (key, id) => weekDishes(key).some((r) => String(r.id) === String(id));
const totalDishes = () =>
  Object.values(plan).reduce((n, arr) => n + (arr ? arr.length : 0), 0);

function addToWeek(key, recipe) {
  if (!plan[key]) plan[key] = [];
  if (plan[key].some((r) => String(r.id) === String(recipe.id))) return false;
  plan[key].push(recipe);
  // Drop empty weeks kept around by removals, then save.
  savePlan();
  return true;
}
function removeFromWeek(key, id) {
  if (!plan[key]) return;
  plan[key] = plan[key].filter((r) => String(r.id) !== String(id));
  if (!plan[key].length) delete plan[key];
  savePlan();
}

// ---- Favorites (saved recipes, shown in their own tab) ----
const FAV_KEY = "mealPlanner.favorites.v1";
let favorites = loadFavorites();
function loadFavorites() {
  try {
    const f = JSON.parse(localStorage.getItem(FAV_KEY));
    return Array.isArray(f) ? f : [];
  } catch {
    return [];
  }
}
function saveFavorites() {
  localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  updateFavCount();
  scheduleFavPush();
}
const isFavorite = (id) => favorites.some((r) => String(r.id) === String(id));
function toggleFavorite(recipe) {
  if (isFavorite(recipe.id)) {
    favorites = favorites.filter((r) => String(r.id) !== String(recipe.id));
  } else {
    favorites.push(recipe);
  }
  saveFavorites();
  return isFavorite(recipe.id);
}

// ---- Cross-device sync (active only when the server has shared storage) ----
let syncEnabled = false;
let planPushTimer = null;
let favPushTimer = null;

function schedulePlanPush() {
  if (!syncEnabled) return;
  clearTimeout(planPushTimer);
  planPushTimer = setTimeout(() => {
    fetch("/api/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    }).catch(() => {});
  }, 700);
}
function scheduleFavPush() {
  if (!syncEnabled) return;
  clearTimeout(favPushTimer);
  favPushTimer = setTimeout(() => {
    fetch("/api/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorites }),
    }).catch(() => {});
  }, 700);
}

// Pull the shared plan/favorites and refresh whatever tab is showing.
async function refreshFromServer() {
  if (!syncEnabled) return;
  try {
    const [pr, fr, gr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
      fetch("/api/grocery").then((r) => r.json()),
    ]);
    if (pr.enabled && pr.plan) {
      plan = pr.plan;
      localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
      updatePlanCount();
    }
    if (fr.enabled && Array.isArray(fr.favorites)) {
      favorites = fr.favorites;
      localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
      updateFavCount();
    }
    if (gr.enabled && gr.grocery) {
      grocery = gr.grocery;
      localStorage.setItem(GROCERY_KEY, JSON.stringify(grocery));
    }
    if ($("#tab-plan").classList.contains("active")) renderPlanner();
    if ($("#tab-favorites").classList.contains("active")) renderFavorites();
    if ($("#tab-grocery").classList.contains("active") && groceryWeek) {
      renderGrocery(lastGroceryRecipes, groceryWeek);
    }
  } catch {
    /* offline/transient — keep local copy */
  }
}

// First load: server wins if it has data, otherwise push the local copy up.
async function initSync() {
  if (!syncEnabled) return;
  try {
    const [pr, fr, gr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
      fetch("/api/grocery").then((r) => r.json()),
    ]);
    if (pr.enabled) {
      const serverPlan = pr.plan || {};
      if (Object.keys(serverPlan).length) {
        plan = serverPlan;
        localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
      } else if (totalDishes()) {
        schedulePlanPush();
      }
    }
    if (fr.enabled) {
      const serverFav = fr.favorites || [];
      if (serverFav.length) {
        favorites = serverFav;
        localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
      } else if (favorites.length) {
        scheduleFavPush();
      }
    }
    if (gr.enabled) {
      const serverGrocery = gr.grocery || {};
      if (Object.keys(serverGrocery).length) {
        grocery = serverGrocery;
        localStorage.setItem(GROCERY_KEY, JSON.stringify(grocery));
      } else if (Object.keys(grocery).length) {
        scheduleGroceryPush();
      }
    }
    updatePlanCount();
    updateFavCount();
    renderPlanner();
  } catch {
    /* ignore */
  }
}

// ============================================================
//  Date helpers (weeks start Monday)
// ============================================================
function startOfWeek(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (date.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  date.setDate(date.getDate() - dow);
  return date;
}
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Function declaration (hoisted) so it's callable from the state setup above.
function weekKeyOf(d) {
  return isoDate(startOfWeek(d));
}
function parseKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtRange(monday) {
  const sun = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const a = monday.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const b = sun.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${a} – ${b}`;
}
const isThisWeek = (key) => key === weekKeyOf(new Date());

// ============================================================
//  Elements & tabs
// ============================================================
const $ = (sel) => document.querySelector(sel);
const results = $("#results");
const weeksContainer = $("#weeksContainer");
const groceryList = $("#groceryList");
const groceryEmpty = $("#groceryEmpty");
const groceryMeta = $("#groceryMeta");

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});
function activateTab(name) {
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document
    .querySelectorAll(".panel")
    .forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "plan") {
    renderPlanner();
    refreshFromServer();
  }
  if (name === "search") updateTargetBanner();
  if (name === "favorites") {
    renderFavorites();
    refreshFromServer();
  }
  if (name === "grocery") {
    populateGrocerySelect();
    loadGroceryWeek(groceryWeek || weekKeyOf(new Date()));
    refreshFromServer();
  }
}

// Pull the latest shared data when the app regains focus (e.g. you switch back
// to it after your wife added something on her phone).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshFromServer();
});

// ============================================================
//  Search
// ============================================================
$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});
$("#calFilter").addEventListener("change", runSearch);
$("#gfFilter").addEventListener("change", runSearch);

// Category chips.
document.querySelectorAll("#categoryChips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    activeCategory = chip.dataset.type;
    document
      .querySelectorAll("#categoryChips .chip")
      .forEach((c) => c.classList.toggle("active", c === chip));
    runSearch();
  });
});

// Snapshot of the active search so "load more" repeats the same filters.
let currentSearch = null;
let searchOffset = 0;
let searchHasMore = false;

async function runSearch() {
  currentSearch = {
    query: $("#searchInput").value.trim(),
    type: activeCategory,
    gf: $("#gfFilter").checked,
    under500: $("#calFilter").checked,
  };
  searchOffset = 0;
  searchHasMore = false;
  results.innerHTML = `<div class="loading"><div class="spinner"></div>Searching recipes…</div>`;
  await fetchSearchPage(true);
}

async function fetchSearchPage(reset) {
  const p = currentSearch;
  const params = new URLSearchParams({ query: p.query, number: "12", offset: String(searchOffset) });
  if (p.type) params.set("type", p.type);
  if (p.under500) params.set("under500", "1");
  if (p.gf) params.set("gf", "1");

  const btn = $("#loadMore");
  if (!reset && btn) {
    btn.disabled = true;
    btn.textContent = "Loading…";
  }
  try {
    const res = await fetch(`/api/search?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");

    const staleNote = $("#staleNote");
    if (data.stale) {
      staleNote.textContent =
        "⚠️ Daily recipe limit reached — showing saved recipes from recent browsing.";
      staleNote.classList.remove("hidden");
    } else {
      staleNote.classList.add("hidden");
    }

    if (reset) results.innerHTML = "";
    if (reset && (!data.results || !data.results.length)) {
      results.innerHTML = `<div class="empty">No recipes found. Try a different search or category.</div>`;
    } else {
      (data.results || []).forEach((r) => results.appendChild(recipeCard(r, "search")));
    }
    searchOffset = data.nextOffset ?? searchOffset + 12;
    searchHasMore = Boolean(data.hasMore);
    renderLoadMore();
  } catch (err) {
    if (reset) {
      $("#staleNote").classList.add("hidden");
      results.innerHTML = `<div class="empty">😕 ${escapeHtml(err.message)}</div>`;
    } else {
      toast("Couldn't load more recipes.");
    }
    searchHasMore = false;
    renderLoadMore();
  }
}

function renderLoadMore() {
  const btn = $("#loadMore");
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = "Load more recipes";
  btn.classList.toggle("hidden", !searchHasMore);
}
$("#loadMore").addEventListener("click", () => fetchSearchPage(false));

function updateTargetBanner() {
  const banner = $("#targetBanner");
  const monday = parseKey(targetWeek);
  const label = isThisWeek(targetWeek) ? "this week" : `week of ${fmtRange(monday)}`;
  banner.innerHTML = `📅 Adding dishes to <strong>${escapeHtml(label)}</strong> <span class="muted-note">— change in Planner</span>`;
}

// ============================================================
//  Recipe cards
// ============================================================
function recipeCard(r, context, weekKey) {
  const card = document.createElement("div");
  card.className = "card";
  const meta = [
    r.readyInMinutes ? `⏱ ${r.readyInMinutes} min` : "",
    r.servings ? `🍽 ${r.servings} serv` : "",
    r.calories != null ? `🔥 ${r.calories} cal` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  card.innerHTML = `
    <img src="${r.image || placeholder()}" alt="${escapeHtml(r.title)}" loading="lazy" />
    <div class="card-body">
      <div class="card-title">${escapeHtml(r.title)}</div>
      <div class="card-meta">${meta || "&nbsp;"}</div>
      <div class="card-actions"></div>
    </div>`;

  const img = card.querySelector("img");
  const title = card.querySelector(".card-title");
  img.addEventListener("click", () => showRecipe(r.id));
  title.addEventListener("click", () => showRecipe(r.id));
  img.onerror = () => (img.src = placeholder());

  const actions = card.querySelector(".card-actions");
  if (context === "plan") {
    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      removeFromWeek(weekKey, r.id);
      renderPlanner();
    });
    actions.appendChild(remove);
  } else {
    const added = inWeek(targetWeek, r.id);
    const add = document.createElement("button");
    add.className = "add-btn" + (added ? " added" : "");
    add.textContent = added ? "✓ Added" : "＋ Add to plan";
    add.addEventListener("click", () => {
      if (inWeek(targetWeek, r.id)) return;
      addToWeek(targetWeek, {
        id: r.id,
        title: r.title,
        image: r.image,
        readyInMinutes: r.readyInMinutes,
        servings: r.servings,
        calories: r.calories,
      });
      add.classList.add("added");
      add.textContent = "✓ Added";
      const label = isThisWeek(targetWeek) ? "this week" : `week of ${fmtRange(parseKey(targetWeek))}`;
      toast(`Added “${r.title}” to ${label}`);
    });
    actions.appendChild(add);
  }

  // Favorite star, overlaid on the image (available in every context).
  const star = document.createElement("button");
  star.className = "fav-star" + (isFavorite(r.id) ? " on" : "");
  star.setAttribute("aria-label", "Toggle favorite");
  star.textContent = isFavorite(r.id) ? "★" : "☆";
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowFav = toggleFavorite({
      id: r.id,
      title: r.title,
      image: r.image,
      readyInMinutes: r.readyInMinutes,
      servings: r.servings,
      calories: r.calories,
    });
    star.classList.toggle("on", nowFav);
    star.textContent = nowFav ? "★" : "☆";
    toast(nowFav ? `Favorited “${r.title}”` : `Unfavorited “${r.title}”`);
    // On the Favorites tab, remove the card immediately when unfavorited.
    if (!nowFav && $("#tab-favorites").classList.contains("active")) {
      card.remove();
      if (!favorites.length) renderFavorites();
    }
  });
  card.appendChild(star);

  return card;
}

function renderFavorites() {
  const list = $("#favList");
  list.innerHTML = "";
  if (!favorites.length) {
    $("#favEmpty").classList.remove("hidden");
    return;
  }
  $("#favEmpty").classList.add("hidden");
  favorites.forEach((r) => list.appendChild(recipeCard(r, "search")));
}

// ============================================================
//  Planner (month view)
// ============================================================
// Page the 5-week window forward/back, but never earlier than this week.
function shiftWindow(deltaWeeks) {
  const floor = startOfWeek(new Date());
  let d = new Date(
    windowStart.getFullYear(),
    windowStart.getMonth(),
    windowStart.getDate() + deltaWeeks * 7
  );
  if (d < floor) d = floor;
  windowStart = d;
  renderPlanner();
}
$("#prevMonth").addEventListener("click", () => shiftWindow(-WEEKS_SHOWN));
$("#nextMonth").addEventListener("click", () => shiftWindow(WEEKS_SHOWN));

function renderPlanner() {
  const weeks = [];
  for (let i = 0; i < WEEKS_SHOWN; i++) {
    weeks.push(
      new Date(windowStart.getFullYear(), windowStart.getMonth(), windowStart.getDate() + i * 7)
    );
  }
  const firstMon = weeks[0];
  const lastSun = new Date(
    weeks[WEEKS_SHOWN - 1].getFullYear(),
    weeks[WEEKS_SHOWN - 1].getMonth(),
    weeks[WEEKS_SHOWN - 1].getDate() + 6
  );
  $("#monthLabel").textContent =
    `${firstMon.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ` +
    `${lastSun.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  // Disable "back" when already at this week (can't plan the past).
  $("#prevMonth").disabled = isoDate(windowStart) === weekKeyOf(new Date());
  weeksContainer.innerHTML = "";

  weeks.forEach((monday) => {
    const key = isoDate(monday);
    const dishes = weekDishes(key);
    const isTarget = key === targetWeek;

    const block = document.createElement("div");
    block.className = "week-block" + (isTarget ? " target" : "");
    block.innerHTML = `
      <div class="week-head">
        <div class="week-title">
          <strong>${escapeHtml(fmtRange(monday))}</strong>
          <span class="count">${dishes.length} dish${dishes.length === 1 ? "" : "es"}${isTarget ? " · adding here" : ""}</span>
        </div>
        <div class="week-head-actions">
          <button class="ghost add-here">＋ Add dishes</button>
          <button class="ghost mk-grocery"${dishes.length ? "" : " disabled"}>🛒 List</button>
        </div>
      </div>
      <div class="week-cards card-grid"></div>
      <div class="week-empty${dishes.length ? " hidden" : ""}">No dishes yet — tap “＋ Add dishes”.</div>`;

    const cards = block.querySelector(".week-cards");
    dishes.forEach((r) => cards.appendChild(recipeCard(r, "plan", key)));

    block.querySelector(".add-here").addEventListener("click", () => {
      targetWeek = key;
      updateTargetBanner();
      activateTab("search");
      toast(`Now adding to ${isThisWeek(key) ? "this week" : "week of " + fmtRange(monday)}`);
    });
    const groceryBtn = block.querySelector(".mk-grocery");
    if (dishes.length) {
      groceryBtn.addEventListener("click", () => buildGrocery(key));
    }
    weeksContainer.appendChild(block);
  });
}

// ============================================================
//  Grocery list (per week): combined ingredients + your own items,
//  with persistent, synced check-offs and pantry-staple hiding
// ============================================================
const GROCERY_KEY = "mealPlanner.grocery.v1";
let grocery = loadGrocery(); // { [weekKey]: { checked: {itemKey:true}, extras: [{id,name,checked}] } }
let lastGroceryRecipes = [];
let groceryPushTimer = null;
let staplesExpanded = false; // "Pantry staples" group collapsed by default

function loadGrocery() {
  try {
    const g = JSON.parse(localStorage.getItem(GROCERY_KEY));
    return g && typeof g === "object" && !Array.isArray(g) ? g : {};
  } catch {
    return {};
  }
}
function saveGrocery() {
  localStorage.setItem(GROCERY_KEY, JSON.stringify(grocery));
  scheduleGroceryPush();
}
function scheduleGroceryPush() {
  if (!syncEnabled) return;
  clearTimeout(groceryPushTimer);
  groceryPushTimer = setTimeout(() => {
    fetch("/api/grocery", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grocery }),
    }).catch(() => {});
  }, 700);
}
function weekGrocery(weekKey) {
  const w = (grocery[weekKey] ||= { checked: {}, extras: [], overrides: {} });
  w.checked ||= {};
  w.extras ||= [];
  w.overrides ||= {}; // recipe-item aisle overrides: { itemKey: aisle }
  return w;
}

// Common pantry items most people already have — hidden by default.
const STAPLE_PATTERNS = [
  /^salt$/, /salt and pepper/, /kosher salt/, /sea salt/, /table salt/,
  /^pepper$/, /black pepper/, /white pepper/, /ground pepper/, /peppercorn/,
  /^water$/, /(cold|warm|hot|lukewarm) water/,
  /olive oil/, /vegetable oil/, /canola oil/, /^oil$/, /cooking spray/,
];
const isStaple = (name) => STAPLE_PATTERNS.some((re) => re.test(name.toLowerCase().trim()));

// Sort a manually-added item into a grocery-store section by keyword.
// Ordered: more specific rules first (e.g. "peanut butter" before "butter").
const AISLE_RULES = [
  { aisle: "Household", keywords: ["paper towel", "toilet paper", "napkin", "dish soap", "detergent", "laundry", "foil", "plastic wrap", "cling wrap", "parchment", "trash bag", "garbage bag", "ziploc", "sponge", "cleaner", "bleach", "paper plate", "batteries", "toothpaste", "shampoo", "soap", "tissue", "diaper", "wipes"] },
  { aisle: "Nut butters, Jams, and Honey", keywords: ["peanut butter", "almond butter", "nut butter", "jam", "jelly", "honey", "preserves", "marmalade", "nutella"] },
  { aisle: "Frozen", keywords: ["frozen", "ice cream", "popsicle"] },
  { aisle: "Bakery/Bread", keywords: ["bread", "bagel", "bun", "tortilla", "roll", "croissant", "muffin", "pita", "naan", "baguette"] },
  { aisle: "Cheese", keywords: ["cheese", "cheddar", "mozzarella", "parmesan", "feta", "gouda", "brie", "ricotta"] },
  { aisle: "Milk, Eggs, Other Dairy", keywords: ["milk", "egg", "butter", "yogurt", "yoghurt", "sour cream", "heavy cream", "half and half", "whipping cream", "cream", "margarine", "creamer"] },
  { aisle: "Meat", keywords: ["chicken", "beef", "pork", "turkey", "bacon", "sausage", "ham", "steak", "ground", "lamb", "hot dog", "salami", "pepperoni", "deli"] },
  { aisle: "Seafood", keywords: ["fish", "salmon", "shrimp", "tuna", "cod", "tilapia", "crab", "lobster", "scallop", "seafood"] },
  { aisle: "Beverages", keywords: ["juice", "soda", "coffee", "tea", "lemonade", "kombucha", "seltzer", "sparkling", "drink"] },
  { aisle: "Produce", keywords: ["apple", "banana", "lettuce", "tomato", "onion", "potato", "carrot", "spinach", "cucumber", "avocado", "lemon", "lime", "garlic", "broccoli", "celery", "mushroom", "berry", "grape", "orange", "cilantro", "parsley", "kale", "zucchini", "fruit", "vegetable", "veggie", "bell pepper", "corn", "peas", "green bean", "cabbage", "cauliflower", "ginger", "scallion", "squash", "pear", "peach", "melon", "pineapple", "mango"] },
  { aisle: "Pasta and Rice", keywords: ["pasta", "rice", "noodle", "spaghetti", "quinoa", "macaroni", "couscous", "orzo", "penne"] },
  { aisle: "Baking", keywords: ["flour", "sugar", "baking soda", "baking powder", "vanilla", "yeast", "cocoa", "chocolate chip", "cornstarch"] },
  { aisle: "Cereal", keywords: ["cereal", "oatmeal", "oats", "granola"] },
  { aisle: "Canned and Jarred", keywords: ["canned", "beans", "broth", "stock", "tomato sauce", "tomato paste", "chickpea", "lentil"] },
  { aisle: "Condiments", keywords: ["ketchup", "mustard", "mayo", "dressing", "salsa", "syrup", "bbq", "barbecue", "soy sauce", "hot sauce", "sriracha", "relish", "worcestershire"] },
  { aisle: "Oil, Vinegar, Salad Dressing", keywords: ["oil", "vinegar"] },
  { aisle: "Spices and Seasonings", keywords: ["spice", "cinnamon", "paprika", "cumin", "oregano", "seasoning", "chili powder", "garlic powder", "onion powder"] },
  { aisle: "Alcoholic Beverages", keywords: ["beer", "wine", "vodka", "whiskey", "rum", "tequila", "liquor"] },
  { aisle: "Savory Snacks", keywords: ["chips", "crackers", "popcorn", "pretzel"] },
  { aisle: "Sweet Snacks", keywords: ["cookie", "candy", "chocolate", "brownie", "donut", "cake"] },
  { aisle: "Nuts", keywords: ["almond", "walnut", "cashew", "pecan", "peanut", "pistachio"] },
];
function categorizeItem(name) {
  const n = name.toLowerCase();
  for (const { aisle, keywords } of AISLE_RULES) {
    if (keywords.some((k) => n.includes(k))) return aisle;
  }
  return "Other";
}

// Sections the user can move an item into.
const AISLE_OPTIONS = [
  "Produce", "Milk, Eggs, Other Dairy", "Cheese", "Meat", "Seafood", "Bakery/Bread",
  "Frozen", "Pasta and Rice", "Baking", "Cereal", "Canned and Jarred", "Condiments",
  "Oil, Vinegar, Salad Dressing", "Spices and Seasonings", "Nut butters, Jams, and Honey",
  "Beverages", "Alcoholic Beverages", "Savory Snacks", "Sweet Snacks", "Nuts",
  "Health Foods", "Household", "Other",
];

// A small "⇄" button that expands into an aisle picker when tapped.
function moveControl(currentAisle, applyFn) {
  const wrap = document.createElement("span");
  wrap.className = "move-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "move-btn";
  btn.title = "Move to another section";
  btn.textContent = "⇄";
  btn.addEventListener("click", () => {
    const sel = document.createElement("select");
    sel.className = "aisle-select";
    AISLE_OPTIONS.forEach((a) => {
      const o = document.createElement("option");
      o.value = a;
      o.textContent = a;
      if (a === currentAisle) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => applyFn(sel.value));
    sel.addEventListener("blur", () => {
      if (sel.parentNode === wrap) wrap.replaceChild(btn, sel);
    });
    wrap.replaceChild(sel, btn);
    sel.focus();
  });
  wrap.appendChild(btn);
  return wrap;
}

// Jump to the Grocery tab for a given week (used by the Planner's "List" button).
function buildGrocery(weekKey) {
  groceryWeek = weekKey;
  activateTab("grocery");
}

// Fill the Grocery tab's week picker: this week + next four, plus any weeks
// that already have dishes or grocery items, chronological.
function populateGrocerySelect() {
  const sel = $("#grocerySelect");
  if (!sel) return;
  const weeks = new Set();
  const today = startOfWeek(new Date());
  const thisWeekKey = isoDate(today);
  for (let i = 0; i < WEEKS_SHOWN; i++) {
    weeks.add(isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i * 7)));
  }
  // Only surface this week onward (plus any future weeks that already have data).
  Object.keys(plan).forEach((k) => k >= thisWeekKey && weekDishes(k).length && weeks.add(k));
  Object.keys(grocery).forEach((k) => k >= thisWeekKey && weeks.add(k));

  const target = groceryWeek && weeks.has(groceryWeek) ? groceryWeek : isoDate(today);
  sel.innerHTML = "";
  [...weeks]
    .sort()
    .forEach((k) => {
      const monday = parseKey(k);
      const dishes = weekDishes(k).length;
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent =
        (isThisWeek(k) ? `This week (${fmtRange(monday)})` : fmtRange(monday)) +
        (dishes ? ` — ${dishes} dish${dishes === 1 ? "" : "es"}` : "");
      if (k === target) opt.selected = true;
      sel.appendChild(opt);
    });
}

// Move unchecked self-added items from already-passed weeks into the current/
// upcoming list, so anything you didn't buy follows you forward. Checked-off
// (crossed-out) items stay behind as completed.
function carryForwardExtras(weekKey) {
  const thisWeek = weekKeyOf(new Date());
  if (weekKey < thisWeek) return; // never carry into a past week
  let moved = false;
  Object.keys(grocery).forEach((k) => {
    if (k >= thisWeek) return; // only pull from weeks that have already passed
    const src = grocery[k];
    if (!src) return;
    const staying = [];
    (src.extras || []).forEach((extra) => {
      if (extra.checked) staying.push(extra);
      else {
        extra.carried = true; // mark as rolled over from a previous week
        weekGrocery(weekKey).extras.push(extra);
        moved = true;
      }
    });
    src.extras = staying;
    // Tidy up weeks left with nothing.
    if (
      !src.extras.length &&
      !Object.keys(src.checked || {}).length &&
      !Object.keys(src.overrides || {}).length
    ) {
      delete grocery[k];
    }
  });
  if (moved) saveGrocery();
}

// Load + render the grocery list for a specific week (works even with no dishes).
async function loadGroceryWeek(weekKey) {
  groceryWeek = weekKey;
  carryForwardExtras(weekKey);
  groceryEmpty.classList.add("hidden");
  const sel = $("#grocerySelect");
  if (sel && sel.value !== weekKey) sel.value = weekKey;

  const dishes = weekDishes(weekKey);
  if (!dishes.length) {
    renderGrocery([], weekKey); // shows your own items + "add your own"
    return;
  }
  $("#groceryControls").classList.add("hidden");
  groceryList.innerHTML = `<div class="loading"><div class="spinner"></div>Building your grocery list…</div>`;
  groceryMeta.textContent = "";
  try {
    const ids = dishes.map((r) => r.id).join(",");
    const res = await fetch(`/api/recipes?ids=${encodeURIComponent(ids)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load ingredients");
    renderGrocery(data.recipes, weekKey);
  } catch (err) {
    groceryList.innerHTML = `<div class="empty">😕 ${escapeHtml(err.message)}</div>`;
  }
}
$("#grocerySelect").addEventListener("change", (e) => loadGroceryWeek(e.target.value));

function renderGrocery(recipes, weekKey) {
  lastGroceryRecipes = recipes;
  groceryWeek = weekKey;
  const wk = weekGrocery(weekKey);

  // Combine all ingredients by name + unit.
  const combined = new Map();
  recipes.forEach((recipe) => {
    (recipe.ingredients || []).forEach((ing) => {
      const name = (ing.name || "").trim();
      if (!name) return;
      const unit = (ing.unit || "").trim().toLowerCase();
      const key = `${name.toLowerCase()}|${unit}`;
      if (!combined.has(key)) {
        combined.set(key, { key, name, unit, amount: 0, aisle: ing.aisle || "Other", usedIn: new Set() });
      }
      const entry = combined.get(key);
      entry.amount += Number(ing.amount) || 0;
      entry.usedIn.add(recipe.title);
    });
  });

  groceryList.innerHTML = "";
  $("#groceryControls").classList.remove("hidden");

  // Split into pantry staples (their own collapsible group) and everything else.
  // A manual recategorization (override) pulls an item out of the staples group.
  const byAisle = {};
  const staplesList = [];
  for (const item of combined.values()) {
    const overridden = Boolean(wk.overrides[item.key]);
    if (isStaple(item.name) && !overridden) {
      staplesList.push(item);
      continue;
    }
    const aisle = wk.overrides[item.key] || item.aisle;
    (byAisle[aisle] ||= { extras: [], items: [] }).items.push(item);
  }
  wk.extras.forEach((extra) => {
    const aisle = extra.aisle || categorizeItem(extra.name);
    (byAisle[aisle] ||= { extras: [], items: [] }).extras.push(extra);
  });

  Object.keys(byAisle)
    .sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .forEach((aisle) => {
      const group = byAisle[aisle];
      const section = document.createElement("div");
      section.className = "aisle";
      section.innerHTML = `<h3>${escapeHtml(aisle)}</h3>`;
      group.extras.forEach((extra) => section.appendChild(extraRow(extra, weekKey)));
      group.items
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((item) => section.appendChild(groceryRow(item, weekKey)));
      groceryList.appendChild(section);
    });

  // Collapsible "Pantry staples" group at the bottom.
  if (staplesList.length) {
    const section = document.createElement("div");
    section.className = "aisle staples-group";
    const header = document.createElement("h3");
    header.className = "staples-header";
    header.innerHTML = `<span class="chev">${staplesExpanded ? "▾" : "▸"}</span> Pantry staples <span class="staples-count">(${staplesList.length})</span>`;
    const itemsWrap = document.createElement("div");
    itemsWrap.className = "staples-items" + (staplesExpanded ? "" : " hidden");
    staplesList
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => itemsWrap.appendChild(groceryRow(item, weekKey)));
    header.addEventListener("click", () => {
      staplesExpanded = !staplesExpanded;
      itemsWrap.classList.toggle("hidden", !staplesExpanded);
      header.querySelector(".chev").textContent = staplesExpanded ? "▾" : "▸";
    });
    section.appendChild(header);
    section.appendChild(itemsWrap);
    groceryList.appendChild(section);
  }

  if (!groceryList.children.length) {
    groceryList.innerHTML = `<div class="empty">No items to buy — add your own above.</div>`;
  }

  const weekLabel = isThisWeek(weekKey) ? "this week" : `week of ${fmtRange(parseKey(weekKey))}`;
  const toBuy = combined.size - staplesList.length;
  const staplesNote = staplesList.length
    ? ` · ${staplesList.length} pantry staple${staplesList.length === 1 ? "" : "s"}`
    : "";
  groceryMeta.textContent = `${weekLabel} — ${toBuy} item${toBuy === 1 ? "" : "s"} for ${recipes.length} dish${recipes.length === 1 ? "" : "es"}${staplesNote}. Tap an item to check it off.`;
}

function groceryRow(item, weekKey) {
  const wk = weekGrocery(weekKey);
  const row = document.createElement("div");
  const isChecked = Boolean(wk.checked[item.key]);
  row.className = "grocery-item" + (isChecked ? " checked" : "");
  const id = "gi-" + Math.random().toString(36).slice(2);
  const qty = formatQty(item.amount, item.unit);
  const usedIn = [...item.usedIn].join(", ");
  row.innerHTML = `
    <input type="checkbox" id="${id}" ${isChecked ? "checked" : ""} />
    <label for="${id}">
      <span class="qty">${qty ? qty + " " : ""}</span>${escapeHtml(capitalize(item.name))}
    </label>
    <span class="used" title="Used in: ${escapeHtml(usedIn)}">${escapeHtml(usedIn)}</span>`;
  const cb = row.querySelector("input");
  cb.addEventListener("change", () => {
    row.classList.toggle("checked", cb.checked);
    if (cb.checked) wk.checked[item.key] = true;
    else delete wk.checked[item.key];
    saveGrocery();
  });
  const effectiveAisle = wk.overrides[item.key] || item.aisle;
  row.appendChild(
    moveControl(effectiveAisle, (a) => {
      if (a === item.aisle) delete wk.overrides[item.key];
      else wk.overrides[item.key] = a;
      saveGrocery();
      renderGrocery(lastGroceryRecipes, weekKey);
    })
  );
  return row;
}

function extraRow(extra, weekKey) {
  const wk = weekGrocery(weekKey);
  const row = document.createElement("div");
  row.className = "grocery-item" + (extra.checked ? " checked" : "");
  const id = "ex-" + extra.id;
  row.innerHTML = `
    <input type="checkbox" id="${id}" ${extra.checked ? "checked" : ""} />
    <label for="${id}">${escapeHtml(capitalize(extra.name))}</label>
    <span class="added-badge${extra.carried ? " carried" : ""}">${extra.carried ? "↩ carried over" : "＋ added"}</span>`;
  row.querySelector("input").addEventListener("change", (e) => {
    extra.checked = e.target.checked;
    row.classList.toggle("checked", e.target.checked);
    saveGrocery();
  });

  const actions = document.createElement("span");
  actions.className = "row-actions";
  actions.appendChild(
    moveControl(extra.aisle || categorizeItem(extra.name), (a) => {
      extra.aisle = a;
      saveGrocery();
      renderGrocery(lastGroceryRecipes, weekKey);
    })
  );
  const remove = document.createElement("button");
  remove.className = "extra-remove";
  remove.setAttribute("aria-label", "Remove item");
  remove.textContent = "✕";
  remove.addEventListener("click", () => {
    wk.extras = wk.extras.filter((x) => x.id !== extra.id);
    saveGrocery();
    renderGrocery(lastGroceryRecipes, weekKey);
  });
  actions.appendChild(remove);
  row.appendChild(actions);
  return row;
}

// Add-your-own-item + hide-staples controls.
$("#addItemForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#addItemInput");
  const name = input.value.trim();
  if (!name || !groceryWeek) return;
  weekGrocery(groceryWeek).extras.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name,
    checked: false,
    aisle: categorizeItem(name),
  });
  saveGrocery();
  input.value = "";
  renderGrocery(lastGroceryRecipes, groceryWeek);
});

$("#copyList").addEventListener("click", () => {
  const lines = [];
  document.querySelectorAll("#groceryList .aisle").forEach((aisle) => {
    lines.push(aisle.querySelector("h3").textContent.toUpperCase());
    aisle.querySelectorAll(".grocery-item label").forEach((l) => {
      lines.push("  - " + l.textContent.trim().replace(/\s+/g, " "));
    });
    lines.push("");
  });
  if (!lines.length) return toast("Nothing to copy yet.");
  navigator.clipboard
    .writeText(lines.join("\n"))
    .then(() => toast("Grocery list copied!"))
    .catch(() => toast("Couldn't copy — try Print instead."));
});
$("#printList").addEventListener("click", () => {
  if (!groceryList.children.length) return toast("Nothing to print yet.");
  window.print();
});

// ============================================================
//  Recipe detail modal
// ============================================================
const modal = $("#modal");
const modalBody = $("#modalBody");
$("#modalClose").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});
// Keep the screen awake while a recipe is open (for hands-free cooking).
// Uses the Screen Wake Lock API where supported; silently no-ops otherwise.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* unsupported or denied — ignore */
  }
}
async function releaseWakeLock() {
  try {
    await wakeLock?.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}
// The OS auto-releases the lock when the tab is backgrounded; re-acquire on return.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !modal.classList.contains("hidden")) requestWakeLock();
});

function closeModal() {
  modal.classList.add("hidden");
  modalBody.innerHTML = "";
  releaseWakeLock();
}
async function showRecipe(id) {
  modal.classList.remove("hidden");
  requestWakeLock(); // keep the screen on while viewing/cooking
  modalBody.innerHTML = `<div class="loading"><div class="spinner"></div>Loading recipe…</div>`;
  try {
    const res = await fetch(`/api/recipes?ids=${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    const r = data.recipes[0];
    if (!r) throw new Error("Recipe not found");
    const n = r.nutrition;
    const added = inWeek(targetWeek, r.id);
    modalBody.innerHTML = `
      <img src="${r.image || placeholder()}" alt="${escapeHtml(r.title)}" />
      <h2>${escapeHtml(r.title)}</h2>
      <p class="card-meta">${[
        r.readyInMinutes ? `⏱ ${r.readyInMinutes} min` : "",
        r.servings ? `🍽 ${r.servings} servings` : "",
      ]
        .filter(Boolean)
        .join(" · ")}</p>
      ${r.glutenFree ? '<span class="gf-note">✓ Gluten-free</span>' : ""}
      ${
        n
          ? `<div class="nutri">
        <span><strong>${n.calories ?? "?"}</strong> cal</span>
        <span><strong>${n.protein ?? "?"}g</strong> protein</span>
        <span><strong>${n.carbs ?? "?"}g</strong> carbs</span>
        <span><strong>${n.fat ?? "?"}g</strong> fat</span>
        <em>per serving</em>
      </div>`
          : ""
      }
      <h3>Ingredients</h3>
      <ul class="ing-list">
        ${(r.ingredients || []).map((i) => `<li>${escapeHtml(i.original || i.name)}</li>`).join("")}
      </ul>
      ${
        r.steps && r.steps.length
          ? `<h3>How to make it</h3>
             <ol class="steps">${r.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
          : ""
      }
      ${
        r.sourceUrl
          ? `<p><a href="${r.sourceUrl}" target="_blank" rel="noopener">View original recipe →</a></p>`
          : ""
      }
      <div class="card-actions" style="margin-top:16px">
        <button class="add-btn${added ? " added" : ""}" id="modalAdd">${added ? "✓ Added" : "＋ Add to plan"}</button>
        <button class="ghost fav-btn${isFavorite(r.id) ? " on" : ""}" id="modalFav">${isFavorite(r.id) ? "★ Favorited" : "☆ Favorite"}</button>
      </div>`;
    $("#modalFav").addEventListener("click", () => {
      const nowFav = toggleFavorite({
        id: r.id,
        title: r.title,
        image: r.image,
        readyInMinutes: r.readyInMinutes,
        servings: r.servings,
        calories: n ? n.calories : undefined,
      });
      const b = $("#modalFav");
      b.classList.toggle("on", nowFav);
      b.textContent = nowFav ? "★ Favorited" : "☆ Favorite";
      toast(nowFav ? `Favorited “${r.title}”` : `Unfavorited “${r.title}”`);
    });
    const addBtn = $("#modalAdd");
    addBtn.addEventListener("click", () => {
      if (inWeek(targetWeek, r.id)) return;
      addToWeek(targetWeek, {
        id: r.id,
        title: r.title,
        image: r.image,
        readyInMinutes: r.readyInMinutes,
        servings: r.servings,
        calories: n ? n.calories : undefined,
      });
      addBtn.classList.add("added");
      addBtn.textContent = "✓ Added";
      const label = isThisWeek(targetWeek) ? "this week" : `week of ${fmtRange(parseKey(targetWeek))}`;
      toast(`Added “${r.title}” to ${label}`);
    });
  } catch (err) {
    modalBody.innerHTML = `<div class="empty">😕 ${escapeHtml(err.message)}</div>`;
  }
}

// ============================================================
//  Helpers
// ============================================================
function updatePlanCount() {
  $("#planCount").textContent = totalDishes();
}
function updateFavCount() {
  const el = $("#favCount");
  if (el) el.textContent = favorites.length;
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}
function formatQty(amount, unit) {
  if (!amount || amount <= 0) return unit ? unit : "";
  const rounded = Math.round(amount * 100) / 100;
  const num = Number.isInteger(rounded) ? rounded : parseFloat(rounded.toFixed(2));
  return `${num}${unit ? " " + unit : ""}`;
}
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function placeholder() {
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%' height='100%' fill='#f0ece5'/><text x='50%' y='50%' font-size='48' text-anchor='middle' dy='.35em'>🍽️</text></svg>`
    )
  );
}

// ============================================================
//  Startup
// ============================================================
async function init() {
  updatePlanCount();
  updateFavCount();
  updateTargetBanner();
  renderPlanner();
  try {
    const cfg = await (await fetch("/api/config")).json();
    if (!cfg.hasKey) $("#keyBanner").classList.remove("hidden");
    syncEnabled = Boolean(cfg.storage);
    await initSync();
  } catch {
    /* server not reachable yet — ignore */
  }
  runSearch(); // friendly starter results
}
init();
