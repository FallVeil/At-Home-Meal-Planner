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
    const [pr, fr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
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
    if ($("#tab-plan").classList.contains("active")) renderPlanner();
    if ($("#tab-favorites").classList.contains("active")) renderFavorites();
  } catch {
    /* offline/transient — keep local copy */
  }
}

// First load: server wins if it has data, otherwise push the local copy up.
async function initSync() {
  if (!syncEnabled) return;
  try {
    const [pr, fr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
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
//  Grocery list (per week)
// ============================================================
async function buildGrocery(weekKey) {
  const dishes = weekDishes(weekKey);
  if (!dishes.length) return;
  groceryWeek = weekKey;
  activateTab("grocery");
  groceryEmpty.classList.add("hidden");
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

function renderGrocery(recipes, weekKey) {
  // Combine ingredients across all recipes, keyed on name + unit so
  // "2 cup" + "1 cup" sum, but "cloves" vs "cup" stay separate.
  const combined = new Map();
  recipes.forEach((recipe) => {
    (recipe.ingredients || []).forEach((ing) => {
      const name = (ing.name || "").trim();
      if (!name) return;
      const unit = (ing.unit || "").trim().toLowerCase();
      const key = `${name.toLowerCase()}|${unit}`;
      if (!combined.has(key)) {
        combined.set(key, { name, unit, amount: 0, aisle: ing.aisle || "Other", usedIn: new Set() });
      }
      const entry = combined.get(key);
      entry.amount += Number(ing.amount) || 0;
      entry.usedIn.add(recipe.title);
    });
  });

  if (!combined.size) {
    groceryList.innerHTML = `<div class="empty">No ingredients found for these recipes.</div>`;
    return;
  }

  const byAisle = {};
  for (const item of combined.values()) (byAisle[item.aisle] ||= []).push(item);
  const aisleOrder = Object.keys(byAisle).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });

  groceryList.innerHTML = "";
  aisleOrder.forEach((aisle) => {
    const section = document.createElement("div");
    section.className = "aisle";
    section.innerHTML = `<h3>${escapeHtml(aisle)}</h3>`;
    byAisle[aisle]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => section.appendChild(groceryRow(item)));
    groceryList.appendChild(section);
  });

  const monday = parseKey(weekKey);
  const weekLabel = isThisWeek(weekKey) ? "this week" : `week of ${fmtRange(monday)}`;
  groceryMeta.textContent = `${weekLabel} — ${combined.size} items for ${recipes.length} dish${recipes.length === 1 ? "" : "es"}. Tap an item to check it off.`;
}

function groceryRow(item) {
  const row = document.createElement("div");
  row.className = "grocery-item";
  const id = "gi-" + Math.random().toString(36).slice(2);
  const qty = formatQty(item.amount, item.unit);
  const usedIn = [...item.usedIn].join(", ");
  row.innerHTML = `
    <input type="checkbox" id="${id}" />
    <label for="${id}">
      <span class="qty">${qty ? qty + " " : ""}</span>${escapeHtml(capitalize(item.name))}
    </label>
    <span class="used" title="Used in: ${escapeHtml(usedIn)}">${escapeHtml(usedIn)}</span>`;
  const cb = row.querySelector("input");
  cb.addEventListener("change", () => row.classList.toggle("checked", cb.checked));
  return row;
}

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
function closeModal() {
  modal.classList.add("hidden");
  modalBody.innerHTML = "";
}
async function showRecipe(id) {
  modal.classList.remove("hidden");
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
        r.sourceUrl
          ? `<p><a href="${r.sourceUrl}" target="_blank" rel="noopener">View full recipe & instructions →</a></p>`
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
