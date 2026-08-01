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
const FAV_CATS = ["Breakfast", "Cold Lunch", "Freezer Meal"];
let favFilter = ""; // "" = All
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
    const [pr, fr, gr, nr, tr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
      fetch("/api/grocery").then((r) => r.json()),
      fetch("/api/notes").then((r) => r.json()),
      fetch("/api/tracker").then((r) => r.json()),
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
    if (nr.enabled && Array.isArray(nr.notes)) {
      notes = nr.notes;
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
      updateNotesCount();
    }
    if (tr.enabled && tr.tracker && Array.isArray(tr.tracker.items)) {
      tracker = { items: normalizeChores(tr.tracker.items) };
      localStorage.setItem(TRACKER_KEY, JSON.stringify(tracker));
    }
    if ($("#tab-plan").classList.contains("active")) renderPlanner();
    if (favViewActive()) renderFavorites();
    if ($("#tab-grocery").classList.contains("active") && groceryWeek) {
      renderGrocery(lastGroceryRecipes, groceryWeek);
    }
    if ($("#tab-notes").classList.contains("active")) renderNotes();
    if ($("#tab-chores").classList.contains("active")) renderActiveChoreView();
  } catch {
    /* offline/transient — keep local copy */
  }
}

// First load: server wins if it has data, otherwise push the local copy up.
async function initSync() {
  if (!syncEnabled) return;
  try {
    const [pr, fr, gr, nr, tr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
      fetch("/api/grocery").then((r) => r.json()),
      fetch("/api/notes").then((r) => r.json()),
      fetch("/api/tracker").then((r) => r.json()),
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
    if (nr.enabled) {
      const serverNotes = nr.notes || [];
      if (serverNotes.length) {
        notes = serverNotes;
        localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
      } else if (notes.length) {
        scheduleNotesPush();
      }
    }
    if (tr.enabled) {
      const st = tr.tracker;
      if (st && Array.isArray(st.items) && st.items.length) {
        tracker = { items: normalizeChores(st.items) };
        localStorage.setItem(TRACKER_KEY, JSON.stringify(tracker));
      } else if (tracker.items.length) {
        scheduleTrackerPush();
      }
    }
    updatePlanCount();
    updateFavCount();
    updateNotesCount();
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
  if (name === "search") {
    updateTargetBanner();
    if (favViewActive()) renderFavorites();
    refreshFromServer();
  }
  if (name === "grocery") {
    populateGrocerySelect();
    loadGroceryWeek(groceryWeek || weekKeyOf(new Date()));
    refreshFromServer();
  }
  if (name === "notes") {
    renderNotes();
    refreshFromServer();
  }
  if (name === "chores") {
    renderActiveChoreView();
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
  // Searching from the Favorites view returns to recipe results.
  if (favViewActive()) showFavView(false);
  runSearch();
});

// Recipe rail: category chips + a "★ Favorites" entry that swaps the rail to the
// favorites categories.
document.querySelectorAll("#recipeCats .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (chip.dataset.view === "favorites") {
      showFavView(true);
      renderFavorites();
      return;
    }
    document.querySelectorAll("#recipeCats .chip").forEach((c) => c.classList.toggle("active", c === chip));
    showFavView(false);
    activeCategory = chip.dataset.type;
    runSearch();
  });
});
// Favorites rail: "← Back" to recipes, plus the favorite-category filters.
document.querySelectorAll("#favCats .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (chip.dataset.view === "recipes") {
      showFavView(false);
      return;
    }
    favFilter = chip.dataset.cat || "";
    renderFavorites();
  });
});
// Swap both the main content and the category rail between recipes and favorites.
function showFavView(on) {
  $("#favView").classList.toggle("hidden", !on);
  $("#recipeView").classList.toggle("hidden", on);
  $("#favCats").classList.toggle("hidden", !on);
  $("#recipeCats").classList.toggle("hidden", on);
}
// True when the Favorites view is the one on screen inside Find Recipes.
function favViewActive() {
  return $("#tab-search").classList.contains("active") && !$("#favView").classList.contains("hidden");
}

// Snapshot of the active search so "load more" repeats the same filters.
let currentSearch = null;
let currentResults = []; // accumulated results, for re-rendering on target-week change
let searchOffset = 0;
let searchHasMore = false;

function rerenderSearchResults() {
  if (!currentResults.length) return;
  results.innerHTML = "";
  currentResults.forEach((r) => results.appendChild(recipeCard(r, "search")));
}

async function runSearch() {
  currentSearch = {
    query: $("#searchInput").value.trim(),
    type: activeCategory,
    gf: true, // gluten-free is always enforced (celiac); control hidden
    under500: false,
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
        "Daily recipe limit reached — showing saved recipes from recent browsing.";
      staleNote.classList.remove("hidden");
    } else {
      staleNote.classList.add("hidden");
    }

    const list = data.results || [];
    if (reset) {
      results.innerHTML = "";
      currentResults = list.slice();
    } else {
      currentResults = currentResults.concat(list);
    }
    if (reset && !list.length) {
      results.innerHTML = `<div class="empty">No recipes found. Try a different search or category.</div>`;
    } else {
      list.forEach((r) => results.appendChild(recipeCard(r, "search")));
    }
    searchOffset = data.nextOffset ?? searchOffset + 12;
    searchHasMore = Boolean(data.hasMore);
    renderLoadMore();
  } catch (err) {
    if (reset) {
      $("#staleNote").classList.add("hidden");
      results.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
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

// Weeks offered in the "adding to" picker: this week + next four, plus any
// future week that already has dishes, plus the current target.
function weekPickerOptions() {
  const weeks = new Set();
  const today = startOfWeek(new Date());
  const thisWeekKey = isoDate(today);
  for (let i = 0; i < WEEKS_SHOWN; i++) {
    weeks.add(isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i * 7)));
  }
  Object.keys(plan).forEach((k) => k >= thisWeekKey && weekDishes(k).length && weeks.add(k));
  if (targetWeek) weeks.add(targetWeek);
  return [...weeks].sort();
}

function updateTargetBanner() {
  const banner = $("#targetBanner");
  const opts = weekPickerOptions()
    .map((k) => {
      const dishes = weekDishes(k).length;
      const label =
        (isThisWeek(k) ? `This week (${fmtRange(parseKey(k))})` : fmtRange(parseKey(k))) +
        (dishes ? ` — ${dishes} dish${dishes === 1 ? "" : "es"}` : "");
      return `<option value="${k}"${k === targetWeek ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  banner.innerHTML = `<span class="target-label">Adding to</span><select id="targetSelect" aria-label="Week to add dishes to">${opts}</select>`;
  $("#targetSelect").addEventListener("change", (e) => {
    targetWeek = e.target.value;
    updateTargetBanner();
    rerenderSearchResults();
    if (favViewActive()) renderFavorites(); // update favourite cards' Add/Added state
  });
}

// ============================================================
//  Recipe cards
// ============================================================
function recipeCard(r, context, weekKey) {
  const card = document.createElement("div");
  card.className = "card";
  const meta = [
    r.readyInMinutes ? `${r.readyInMinutes} min` : "",
    r.servings ? `${r.servings} serv` : "",
    r.calories != null ? `${r.calories} cal` : "",
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
    add.textContent = added ? "Added" : "Add to plan";
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
      add.textContent = "Added";
      const label = isThisWeek(targetWeek) ? "this week" : `week of ${fmtRange(parseKey(targetWeek))}`;
      toast(`Added “${r.title}” to ${label}`);
    });
    actions.appendChild(add);
  }

  // Favorite star, overlaid on the image (available in every context).
  const star = document.createElement("button");
  star.className = "fav-star" + (isFavorite(r.id) ? " on" : "");
  star.setAttribute("aria-label", "Toggle favorite");
  star.innerHTML = starIcon(isFavorite(r.id));
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
    star.innerHTML = starIcon(nowFav);
    toast(nowFav ? `Favorited “${r.title}”` : `Unfavorited “${r.title}”`);
    // In the Favorites view, re-render so filters/empty-states stay correct.
    if (!nowFav && favViewActive()) renderFavorites();
  });
  card.appendChild(star);

  // On the Favorites tab, a menu to sort the recipe into a category.
  if (context === "favorites") {
    const wrap = document.createElement("div");
    wrap.className = "fav-cat";
    const sel = document.createElement("select");
    sel.className = "fav-cat-select";
    sel.setAttribute("aria-label", "Favorite category");
    [["", "Uncategorized"], ...FAV_CATS.map((c) => [c, c])].forEach(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      if ((r.favCategory || "") === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      if (sel.value) r.favCategory = sel.value;
      else delete r.favCategory;
      saveFavorites();
      renderFavorites();
    });
    wrap.appendChild(sel);
    card.querySelector(".card-body").appendChild(wrap);
  }

  return card;
}

function syncFavChips() {
  document
    .querySelectorAll("#favCats .chip[data-cat]")
    .forEach((c) => c.classList.toggle("active", (c.dataset.cat || "") === favFilter));
}

function renderFavorites() {
  syncFavChips();
  const list = $("#favList");
  list.innerHTML = "";
  const shown = favorites.filter((r) => !favFilter || (r.favCategory || "") === favFilter);
  if (!shown.length) {
    const empty = $("#favEmpty");
    empty.textContent = favorites.length
      ? "No favorites in this category yet. Use the menu on a card to sort one here."
      : "No favorites yet. Tap the star on any recipe to save it here.";
    empty.classList.remove("hidden");
    return;
  }
  $("#favEmpty").classList.add("hidden");
  shown.forEach((r) => list.appendChild(recipeCard(r, "favorites")));
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
          <button class="ghost add-here">Add dishes</button>
          <button class="ghost mk-grocery"${dishes.length ? "" : " disabled"}>List</button>
        </div>
      </div>
      <div class="week-cards card-grid"></div>
      <div class="week-empty${dishes.length ? " hidden" : ""}">No dishes yet — tap “Add dishes”.</div>`;

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
const groceryCollapsed = new Set(); // collapsed aisle names (expanded by default)

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
// Unbought manual items keep showing on every later list until you check them off.
// Non-destructive: items stay in the week they were added; we just surface the still-
// unchecked ones (from any earlier week) on the week you're viewing, tagged "carried
// over". Nothing is moved, so opening a future week can never strand an item.
// Returns [{ extra, origin }] where `origin` is the week the item actually lives in.
function carriedExtrasFor(weekKey) {
  const thisWeek = weekKeyOf(new Date());
  if (weekKey < thisWeek) return []; // don't clutter past weeks with future todos
  const out = [];
  const seen = new Set((weekGrocery(weekKey).extras || []).map((e) => e.id));
  Object.keys(grocery)
    .sort()
    .forEach((k) => {
      if (k >= weekKey) return; // only pull forward from earlier weeks
      (grocery[k].extras || []).forEach((extra) => {
        if (extra.checked || seen.has(extra.id)) return; // bought, or already shown here
        seen.add(extra.id);
        out.push({ extra, origin: k });
      });
    });
  return out;
}

// Load + render the grocery list for a specific week (works even with no dishes).
async function loadGroceryWeek(weekKey) {
  groceryWeek = weekKey;
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
    groceryList.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
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
  // This week's own manual items, plus still-unbought items carried from earlier weeks.
  const extrasToShow = [
    ...wk.extras.map((extra) => ({ extra, origin: weekKey, carried: Boolean(extra.carried) })),
    ...carriedExtrasFor(weekKey).map(({ extra, origin }) => ({ extra, origin, carried: true })),
  ];
  extrasToShow.forEach((row) => {
    const aisle = row.extra.aisle || categorizeItem(row.extra.name);
    (byAisle[aisle] ||= { extras: [], items: [] }).extras.push(row);
  });

  Object.keys(byAisle)
    .sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .forEach((aisle) => {
      const group = byAisle[aisle];
      const collapsed = groceryCollapsed.has(aisle);
      const count = group.extras.length + group.items.length;
      const section = document.createElement("div");
      section.className = "aisle" + (collapsed ? " collapsed" : "");
      const header = document.createElement("h3");
      header.className = "aisle-head";
      header.innerHTML = `<span class="chev">${collapsed ? "▸" : "▾"}</span> ${escapeHtml(aisle)} <span class="aisle-count">${count}</span>`;
      header.addEventListener("click", () => {
        groceryCollapsed.has(aisle) ? groceryCollapsed.delete(aisle) : groceryCollapsed.add(aisle);
        renderGrocery(lastGroceryRecipes, weekKey);
      });
      const itemsWrap = document.createElement("div");
      itemsWrap.className = "aisle-items";
      group.extras.forEach((row) => itemsWrap.appendChild(extraRow(row.extra, row.origin, row.carried)));
      group.items
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((item) => itemsWrap.appendChild(groceryRow(item, weekKey)));
      section.append(header, itemsWrap);
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

// `originWeek` is the week the item actually lives in (its own week, or the earlier
// week it carried from). `carried` controls the badge; edits always hit the origin.
function extraRow(extra, originWeek, carried) {
  const row = document.createElement("div");
  row.className = "grocery-item" + (extra.checked ? " checked" : "");
  const id = "ex-" + extra.id;
  row.innerHTML = `
    <input type="checkbox" id="${id}" ${extra.checked ? "checked" : ""} />
    <label for="${id}">${escapeHtml(capitalize(extra.name))}</label>
    <span class="added-badge${carried ? " carried" : ""}">${carried ? "carried over" : "added"}</span>`;
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
      renderGrocery(lastGroceryRecipes, groceryWeek);
    })
  );
  const remove = document.createElement("button");
  remove.className = "extra-remove";
  remove.setAttribute("aria-label", "Remove item");
  remove.textContent = "✕";
  remove.addEventListener("click", () => {
    const src = weekGrocery(originWeek);
    src.extras = src.extras.filter((x) => x.id !== extra.id);
    saveGrocery();
    renderGrocery(lastGroceryRecipes, groceryWeek);
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
//  Notes (shared jottings — reminders, ideas, what to restock)
// ============================================================
const NOTES_KEY = "mealPlanner.notes.v1";
let notes = loadNotes();
let notesPushTimer = null;

function loadNotes() {
  try {
    const n = JSON.parse(localStorage.getItem(NOTES_KEY));
    return Array.isArray(n) ? n : [];
  } catch {
    return [];
  }
}
function saveNotes() {
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  updateNotesCount();
  scheduleNotesPush();
}
function scheduleNotesPush() {
  if (!syncEnabled) return;
  clearTimeout(notesPushTimer);
  notesPushTimer = setTimeout(() => {
    fetch("/api/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    }).catch(() => {});
  }, 700);
}
function updateNotesCount() {
  const el = $("#notesCount");
  if (!el) return;
  el.textContent = notes.length;
  el.style.display = notes.length ? "" : "none";
}
function fmtNoteTime(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderNotes() {
  const list = $("#notesList");
  list.innerHTML = "";
  if (!notes.length) {
    $("#notesEmpty").classList.remove("hidden");
    return;
  }
  $("#notesEmpty").classList.add("hidden");
  [...notes]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .forEach((note) => list.appendChild(noteCard(note)));
}

function noteCard(note) {
  const card = document.createElement("div");
  card.className = "note-card";

  const text = document.createElement("div");
  text.className = "note-text";
  text.textContent = note.text;
  text.title = "Tap to edit";
  text.addEventListener("click", () => openNoteEditor(note));

  const foot = document.createElement("div");
  foot.className = "note-foot";
  const time = document.createElement("span");
  time.className = "note-time";
  time.textContent = note.ts ? "updated " + fmtNoteTime(note.ts) : "";
  const del = document.createElement("button");
  del.className = "note-del";
  del.setAttribute("aria-label", "Delete note");
  del.textContent = "✕";
  del.addEventListener("click", () => {
    notes = notes.filter((n) => n.id !== note.id);
    saveNotes();
    renderNotes();
  });
  foot.append(time, del);
  card.append(text, foot);
  return card;
}

// Full-screen note editor (bigger writing space than the inline card).
let editingNoteId = null;
function openNoteEditor(note) {
  editingNoteId = note.id;
  const ta = $("#noteEditorInput");
  ta.value = note.text;
  $("#noteEditor").classList.remove("hidden");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
function closeNoteEditor() {
  $("#noteEditor").classList.add("hidden");
  editingNoteId = null;
}
function saveNoteEditor() {
  const note = notes.find((n) => n.id === editingNoteId);
  if (note) {
    const val = $("#noteEditorInput").value.trim();
    if (!val) notes = notes.filter((n) => n.id !== note.id);
    else {
      note.text = val;
      note.ts = Date.now();
    }
    saveNotes();
    renderNotes();
  }
  closeNoteEditor();
}
$("#noteEditorSave").addEventListener("click", saveNoteEditor);
$("#noteEditorCancel").addEventListener("click", closeNoteEditor);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#noteEditor").classList.contains("hidden")) closeNoteEditor();
});

// ============================================================
//  Chores & habits (daily checklist, per-person, with streaks)
// ============================================================
const TRACKER_KEY = "mealPlanner.tracker.v1";
const PEOPLE = ["Andrew", "Katie"];
const CHORE_CAT_ORDER = ["General", "Living room", "Kitchen", "Bedroom", "Bathroom", "Outside"];
let tracker = loadTracker(); // { items: [{id,name,category,done:{"0":[],"1":[]}}] }
let trackerPushTimer = null;
let choreViewMode = "list"; // "list" | "history"
let historyRange = "week"; // "week" | "month"
const choreCollapsed = new Set(); // collapsed category names in the checklist
let choreCollapseSeeded = false; // rooms start collapsed on first render for easy scanning

// Your chores from House Chores.xlsx, grouped by room (seeded once).
function buildDefaultChores() {
  const data = [
    ["General", ["Vacuum", "Take out trash", "Start laundry", "Fold laundry", "Put away laundry", "Water plants"]],
    ["Living room", ["Pick up", "Dust", "Vacuum"]],
    ["Kitchen", ["Cook", "Clean counters", "Dishes", "Sweep", "Mop", "Vacuum"]],
    ["Bedroom", ["Make bed", "Pick up", "Dust", "Vacuum"]],
    ["Bathroom", ["Pick up", "Wipe surfaces", "Vacuum", "Mop", "Clean toilet", "Clean shower"]],
    ["Outside", ["Pick up poop", "Mow back yard", "Mow front yard", "Weedwhack", "Trim hedges"]],
  ];
  let n = 0;
  const items = [];
  data.forEach(([category, names]) =>
    names.forEach((name) => items.push({ id: "seed-" + n++, name, category, done: { "0": {}, "1": {} } }))
  );
  return items;
}
function maybeSeedChores() {
  if (localStorage.getItem("mealPlanner.tracker.seeded")) return;
  localStorage.setItem("mealPlanner.tracker.seeded", "1");
  if (tracker.items.length) return; // server/local already has data — don't seed
  tracker.items = buildDefaultChores();
  saveTracker();
}

function loadTracker() {
  try {
    const t = JSON.parse(localStorage.getItem(TRACKER_KEY));
    if (t && typeof t === "object" && Array.isArray(t.items)) return { items: normalizeChores(t.items) };
  } catch {
    /* ignore */
  }
  return { items: [] };
}
// Per-person completion COUNTS: done = { "0": { "2026-07-30": 2 }, "1": {…} }.
// A chore can be logged multiple times a day, so each date maps to a tally.
function normalizeChores(items) {
  items.forEach((item) => {
    let done = item.done;
    if (!done || typeof done !== "object" || Array.isArray(done)) done = { "0": {}, "1": {} };
    ["0", "1"].forEach((p) => {
      const v = done[p];
      if (Array.isArray(v)) {
        // old model: a list of dates → one tally each
        const obj = {};
        v.forEach((d) => (obj[d] = (obj[d] || 0) + 1));
        done[p] = obj;
      } else if (!v || typeof v !== "object") {
        done[p] = {};
      }
    });
    // very old single `dates` array → attribute past checks to Andrew
    if (Array.isArray(item.dates)) item.dates.forEach((d) => (done["0"][d] = (done["0"][d] || 0) + 1));
    item.done = done;
    delete item.dates;
    delete item.person;
  });
  return items;
}
function saveTracker() {
  localStorage.setItem(TRACKER_KEY, JSON.stringify(tracker));
  scheduleTrackerPush();
}
function scheduleTrackerPush() {
  if (!syncEnabled) return;
  clearTimeout(trackerPushTimer);
  trackerPushTimer = setTimeout(() => {
    fetch("/api/tracker", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracker }),
    }).catch(() => {});
  }, 700);
}

function personCount(item, p, key) {
  return (item.done && item.done[p] && item.done[p][key]) || 0;
}
function dayCount(item, key) {
  return personCount(item, "0", key) + personCount(item, "1", key);
}
// Union of the days either person logged this chore (for streaks / done-today).
function doneUnion(item) {
  const d = item.done || {};
  return new Set([...Object.keys(d["0"] || {}), ...Object.keys(d["1"] || {})]);
}
const choreDoneToday = (item) => dayCount(item, isoDate(new Date())) > 0;
function choreStreak(item) {
  const set = doneUnion(item);
  const d = new Date();
  if (!set.has(isoDate(d))) d.setDate(d.getDate() - 1); // not done today: streak runs through yesterday
  let s = 0;
  while (set.has(isoDate(d))) {
    s++;
    d.setDate(d.getDate() - 1);
  }
  return s;
}
function incPersonDate(item, p, key) {
  if (!item.done) item.done = { "0": {}, "1": {} };
  if (!item.done[p]) item.done[p] = {};
  item.done[p][key] = (item.done[p][key] || 0) + 1;
  saveTracker();
}
function decPersonDate(item, p, key) {
  if (!item.done || !item.done[p]) return;
  const n = (item.done[p][key] || 0) - 1;
  if (n > 0) item.done[p][key] = n;
  else delete item.done[p][key];
  saveTracker();
}
// Tap = increment; press-and-hold or right-click = decrement (one action per gesture,
// works with mouse and touch). Used for the A/K buttons and the history cells.
function bindCount(el, onInc, onDec) {
  let timer = null;
  let held = false;
  let primary = false;
  let suppress = false;
  const clearHold = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  el.addEventListener("pointerdown", (e) => {
    held = false;
    suppress = false;
    primary = !(e.pointerType === "mouse" && e.button !== 0);
    if (primary)
      timer = setTimeout(() => {
        held = true;
        onDec();
      }, 450);
  });
  el.addEventListener("pointerup", () => {
    clearHold();
    if (primary && !held && !suppress) onInc();
    primary = false;
  });
  el.addEventListener("pointerleave", clearHold);
  el.addEventListener("pointercancel", () => {
    clearHold();
    primary = false;
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    clearHold();
    if (!held) {
      suppress = true;
      onDec();
    }
  });
}
// Filled squares — one per completion, green for Andrew (a) and rose for Katie (k).
function pipBoxes(a, k) {
  const total = a + k;
  if (total <= 0) return "";
  const max = 8;
  let pips = "";
  let shown = 0;
  for (let i = 0; i < a && shown < max; i++, shown++) pips += '<i class="pip a"></i>';
  for (let i = 0; i < k && shown < max; i++, shown++) pips += '<i class="pip k"></i>';
  return total > max ? `${pips}<span class="pipn">${total}</span>` : pips;
}
function flameIcon() {
  return `<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M12 23a7 7 0 0 1-7-7c0-2.2 1.1-4.1 2.6-6C9 8 10 6 10 3.2c3 2 4.4 4 5 6.2C15.6 11.6 19 13.5 19 16a7 7 0 0 1-7 7z"/></svg>`;
}

function renderChores() {
  renderChoreCatOptions();

  const list = $("#choreList");
  list.innerHTML = "";
  const items = tracker.items;
  if (!items.length) {
    $("#choreEmpty").textContent = "No items yet. Add a daily chore or habit to start tracking.";
    $("#choreEmpty").classList.remove("hidden");
    return;
  }
  $("#choreEmpty").classList.add("hidden");

  const groups = {};
  items.forEach((it) => {
    const c = (it.category || "").trim();
    (groups[c] ||= []).push(it);
  });
  if (!choreCollapseSeeded) {
    Object.keys(groups).forEach((cat) => choreCollapsed.add(cat)); // start every room collapsed
    choreCollapseSeeded = true;
  }
  Object.keys(groups)
    .sort(choreCatSort)
    .forEach((cat) => {
      const collapsed = choreCollapsed.has(cat);
      const section = document.createElement("div");
      section.className = "chore-group" + (collapsed ? " collapsed" : "");
      const header = document.createElement("h3");
      header.className = "chore-cat";
      header.innerHTML = `<span class="chev">${collapsed ? "▸" : "▾"}</span> ${escapeHtml(cat || "Other")} <span class="cat-count">${groups[cat].length}</span>`;
      header.addEventListener("click", () => {
        choreCollapsed.has(cat) ? choreCollapsed.delete(cat) : choreCollapsed.add(cat);
        renderChores();
      });
      const itemsWrap = document.createElement("div");
      itemsWrap.className = "chore-items";
      groups[cat].forEach((it) => itemsWrap.appendChild(choreRow(it)));
      section.append(header, itemsWrap);
      list.appendChild(section);
    });
}
function choreCatSort(a, b) {
  const rank = (c) => {
    const i = CHORE_CAT_ORDER.indexOf(c);
    return i !== -1 ? i : c === "" ? 9999 : 5000;
  };
  const ra = rank(a);
  const rb = rank(b);
  return ra !== rb ? ra - rb : a.localeCompare(b);
}
function renderChoreCatOptions() {
  const dl = $("#choreCatList");
  if (!dl) return;
  const cats = [...new Set(tracker.items.map((it) => (it.category || "").trim()).filter(Boolean))];
  CHORE_CAT_ORDER.forEach((c) => {
    if (!cats.includes(c)) cats.push(c);
  });
  dl.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

function renderActiveChoreView() {
  const isList = choreViewMode === "list";
  $("#choreEdit").classList.toggle("hidden", !isList); // "Edit" only applies to the checklist
  if (!isList) {
    $("#choreChecklist").classList.remove("editing");
    $("#choreEdit").classList.remove("on");
    $("#choreEdit").textContent = "Edit";
  }
  if (choreViewMode === "history") renderHistory();
  else renderChores();
}

$("#choreEdit").addEventListener("click", () => {
  const editing = $("#choreChecklist").classList.toggle("editing");
  $("#choreEdit").classList.toggle("on", editing);
  $("#choreEdit").textContent = editing ? "Done" : "Edit";
});

function choreRow(item) {
  const row = document.createElement("div");
  const done = choreDoneToday(item);
  row.className = "chore-item" + (done ? " done" : "");
  const today = isoDate(new Date());
  const streak = choreStreak(item);
  const aN = personCount(item, "0", today);
  const kN = personCount(item, "1", today);
  const pbtn = (p, letter, name, n) =>
    `<button type="button" class="pbtn ${letter.toLowerCase()}${n > 0 ? " on" : ""}" data-p="${p}" aria-label="${escapeHtml(name)} did this${n > 1 ? " (" + n + "×)" : ""}" title="${escapeHtml(name)} — tap to add, hold to remove">${letter}</button>`;
  row.innerHTML = `
    <div class="chore-people">
      ${pbtn("0", "A", PEOPLE[0], aN)}
      ${pbtn("1", "K", PEOPLE[1], kN)}
    </div>
    <span class="chore-name">${escapeHtml(item.name)}</span>
    <span class="chore-marks">${pipBoxes(aN, kN)}</span>
    <span class="chore-tags">
      ${streak >= 3 ? `<span class="streak-pill" title="${streak}-day streak">${flameIcon()} ${streak}</span>` : ""}
    </span>
    <button class="chore-del" aria-label="Delete">✕</button>`;
  row.querySelectorAll(".pbtn").forEach((btn) => {
    const p = btn.dataset.p;
    bindCount(
      btn,
      () => {
        incPersonDate(item, p, today);
        renderChores();
      },
      () => {
        decPersonDate(item, p, today);
        renderChores();
      }
    );
  });
  // Click a filled box to remove that completion (green = Andrew, rose = Katie).
  row.querySelectorAll(".chore-marks .pip").forEach((pip) => {
    pip.title = "Remove one completion";
    pip.addEventListener("click", () => {
      decPersonDate(item, pip.classList.contains("a") ? "0" : "1", today);
      renderChores();
    });
  });
  row.querySelector(".chore-del").addEventListener("click", () => {
    tracker.items = tracker.items.filter((x) => x.id !== item.id);
    saveTracker();
    renderChores();
  });
  return row;
}

$("#addChoreForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#addChoreInput");
  const name = input.value.trim();
  if (!name) return;
  tracker.items.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name,
    category: $("#addChoreCat").value.trim(),
    done: { "0": {}, "1": {} },
  });
  saveTracker();
  input.value = ""; // keep the category so you can add several to the same room
  renderChores();
  input.focus();
});

document.querySelectorAll("#choreView .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    choreViewMode = btn.dataset.view;
    document.querySelectorAll("#choreView .chip").forEach((b) => b.classList.toggle("active", b === btn));
    $("#choreChecklist").classList.toggle("hidden", choreViewMode !== "list");
    $("#choreHistory").classList.toggle("hidden", choreViewMode !== "history");
    renderActiveChoreView();
  });
});
document.querySelectorAll("#historyRange .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    historyRange = btn.dataset.range;
    document.querySelectorAll("#historyRange .chip").forEach((b) => b.classList.toggle("active", b === btn));
    renderHistory();
  });
});

function historyDays() {
  // Week = this Monday–Sunday. Month = this week + the 3 weeks before it (28 days,
  // rolling, ignoring calendar month boundaries).
  const weeks = historyRange === "month" ? 4 : 1;
  const start = startOfWeek(new Date());
  start.setDate(start.getDate() - 7 * (weeks - 1));
  const out = [];
  for (let i = 0; i < 7 * weeks; i++) {
    out.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return out;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Fill style for a cell: solid green (Andrew), solid rose (Katie), or diagonally
// halved when both did it. `showCount` adds each person's own tally (in their half)
// when they did it more than once.
function cellMarkup(aC, kC, showCount) {
  let cls = "";
  if (aC > 0 && kC > 0) cls = "both";
  else if (aC > 0) cls = "a";
  else if (kC > 0) cls = "k";
  let num = "";
  if (showCount) {
    if (aC > 1) num += `<span class="cellnum a">${aC}</span>`;
    if (kC > 1) num += `<span class="cellnum k">${kC}</span>`;
  }
  return { cls, num };
}


function renderHistory() {
  const wrap = $("#historyGrid");
  wrap.innerHTML = "";
  const items = tracker.items;
  if (!items.length) {
    wrap.innerHTML = `<div class="empty">No chores to show yet.</div>`;
    return;
  }
  const days = historyDays();
  const todayKey = isoDate(new Date());
  const WD = ["M", "T", "W", "T", "F", "S", "S"];
  const isMonth = historyRange === "month";
  const showCount = !isMonth; // month view ignores multiple completions

  // History is a read-only overview tallying both people (green = Andrew, rose = Katie).
  // Logging happens on the checklist; the person filter chips were removed.
  const groups = {};
  items.forEach((it) => {
    const c = (it.category || "").trim();
    (groups[c] ||= []).push(it);
  });

  let head = "<thead>";
  if (isMonth) {
    // Row 1: one label per week (its Monday). Row 2 (sticky): weekday initials.
    head += `<tr><th class="hist-name-h"></th>`;
    for (let w = 0; w < days.length / 7; w++) {
      const mon = days[w * 7];
      head += `<th class="hist-week" colspan="7">${MON[mon.getMonth()]} ${mon.getDate()}</th>`;
    }
    head += `</tr><tr class="sticky"><th class="hist-name-h"></th>`;
    days.forEach((d, i) => {
      const isToday = isoDate(d) === todayKey;
      head += `<th class="hist-dnum${isToday ? " today" : ""}${i % 7 === 0 ? " week-start" : ""}">${WD[(d.getDay() + 6) % 7]}</th>`;
    });
    head += `</tr>`;
  } else {
    head += `<tr class="sticky"><th class="hist-name-h"></th>`;
    days.forEach((d) => {
      const isToday = isoDate(d) === todayKey;
      head += `<th class="hist-day${isToday ? " today" : ""}"><span class="wd">${WD[(d.getDay() + 6) % 7]}</span><span class="dn">${d.getDate()}</span></th>`;
    });
    head += `</tr>`;
  }
  head += "</thead>";

  let body = `<tbody>`;
  Object.keys(groups)
    .sort(choreCatSort)
    .forEach((cat) => {
      body += `<tr class="hist-room"><td colspan="${days.length + 1}">${escapeHtml(cat || "Other")}</td></tr>`;
      groups[cat].forEach((it) => {
        body += `<tr><td class="hist-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</td>`;
        days.forEach((d, i) => {
          const key = isoDate(d);
          const isToday = key === todayKey;
          const weekStart = isMonth && i % 7 === 0;
          const { cls, num } = cellMarkup(personCount(it, "0", key), personCount(it, "1", key), showCount);
          body += `<td class="hist-cell${isToday ? " today" : ""}${weekStart ? " week-start" : ""}"><span class="cell${cls ? " " + cls : ""}">${num}</span></td>`;
        });
        body += `</tr>`;
      });
    });
  body += `</tbody>`;

  const table = document.createElement("table");
  table.className = "hist-table " + historyRange + " readonly";
  table.innerHTML = head + body;
  wrap.appendChild(table);
}


$("#addNoteForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#addNoteInput");
  const val = input.value.trim();
  if (!val) return;
  notes.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    text: val,
    ts: Date.now(),
  });
  saveNotes();
  input.value = "";
  renderNotes();
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
        r.readyInMinutes ? `${r.readyInMinutes} min` : "",
        r.servings ? `${r.servings} servings` : "",
      ]
        .filter(Boolean)
        .join(" · ")}</p>
      ${r.glutenFree ? '<span class="gf-note">Gluten-free</span>' : ""}
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
        <button class="add-btn${added ? " added" : ""}" id="modalAdd">${added ? "Added" : "Add to plan"}</button>
        <button class="ghost fav-btn${isFavorite(r.id) ? " on" : ""}" id="modalFav">${isFavorite(r.id) ? "Favorited" : "Favorite"}</button>
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
      b.textContent = nowFav ? "Favorited" : "Favorite";
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
      addBtn.textContent = "Added";
      const label = isThisWeek(targetWeek) ? "this week" : `week of ${fmtRange(parseKey(targetWeek))}`;
      toast(`Added “${r.title}” to ${label}`);
    });
  } catch (err) {
    modalBody.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

// ============================================================
//  Helpers
// ============================================================
function updatePlanCount() {
  const el = $("#planCount");
  if (!el) return;
  const n = totalDishes();
  el.textContent = n;
  el.style.display = n ? "" : "none";
}
function updateFavCount() {
  const el = $("#favCount");
  if (!el) return;
  el.textContent = favorites.length;
  el.style.display = favorites.length ? "" : "none";
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
function starIcon(filled) {
  const d = "M12 3.6l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.6-5 2.6 1-5.6-4.1-4 5.6-.8z";
  return filled
    ? `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="${d}"/></svg>`;
}
function placeholder() {
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%' height='100%' fill='#30322b'/><circle cx='150' cy='96' r='30' fill='none' stroke='#575a50' stroke-width='3'/><line x1='150' y1='118' x2='150' y2='140' stroke='#575a50' stroke-width='3'/></svg>`
    )
  );
}

// ============================================================
//  Startup
// ============================================================
async function init() {
  updatePlanCount();
  updateFavCount();
  updateNotesCount();
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
  maybeSeedChores(); // one-time: load the House Chores list if the tracker is empty
  runSearch(); // friendly starter results
  setTopbarHeight();
}

// Track the sticky app-bar height so the history weekday row can sit just below it.
function setTopbarHeight() {
  const tb = document.querySelector(".topbar");
  if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
}
window.addEventListener("resize", setTopbarHeight);
window.addEventListener("load", setTopbarHeight);

init();
