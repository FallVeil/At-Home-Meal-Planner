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
  renderHomeIfActive();
  renderCalendarIfActive();
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
    const [pr, fr, gr, nr, tr, er, dr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
      fetch("/api/grocery").then((r) => r.json()),
      fetch("/api/notes").then((r) => r.json()),
      fetch("/api/tracker").then((r) => r.json()),
      fetch("/api/events").then((r) => r.json()),
      fetch("/api/todos").then((r) => r.json()),
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
    if (er.enabled && Array.isArray(er.events)) {
      events = er.events;
      localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
    }
    if (dr.enabled && Array.isArray(dr.todos)) {
      todos = dr.todos;
      localStorage.setItem(TODOS_KEY, JSON.stringify(todos));
    }
    if ($("#tab-home").classList.contains("active")) renderHome();
    if ($("#tab-plan").classList.contains("active")) renderPlanner();
    if (favViewActive()) renderFavorites();
    if ($("#tab-grocery").classList.contains("active") && groceryWeek) {
      renderGrocery(lastGroceryRecipes, groceryWeek);
    }
    if ($("#tab-notes").classList.contains("active")) renderNotesView();
    if ($("#tab-calendar").classList.contains("active")) renderCalendar();
    if ($("#tab-chores").classList.contains("active")) renderActiveChoreView();
  } catch {
    /* offline/transient — keep local copy */
  }
}

// First load: server wins if it has data, otherwise push the local copy up.
async function initSync() {
  if (!syncEnabled) return;
  try {
    const [pr, fr, gr, nr, tr, er, dr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
      fetch("/api/grocery").then((r) => r.json()),
      fetch("/api/notes").then((r) => r.json()),
      fetch("/api/tracker").then((r) => r.json()),
      fetch("/api/events").then((r) => r.json()),
      fetch("/api/todos").then((r) => r.json()),
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
    if (er.enabled) {
      const serverEvents = er.events || [];
      if (serverEvents.length) {
        events = serverEvents;
        localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
      } else if (events.length) {
        scheduleEventsPush();
      }
    }
    if (dr.enabled) {
      const serverTodos = dr.todos || [];
      if (serverTodos.length) {
        todos = serverTodos;
        localStorage.setItem(TODOS_KEY, JSON.stringify(todos));
      } else if (todos.length) {
        scheduleTodosPush();
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

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});
// Meal Planner sub-nav (Planner / Find Recipes / Grocery List), one row per panel.
document.querySelectorAll(".meal-nav .chip").forEach((chip) => {
  chip.addEventListener("click", () => activateTab(chip.dataset.mv));
});

// Drag-to-scroll the tab strip with a mouse (touch already scrolls natively).
(function enableTabDragScroll() {
  const strip = document.querySelector(".tabs");
  if (!strip) return;
  let down = false, startX = 0, startScroll = 0, moved = false;
  strip.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") return;
    down = true;
    moved = false;
    startX = e.clientX;
    startScroll = strip.scrollLeft;
    strip.setPointerCapture(e.pointerId);
  });
  strip.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 4) moved = true;
    strip.scrollLeft = startScroll - dx;
  });
  const end = (e) => {
    if (!down) return;
    down = false;
    try { strip.releasePointerCapture(e.pointerId); } catch {}
  };
  strip.addEventListener("pointerup", end);
  strip.addEventListener("pointercancel", end);
  // Swallow the click that follows a real drag so it doesn't switch tabs.
  strip.addEventListener(
    "click",
    (e) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    },
    true
  );
})();

// ------------------------------------------------------------
//  Back-button / in-app history
//  Phone Back/swipe would otherwise close the whole app. We keep the
//  Home dashboard as a "home" base entry and push a history entry whenever we
//  leave it, so Back returns here first and only exits from home.
// ------------------------------------------------------------
const HOME_TAB = "home";
const MEAL_VIEWS = ["plan", "search", "grocery"]; // sub-views under the "Meal Planner" tab
let currentTab = HOME_TAB;
let mealView = "plan"; // last-used Meal Planner sub-view

// Sync the active state of the shared Meal Planner sub-nav (one chip-row per panel).
function setMealView(mv) {
  mealView = mv;
  document
    .querySelectorAll(".meal-nav .chip")
    .forEach((b) => b.classList.toggle("active", b.dataset.mv === mv));
}

function activateTab(name, fromHistory = false) {
  // "Meal Planner" is a group tab — open the last-used sub-view under it.
  if (name === "mealplan") name = mealView || "plan";
  const isMeal = MEAL_VIEWS.includes(name);
  if (!fromHistory) {
    const atHome = !history.state || history.state.tab === HOME_TAB;
    if (name === HOME_TAB) {
      // Going home: step back to the base entry so Back stays in sync.
      if (!atHome) {
        history.back(); // popstate will render the home tab
        return;
      }
      history.replaceState({ tab: HOME_TAB }, "");
    } else if (atHome) {
      history.pushState({ tab: name }, ""); // leaving home → Back returns here
    } else {
      history.replaceState({ tab: name }, ""); // hop between non-home tabs
    }
  }
  currentTab = name;
  const topTab = isMeal ? "mealplan" : name; // group meal sub-views under one tab
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === topTab));
  document
    .querySelectorAll(".panel")
    .forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (isMeal) setMealView(name);
  if (name === "home") {
    renderHome();
    refreshFromServer();
  }
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
  if (name === "calendar") {
    renderCalendar();
    refreshFromServer();
  }
  if (name === "notes") {
    renderNotesView();
    refreshFromServer();
  }
  if (name === "chores") {
    renderActiveChoreView();
    refreshFromServer();
  }
}

// Any open full-screen overlay (recipe detail / note editor). Back closes
// these before it touches the tab navigation.
function anyOverlayOpen() {
  return (
    !$("#modal").classList.contains("hidden") ||
    !$("#noteEditor").classList.contains("hidden") ||
    !$("#dayEditor").classList.contains("hidden") ||
    !$("#quadModal").classList.contains("hidden") ||
    !$("#todoEditor").classList.contains("hidden")
  );
}
// Close only the top-most overlay. Overlays can stack — e.g. the quadrant
// pop-up with a task editor on top — and each has its own history entry, so a
// single Back peels off one layer at a time. Order = top of the stack first.
function closeOpenOverlays() {
  if (!$("#todoEditor").classList.contains("hidden")) return closeTodoEditor();
  if (!$("#noteEditor").classList.contains("hidden")) return closeNoteEditor();
  // The day pop-up peels form → list before it closes.
  if (!$("#dayEditor").classList.contains("hidden") && dayEditorMode === "form")
    return setDayEditorMode("list");
  if (!$("#dayEditor").classList.contains("hidden")) return closeDayEditor();
  if (!$("#quadModal").classList.contains("hidden")) return closeQuadModal();
  if (!$("#modal").classList.contains("hidden")) return closeModal();
}
// Opening an overlay pushes a history entry (see showRecipe / openNoteEditor) so
// Back closes it. Interactive closes unwind that entry; popstate does the rest.
function pushOverlayState() {
  history.pushState({ tab: currentTab, overlay: true }, "");
}
function dismissOverlays() {
  if (history.state && history.state.overlay) history.back(); // popstate closes it
  else closeOpenOverlays();
}

window.addEventListener("popstate", (e) => {
  // A Back press should first dismiss an open overlay, staying in the app.
  if (anyOverlayOpen()) {
    closeOpenOverlays();
    return;
  }
  activateTab((e.state && e.state.tab) || HOME_TAB, true);
});

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
// Manual grocery items always land in THIS week's list (from the grocery page
// or the Home quick-add card), so nothing gets stranded on a future week.
function addGroceryItem(name) {
  name = (name || "").trim();
  if (!name) return false;
  const wk = weekKeyOf(new Date());
  weekGrocery(wk).extras.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name,
    checked: false,
    aisle: categorizeItem(name),
  });
  saveGrocery();
  return true;
}
$("#addItemForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#addItemInput");
  if (!addGroceryItem(input.value)) return;
  input.value = "";
  const wk = weekKeyOf(new Date());
  // Show this week so the new item is visible (jump there if viewing another week).
  if (groceryWeek === wk) renderGrocery(lastGroceryRecipes, wk);
  else loadGroceryWeek(wk);
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
  // After it lays out, fade + flag any note tall enough to be clamped.
  requestAnimationFrame(() => {
    if (text.scrollHeight > text.clientHeight + 1) text.classList.add("clamped");
  });

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
  pushOverlayState(); // Back closes the editor rather than the app
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
  dismissOverlays();
}
$("#noteEditorSave").addEventListener("click", saveNoteEditor);
$("#noteEditorCancel").addEventListener("click", dismissOverlays);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#noteEditor").classList.contains("hidden")) dismissOverlays();
});

// ============================================================
//  To-do (Eisenhower matrix — a sub-view of the Notes tab)
// ============================================================
// todo = { id, quadrant: 1|2|3|4, title, note, due: "YYYY-MM-DD", done, ts }
const TODOS_KEY = "mealPlanner.todos.v1";
let todos = loadTodos();
let todosPushTimer = null;
let notesSubView = "todo"; // "notes" | "todo" — open on the To-do matrix first
let editingTodoId = null;
let todoQuadrant = 1; // quadrant selected in the editor

function loadTodos() {
  try {
    const t = JSON.parse(localStorage.getItem(TODOS_KEY));
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}
function saveTodos() {
  localStorage.setItem(TODOS_KEY, JSON.stringify(todos));
  scheduleTodosPush();
}
function scheduleTodosPush() {
  if (!syncEnabled) return;
  clearTimeout(todosPushTimer);
  todosPushTimer = setTimeout(() => {
    fetch("/api/todos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todos }),
    }).catch(() => {});
  }, 700);
}

// Swap between the Quick-notes list and the To-do matrix.
function renderNotesView() {
  const isTodo = notesSubView === "todo";
  $("#quickNotes").classList.toggle("hidden", isTodo);
  $("#todoView").classList.toggle("hidden", !isTodo);
  document
    .querySelectorAll("#notesView .chip")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === notesSubView));
  if (isTodo) renderTodo();
  else renderNotes();
}
document.querySelectorAll("#notesView .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    notesSubView = btn.dataset.view;
    renderNotesView();
  });
});

function fmtDue(due) {
  return parseKey(due).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const isOverdue = (due) => Boolean(due) && due < isoDate(new Date());
const todosDueOn = (key) => todos.filter((t) => t.due === key);
// To-do items due within the rolling next 7 days (today through today+6), so
// something happening tomorrow shows up even if a calendar week just rolled over.
function todosDueNext7Days() {
  const today = new Date();
  const startKey = isoDate(today);
  const endKey = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6));
  return todos
    .filter((t) => t.due && t.due >= startKey && t.due <= endKey)
    .sort((a, b) => a.done - b.done || a.due.localeCompare(b.due) || a.quadrant - b.quadrant);
}
// Keep the calendar/home in sync after a to-do changes (they mirror to-do data).
const isTabActive = (id) => $("#" + id).classList.contains("active");
function renderHomeIfActive() {
  if (isTabActive("tab-home")) renderHome();
}
function renderCalendarIfActive() {
  if (isTabActive("tab-calendar")) renderCalendar();
}
function afterTodosChanged() {
  renderTodo();
  renderQuadModalIfOpen();
  renderCalendarIfActive();
  renderHomeIfActive();
}
const QUAD_LABELS = {
  1: "Urgent & Important",
  2: "Not Urgent & Important",
  3: "Urgent & Unimportant",
  4: "Not Urgent & Unimportant",
};
const QUAD_ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV" };
const quadTodos = (q) =>
  todos
    .filter((t) => t.quadrant === q)
    .sort((a, b) => a.done - b.done || (a.ts || 0) - (b.ts || 0));

// The 2x2 grid shows a compact preview of each quadrant; tapping the quadrant
// opens the pop-up where tasks are added and edited.
function renderTodo() {
  [1, 2, 3, 4].forEach((q) => {
    const wrap = $("#quadItems" + q);
    if (!wrap) return;
    wrap.innerHTML = "";
    quadTodos(q).forEach((t) => wrap.appendChild(todoPreviewRow(t)));
  });
}

function noteGlyph() {
  return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 11h16M4 16h10"/></svg>`;
}

// Shared checkbox: toggles done and stops the tap from bubbling to the quad.
function todoCheck(t) {
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "todo-check";
  cb.checked = Boolean(t.done);
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    t.done = cb.checked;
    saveTodos();
    afterTodosChanged();
  });
  return cb;
}

// Compact grid row: title + due chip + a note indicator. No per-row click —
// taps bubble up to the quadrant, which opens the pop-up.
function todoPreviewRow(t) {
  const row = document.createElement("div");
  row.className = "todo-item" + (t.done ? " done" : "");
  const body = document.createElement("div");
  body.className = "todo-body";
  const title = document.createElement("div");
  title.className = "todo-title";
  title.textContent = t.title;
  body.appendChild(title);
  if (t.due || t.note) {
    const meta = document.createElement("div");
    meta.className = "todo-meta";
    if (t.due) {
      const due = document.createElement("span");
      due.className = "todo-due" + (isOverdue(t.due) && !t.done ? " overdue" : "");
      due.textContent = fmtDue(t.due);
      meta.appendChild(due);
    }
    if (t.note) {
      const glyph = document.createElement("span");
      glyph.className = "todo-noteicon";
      glyph.title = "Has notes";
      glyph.innerHTML = noteGlyph();
      meta.appendChild(glyph);
    }
    body.appendChild(meta);
  }
  row.append(todoCheck(t), body);
  return row;
}

// Full row for the quadrant pop-up: title + notes (faded if long) + due.
// Tapping the body opens the task editor.
function todoRow(t) {
  const row = document.createElement("div");
  row.className = "todo-item" + (t.done ? " done" : "");
  const body = document.createElement("div");
  body.className = "todo-body";
  const title = document.createElement("div");
  title.className = "todo-title";
  title.textContent = t.title;
  body.appendChild(title);
  if (t.note) {
    const note = document.createElement("div");
    note.className = "todo-note";
    note.textContent = t.note;
    // After layout, fade any note too long to fit (tap opens the full text).
    requestAnimationFrame(() => {
      if (note.scrollHeight > note.clientHeight + 1) note.classList.add("clamped");
    });
    body.appendChild(note);
  }
  if (t.due) {
    const meta = document.createElement("div");
    meta.className = "todo-meta";
    const due = document.createElement("span");
    due.className = "todo-due" + (isOverdue(t.due) && !t.done ? " overdue" : "");
    due.textContent = fmtDue(t.due);
    meta.appendChild(due);
    body.appendChild(meta);
  }
  body.addEventListener("click", () => openTodoEditor(t.quadrant, t.id));
  row.append(todoCheck(t), body);
  return row;
}

// ---- Expanded quadrant pop-up ----
let openQuadModalQ = null; // which quadrant the pop-up is showing (null = closed)
function openQuadModal(q) {
  openQuadModalQ = q;
  $("#quadModal .day-editor-card").className = "day-editor-card q" + q;
  $("#quadModalTitle").innerHTML =
    `<span class="quad-badge">${QUAD_ROMAN[q]}</span><span>${QUAD_LABELS[q]}</span>`;
  renderQuadModal();
  $("#quadModal").classList.remove("hidden");
  pushOverlayState(); // Back closes the pop-up rather than the app
}
function closeQuadModal() {
  $("#quadModal").classList.add("hidden");
  openQuadModalQ = null;
}
function renderQuadModal() {
  if (openQuadModalQ == null) return;
  const wrap = $("#quadModalItems");
  wrap.innerHTML = "";
  const items = quadTodos(openQuadModalQ);
  items.forEach((t) => wrap.appendChild(todoRow(t)));
  $("#quadModalEmpty").classList.toggle("hidden", items.length > 0);
}
function renderQuadModalIfOpen() {
  if (openQuadModalQ != null && !$("#quadModal").classList.contains("hidden")) renderQuadModal();
}
// Tap a quadrant to expand it; the task editor stacks on top of the pop-up.
document.querySelectorAll(".matrix-grid .quad").forEach((el) => {
  el.addEventListener("click", () => openQuadModal(Number(el.dataset.q)));
});
$("#quadModalAdd").addEventListener("click", () => openTodoEditor(openQuadModalQ || 1));
$("#quadModalClose").addEventListener("click", dismissOverlays);
$("#quadModal").addEventListener("click", (e) => {
  if (e.target === $("#quadModal")) dismissOverlays();
});
// Escape closes the pop-up — but only when the task editor isn't stacked on top
// of it (that editor has its own Escape handler), so one press peels one layer.
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    !$("#quadModal").classList.contains("hidden") &&
    $("#todoEditor").classList.contains("hidden")
  ) {
    dismissOverlays();
  }
});

// One "Add task" bubble at the top opens the editor, defaulting to the last
// quadrant used (the editor's quadrant picker lets you place it anywhere).
$("#todoAdd").addEventListener("click", () => openTodoEditor(todoQuadrant || 1));

// ---- To-do item editor ----
function openTodoEditor(quadrant, id = null) {
  editingTodoId = id;
  const existing = id ? todos.find((t) => t.id === id) : null;
  setTodoQuadrant(existing ? existing.quadrant : quadrant);
  $("#todoTitleInput").value = existing ? existing.title : "";
  $("#todoNoteInput").value = existing ? existing.note || "" : "";
  $("#todoDueInput").value = existing ? existing.due || "" : "";
  $("#todoEditorTitle").textContent = existing ? "Edit task" : "New task";
  $("#todoDeleteBtn").classList.toggle("hidden", !existing);
  $("#todoEditor").classList.remove("hidden");
  pushOverlayState(); // Back closes the editor rather than the app
  if (!existing) $("#todoTitleInput").focus();
}
function closeTodoEditor() {
  $("#todoEditor").classList.add("hidden");
  editingTodoId = null;
}
function setTodoQuadrant(q) {
  todoQuadrant = q;
  document
    .querySelectorAll("#todoQuadrant .quad-opt")
    .forEach((b) => b.classList.toggle("on", Number(b.dataset.q) === q));
}
document.querySelectorAll("#todoQuadrant .quad-opt").forEach((b) => {
  b.addEventListener("click", () => setTodoQuadrant(Number(b.dataset.q)));
});
function saveTodoEditor() {
  const title = $("#todoTitleInput").value.trim();
  if (!title) return $("#todoTitleInput").focus();
  const note = $("#todoNoteInput").value.trim();
  const due = $("#todoDueInput").value || "";
  if (editingTodoId) {
    const t = todos.find((x) => x.id === editingTodoId);
    if (t) {
      t.title = title;
      t.note = note;
      t.due = due;
      t.quadrant = todoQuadrant;
    }
  } else {
    todos.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      quadrant: todoQuadrant,
      title,
      note,
      due,
      done: false,
      ts: Date.now(),
    });
  }
  saveTodos();
  afterTodosChanged();
  dismissOverlays();
}
$("#todoEditorSave").addEventListener("click", saveTodoEditor);
$("#todoEditorCancel").addEventListener("click", dismissOverlays);
// Tapping the dimmed backdrop (outside the card) closes the pop-up.
$("#todoEditor").addEventListener("click", (e) => {
  if (e.target === $("#todoEditor")) dismissOverlays();
});
$("#todoDueClear").addEventListener("click", () => ($("#todoDueInput").value = ""));
$("#todoDeleteBtn").addEventListener("click", () => {
  if (!editingTodoId) return;
  todos = todos.filter((t) => t.id !== editingTodoId);
  saveTodos();
  afterTodosChanged();
  dismissOverlays();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#todoEditor").classList.contains("hidden")) dismissOverlays();
});

// ============================================================
//  Calendar (month grid; events tagged to Andrew / Katie / Both)
// ============================================================
// event = { id, date: "YYYY-MM-DD", title, person: "0" | "1" | "both", time?: "HH:MM" }
const EVENTS_KEY = "mealPlanner.events.v1";
let events = loadEvents();
let eventsPushTimer = null;
let calMonth = startOfMonth(new Date()); // first of the month currently on screen
let dayEditorDate = null; // which day the editor is open for
let dayEditorMode = "list"; // "list" (events + Add button) | "form" (add/edit prompts)
let editingEventId = null; // event being edited (null = adding new)
let eventPerson = "0"; // selected person in the add/edit form

function loadEvents() {
  try {
    const e = JSON.parse(localStorage.getItem(EVENTS_KEY));
    return Array.isArray(e) ? e : [];
  } catch {
    return [];
  }
}
function saveEvents() {
  localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  scheduleEventsPush();
}
function scheduleEventsPush() {
  if (!syncEnabled) return;
  clearTimeout(eventsPushTimer);
  eventsPushTimer = setTimeout(() => {
    fetch("/api/events", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    }).catch(() => {});
  }, 700);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// Does a (possibly recurring) event land on this day? A recurrence is anchored
// at the event's own `date` and never fires before it.
function occursOn(e, dateKey) {
  const rep = e.repeat || "none";
  if (rep === "none") return e.date === dateKey;
  if (dateKey < e.date) return false;
  const d = parseKey(dateKey);
  const start = parseKey(e.date);
  switch (rep) {
    case "daily":
      return true;
    case "weekly":
      return d.getDay() === start.getDay();
    case "monthly":
      return d.getDate() === start.getDate();
    case "monthdays":
      return Array.isArray(e.days) && e.days.includes(d.getDate());
    default:
      return e.date === dateKey;
  }
}
// Events for a given day, sorted by time (untimed last), then title.
function eventsOnDay(dateKey) {
  return events
    .filter((e) => occursOn(e, dateKey))
    .sort((a, b) => {
      const ta = a.time || "99:99";
      const tb = b.time || "99:99";
      return ta === tb ? (a.title || "").localeCompare(b.title || "") : ta.localeCompare(tb);
    });
}
// Human-readable summary of a recurrence rule, for chips/rows.
const WEEKDAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function repeatSummary(e) {
  switch (e.repeat) {
    case "daily":
      return "Every day";
    case "weekly":
      return "Every " + WEEKDAYS_FULL[parseKey(e.date).getDay()];
    case "monthly":
      return "Monthly on the " + ordinal(parseKey(e.date).getDate());
    case "monthdays":
      return "Monthly on the " + (e.days || []).map(ordinal).join(" & ");
    default:
      return "";
  }
}
// Small A/K "bubble(s)" matching the chores visual.
function personBubbles(person) {
  if (person === "both") return `<span class="pbubble a">A</span><span class="pbubble k">K</span>`;
  if (person === "1") return `<span class="pbubble k">K</span>`;
  return `<span class="pbubble a">A</span>`;
}
const personClass = (p) => (p === "both" ? "p-both" : p === "1" ? "p-k" : "p-a");
function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${ap}` : `${h12}${ap}`;
}
// Three scrolling selects — hour, minute (15-min steps), AM/PM — so a time is
// quick to set without a free-form clock. An empty hour ("–") means "no time".
const MINUTE_STEPS = ["00", "15", "30", "45"];
function buildEventTimeOptions() {
  const hSel = $("#eventHour");
  if (!hSel) return;
  const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  hSel.innerHTML =
    `<option value="">–</option>` + hours.map((n) => `<option value="${n}">${n}</option>`).join("");
  $("#eventMinute").innerHTML = MINUTE_STEPS.map((m) => `<option value="${m}">${m}</option>`).join("");
  $("#eventAmPm").innerHTML = `<option value="AM">AM</option><option value="PM">PM</option>`;
}
// Read the three selects back into a stored 24-hour "HH:MM" (or "" for no time).
function getEventTime() {
  const h = $("#eventHour").value;
  if (!h) return "";
  let H = parseInt(h, 10) % 12; // 12 → 0
  if ($("#eventAmPm").value === "PM") H += 12;
  return `${String(H).padStart(2, "0")}:${$("#eventMinute").value}`;
}
// Load a stored "HH:MM" into the three selects (blank = no time).
function setEventTime(t) {
  const hSel = $("#eventHour");
  const mSel = $("#eventMinute");
  const aSel = $("#eventAmPm");
  if (!t) {
    hSel.value = "";
    mSel.value = "00";
    aSel.value = "AM";
    return;
  }
  const [H, M] = t.split(":").map(Number);
  const h12 = H % 12 === 0 ? 12 : H % 12;
  hSel.value = String(h12);
  const mStr = String(M).padStart(2, "0");
  mSel.value = MINUTE_STEPS.includes(mStr) ? mStr : "00"; // snap off-grid legacy times
  aSel.value = H < 12 ? "AM" : "PM";
}

// Recurrence controls. The "days of month" text box only shows for that mode.
function syncRepeatDaysVisibility() {
  const sel = $("#eventRepeat");
  const box = $("#eventRepeatDays");
  if (!sel || !box) return;
  box.classList.toggle("hidden", sel.value !== "monthdays");
}
function setEventRepeat(repeat, days) {
  const sel = $("#eventRepeat");
  if (!sel) return;
  sel.value = repeat && repeat !== "none" ? repeat : "none";
  $("#eventRepeatDays").value = Array.isArray(days) ? days.join(", ") : "";
  syncRepeatDaysVisibility();
}
// Parse the free-text "days of month" box into a sorted, de-duped 1–31 list.
function parseMonthDays(str) {
  const days = (str || "")
    .split(/[\s,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
  return [...new Set(days)].sort((a, b) => a - b);
}
// Read the repeat controls back into { repeat, days }.
function getEventRepeat() {
  const sel = $("#eventRepeat");
  const repeat = sel ? sel.value : "none";
  if (repeat === "monthdays") {
    const days = parseMonthDays($("#eventRepeatDays").value);
    // No valid days entered → treat as non-recurring rather than an empty rule.
    return days.length ? { repeat, days } : { repeat: "none", days: [] };
  }
  return { repeat, days: [] };
}

// A single optional emoji shown before the event title. Quick-pick buttons fill
// the box; the box itself also accepts any emoji from the keyboard.
// Searchable emoji set — each entry is [emoji, "space separated keywords"].
// Broad but curated: enough to cover everyday events without shipping a huge DB.
const EMOJI_DATA = [
  ["🙂", "smile happy face"], ["😀", "grin happy smile"], ["😍", "love heart eyes"],
  ["😎", "cool sunglasses"], ["🥳", "party celebrate hooray"], ["😴", "sleep tired rest nap"],
  ["🤒", "sick ill fever unwell"], ["🤕", "hurt injured bandage"], ["😢", "sad cry"],
  ["😡", "angry mad"], ["🎉", "party celebrate tada"], ["🎊", "party confetti celebrate"],
  ["🎂", "birthday cake"], ["🍰", "cake dessert slice"], ["🧁", "cupcake dessert"],
  ["🎁", "gift present birthday"], ["🎈", "balloon party"], ["🎀", "bow ribbon gift"],
  ["❤️", "love heart"], ["💛", "yellow heart love"], ["💍", "ring engagement wedding marry"],
  ["💐", "flowers bouquet"], ["🌹", "rose flower love"], ["🌸", "flower blossom spring"],
  ["🎓", "graduation school grad diploma"], ["🏫", "school building"], ["📚", "books study read school"],
  ["✏️", "pencil write school"], ["📝", "note memo write exam test"], ["🧪", "science lab test"],
  ["💼", "work job briefcase business office"], ["🏢", "office building work"], ["💻", "laptop computer work"],
  ["📞", "phone call"], ["📱", "phone mobile"], ["📧", "email mail message"],
  ["📅", "calendar date schedule appointment"], ["📆", "calendar date"], ["⏰", "alarm clock time reminder"],
  ["🕐", "clock time"], ["💰", "money cash pay salary payday"], ["💵", "money cash dollar bill"],
  ["💳", "card credit pay bill"], ["🧾", "receipt bill invoice"], ["🏦", "bank money"],
  ["🩺", "doctor health medical checkup stethoscope"], ["💊", "medicine pill health pharmacy"],
  ["💉", "shot vaccine injection needle"], ["🦷", "tooth dentist teeth"], ["🏥", "hospital medical"],
  ["🧠", "brain mind therapy mental"], ["🧘", "yoga meditate calm relax"], ["🏋️", "gym workout exercise lift"],
  ["🏃", "run running jog exercise"], ["🚴", "bike cycling ride"], ["⚽", "soccer football sport"],
  ["🏀", "basketball sport"], ["🏈", "football sport"], ["⚾", "baseball sport"],
  ["🎾", "tennis sport"], ["🏐", "volleyball sport"], ["🏓", "ping pong table tennis"],
  ["🏊", "swim swimming pool"], ["⛳", "golf sport"], ["🎳", "bowling"],
  ["🥎", "softball sport"], ["🏒", "hockey sport"], ["🎿", "ski skiing snow"],
  ["🏂", "snowboard snow"], ["🛹", "skateboard"], ["🎣", "fishing fish"],
  ["🎯", "target darts goal"], ["🎮", "game gaming video controller"], ["🎲", "dice game board"],
  ["♟️", "chess game strategy"], ["🎨", "art paint craft hobby"], ["🖌️", "paint brush art"],
  ["🎭", "theater drama play show"], ["🎬", "movie film cinema"], ["🎥", "movie camera film"],
  ["📺", "tv television show"], ["🎤", "sing karaoke concert mic music"], ["🎧", "music headphones listen"],
  ["🎵", "music note song"], ["🎶", "music notes song"], ["🎸", "guitar music band"],
  ["🎹", "piano music keyboard"], ["🥁", "drums music band"], ["🎺", "trumpet music"],
  ["🎻", "violin music"], ["🍽️", "dinner meal restaurant food eat"], ["🍴", "food eat meal"],
  ["🍕", "pizza food"], ["🍔", "burger food"], ["🌮", "taco food mexican"],
  ["🍜", "noodles ramen food"], ["🍣", "sushi food japanese"], ["🥗", "salad healthy food"],
  ["🍦", "ice cream dessert"], ["🍩", "donut dessert"], ["🍪", "cookie dessert"],
  ["☕", "coffee cafe drink"], ["🍵", "tea drink"], ["🍺", "beer drink bar"],
  ["🍷", "wine drink"], ["🍸", "cocktail drink bar"], ["🥂", "cheers toast celebrate champagne"],
  ["🍳", "cook breakfast egg food"], ["🥘", "cooking food meal"], ["🛒", "shopping groceries cart store"],
  ["🛍️", "shopping bags store mall"], ["🎄", "christmas holiday xmas tree"], ["🎃", "halloween pumpkin"],
  ["🦃", "thanksgiving turkey"], ["🧨", "firework new year celebrate"], ["🎆", "fireworks celebrate new year"],
  ["🎇", "sparkler fireworks"], ["🕯️", "candle vigil"], ["🪔", "diwali lamp"],
  ["✈️", "flight plane travel trip vacation airport"], ["🛫", "takeoff flight departure travel"],
  ["🛬", "landing flight arrival travel"], ["🧳", "luggage travel trip suitcase"], ["🚗", "car drive trip"],
  ["🚙", "car suv drive"], ["🚕", "taxi cab ride"], ["🚌", "bus transit"],
  ["🚆", "train transit travel"], ["🚇", "subway metro transit"], ["🚢", "cruise ship boat travel"],
  ["⛵", "sailing boat"], ["🏝️", "beach island vacation holiday"], ["🏖️", "beach vacation holiday"],
  ["🏕️", "camping tent outdoors"], ["🏔️", "mountain hike"], ["🥾", "hiking boots trail"],
  ["🗺️", "map travel trip"], ["🧭", "compass navigate travel"], ["🏨", "hotel stay travel"],
  ["🏠", "home house"], ["🏡", "house home garden"], ["🧹", "clean chores sweep"],
  ["🧺", "laundry basket chores"], ["🧼", "clean soap wash"], ["🔧", "fix repair tool wrench"],
  ["🔨", "hammer fix repair build"], ["🪚", "saw diy build"], ["🪛", "screwdriver fix repair"],
  ["🧰", "toolbox repair fix"], ["🚿", "shower bath"], ["🛁", "bath tub"],
  ["🌱", "plant garden grow seedling"], ["🌷", "tulip flower garden spring"], ["🌻", "sunflower garden"],
  ["🐶", "dog pet vet walk"], ["🐱", "cat pet vet"], ["🐾", "pet paws vet animal"],
  ["🐕", "dog pet walk vet"], ["🐟", "fish pet"], ["🦴", "bone dog pet"],
  ["👶", "baby infant newborn"], ["🍼", "baby bottle feed"], ["🧒", "child kid"],
  ["👨‍👩‍👧", "family kids"], ["👴", "grandpa elder family"], ["👵", "grandma elder family"],
  ["💒", "wedding marriage church"], ["👰", "bride wedding"], ["🤵", "groom wedding tux"],
  ["🎫", "ticket event show concert"], ["🎟️", "ticket admission event"], ["📸", "photo camera picture"],
  ["🖼️", "picture frame art photo"], ["📖", "book read reading"], ["📔", "journal notebook diary"],
  ["✅", "done check complete task"], ["⭐", "star favorite important"], ["🔔", "bell reminder notify"],
  ["📌", "pin important note"], ["📍", "location place map"], ["🚩", "flag important deadline"],
  ["🔥", "fire urgent hot streak"], ["💡", "idea lightbulb think"], ["⚡", "energy fast power urgent"],
  ["🌟", "star sparkle special"], ["🎯", "goal target aim"], ["🏆", "trophy win award"],
  ["🥇", "medal first win gold"], ["🎖️", "medal honor award"], ["👏", "clap applause well done"],
  ["🙏", "thanks pray please gratitude"], ["🤝", "handshake meeting deal agreement"], ["👥", "meeting people group"],
  ["🗣️", "talk speak meeting discuss"], ["📢", "announce loud news"], ["🚨", "alert emergency urgent"],
  ["⚙️", "settings gear config"], ["🔑", "key access lock"], ["🔒", "lock secure private"],
  ["☀️", "sun sunny weather day"], ["🌙", "moon night"], ["🌧️", "rain weather"],
  ["❄️", "snow winter cold weather"], ["🌈", "rainbow weather"], ["🌡️", "temperature weather fever"],
];
// Keep only the first emoji-like grapheme; ignore any plain text. Uses grapheme
// segmentation so multi-codepoint emoji (ZWJ sequences like 👨‍👩‍👧, or ones with a
// ️ variation selector like ✈️) survive intact instead of being cut mid-sequence.
function firstEmoji(str) {
  if (!str) return "";
  const s = str.trim();
  if (!s) return "";
  const first =
    typeof Intl !== "undefined" && Intl.Segmenter
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)][0].segment
      : Array.from(s)[0] || "";
  return /\p{Extended_Pictographic}/u.test(first) ? first : "";
}
let selectedEventEmoji = "";
function setEventEmoji(emoji) {
  selectedEventEmoji = firstEmoji(emoji);
  const btn = $("#eventEmojiBtn");
  if (btn) {
    btn.textContent = selectedEventEmoji || "🙂";
    btn.classList.toggle("empty", !selectedEventEmoji);
  }
  document
    .querySelectorAll("#emojiGrid .emoji-pick")
    .forEach((b) => b.classList.toggle("on", b.dataset.emoji === selectedEventEmoji));
}
function getEventEmoji() {
  return selectedEventEmoji;
}
// Build the searchable dropdown: a search box that filters an emoji grid.
function buildEmojiPicker() {
  const grid = $("#emojiGrid");
  if (!grid) return;
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".emoji-pick");
    if (!btn) return;
    setEventEmoji(btn.dataset.emoji);
    closeEmojiPicker();
  });
  $("#emojiSearch").addEventListener("input", (e) => renderEmojiGrid(e.target.value));
  renderEmojiGrid("");
}
function renderEmojiGrid(query) {
  const grid = $("#emojiGrid");
  const term = (query || "").trim().toLowerCase();
  const matches = EMOJI_DATA.filter(([, k]) => !term || k.includes(term));
  grid.innerHTML =
    `<button type="button" class="emoji-pick none" data-emoji="" aria-label="No emoji" title="No emoji">∅</button>` +
    matches
      .map(([e, k]) => `<button type="button" class="emoji-pick" data-emoji="${e}" title="${k}">${e}</button>`)
      .join("") +
    (matches.length ? "" : `<span class="emoji-empty">No emoji found</span>`);
  grid
    .querySelectorAll(".emoji-pick")
    .forEach((b) => b.classList.toggle("on", b.dataset.emoji === selectedEventEmoji));
}
function openEmojiPicker() {
  $("#emojiSearch").value = "";
  renderEmojiGrid("");
  $("#emojiPicker").classList.remove("hidden");
  $("#eventEmojiBtn").setAttribute("aria-expanded", "true");
  $("#emojiSearch").focus();
}
function closeEmojiPicker() {
  $("#emojiPicker").classList.add("hidden");
  $("#eventEmojiBtn").setAttribute("aria-expanded", "false");
}
function toggleEmojiPicker() {
  if ($("#emojiPicker").classList.contains("hidden")) openEmojiPicker();
  else closeEmojiPicker();
}

function renderCalendar() {
  const grid = $("#calGrid");
  if (!grid) return;
  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  $("#calLabel").textContent = `${MONTHS_FULL[month]} ${year}`;

  // 6-week window starting on the Monday on/before the 1st.
  const gridStart = startOfWeek(new Date(year, month, 1));
  const todayKey = isoDate(new Date());
  hideWeekPop();
  grid.innerHTML = "";

  for (let w = 0; w < 6; w++) {
    const rowStart = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7);
    const wkKey = isoDate(rowStart); // this row's Monday = the Planner week key
    const row = document.createElement("div");
    row.className = "cal-week-row";

    // An "R" bubble in the left gutter — tap for that week's planned recipes.
    const dishes = weekDishes(wkKey);
    const bubble = document.createElement("button");
    bubble.type = "button";
    bubble.className = "week-bubble" + (dishes.length ? " has" : "");
    bubble.textContent = "R";
    bubble.title = dishes.length
      ? `${dishes.length} recipe${dishes.length === 1 ? "" : "s"} planned this week`
      : "No recipes planned this week";
    bubble.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleWeekPop(bubble, wkKey);
    });
    row.appendChild(bubble);

    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(rowStart.getFullYear(), rowStart.getMonth(), rowStart.getDate() + dow);
      const key = isoDate(d);
      const cell = document.createElement("div");
      cell.className = "cal-day";
      if (d.getMonth() !== month) cell.classList.add("other-month");
      if (key === todayKey) cell.classList.add("today");

      // Events plus any to-do items due that day (the to-do↔calendar sync).
      const chips = [
        ...eventsOnDay(key).map(
          (e) =>
            `<div class="cal-event ${personClass(e.person)}">${personBubbles(e.person)}<span class="cal-event-title">${e.emoji ? `<span class="ev-emoji">${e.emoji}</span>` : ""}${escapeHtml(e.title)}</span></div>`
        ),
        ...todosDueOn(key).map(
          (t) =>
            `<div class="cal-task q${t.quadrant}${t.done ? " done" : ""}" data-todo-id="${t.id}"><span class="q-dot q${t.quadrant}"></span><span class="cal-event-title">${escapeHtml(t.title)}</span></div>`
        ),
      ];
      const shown = chips.slice(0, 3);
      const more = chips.length - shown.length;
      cell.innerHTML = `
        <div class="cal-daynum">${d.getDate()}</div>
        <div class="cal-events">
          ${shown.join("")}
          ${more > 0 ? `<div class="cal-more">+${more} more</div>` : ""}
        </div>`;
      cell.addEventListener("click", () => openDayEditor(key));
      // Tapping a task chip jumps straight to editing that to-do.
      cell.querySelectorAll(".cal-task").forEach((el) => {
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const t = todos.find((x) => x.id === el.dataset.todoId);
          if (t) openTodoEditor(t.quadrant, t.id);
        });
      });
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
}

function shiftMonth(delta) {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + delta, 1);
  renderCalendar();
}
$("#calPrev").addEventListener("click", () => shiftMonth(-1));
$("#calNext").addEventListener("click", () => shiftMonth(1));
$("#calToday").addEventListener("click", () => {
  calMonth = startOfMonth(new Date());
  renderCalendar();
  openDayEditor(isoDate(new Date()));
});

// ---- Per-week planned-recipes popover ----
let weekPopKey = null;
function hideWeekPop() {
  const pop = $("#weekPop");
  if (pop) pop.classList.add("hidden");
  weekPopKey = null;
}
function toggleWeekPop(anchor, wkKey) {
  const pop = $("#weekPop");
  if (weekPopKey === wkKey && !pop.classList.contains("hidden")) {
    hideWeekPop();
    return;
  }
  weekPopKey = wkKey;
  buildWeekPop(wkKey);
  pop.classList.remove("hidden");
  positionWeekPop(anchor);
}
function buildWeekPop(wkKey) {
  const pop = $("#weekPop");
  const mon = parseKey(wkKey);
  const dishes = weekDishes(wkKey);
  let html = `<div class="wp-head">${isThisWeek(wkKey) ? "This week" : "Week of"} <span>${escapeHtml(fmtRange(mon))}</span></div>`;
  if (dishes.length) {
    html +=
      `<div class="wp-list">` +
      dishes
        .map(
          (r) =>
            `<div class="wp-item"><img src="${r.image || placeholder()}" alt="" loading="lazy" /><span>${escapeHtml(r.title)}</span></div>`
        )
        .join("") +
      `</div>`;
  } else {
    html += `<div class="wp-empty">No dishes planned yet.</div>`;
  }
  // The Planner only shows this week onward, so the shortcut is offered there.
  if (wkKey >= weekKeyOf(new Date())) {
    html += `<button class="wp-open" type="button">${dishes.length ? "Open in Planner" : "Plan this week"} →</button>`;
  }
  pop.innerHTML = html;
  const openBtn = pop.querySelector(".wp-open");
  if (openBtn)
    openBtn.addEventListener("click", () => {
      hideWeekPop();
      goToPlannerWeek(wkKey);
    });
}
function positionWeekPop(anchor) {
  const pop = $("#weekPop");
  const r = anchor.getBoundingClientRect();
  const popW = pop.offsetWidth;
  const popH = pop.offsetHeight;
  const pad = 8;
  // Prefer just right of the bubble; flip to the left if it would overflow.
  let left = r.right + pad;
  if (left + popW > window.innerWidth - pad) left = r.left - popW - pad;
  left = Math.max(pad, Math.min(left, window.innerWidth - popW - pad));
  let top = Math.min(r.top, window.innerHeight - popH - pad);
  top = Math.max(pad, top);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}
function goToPlannerWeek(wkKey) {
  const floor = startOfWeek(new Date());
  let start = startOfWeek(parseKey(wkKey));
  if (start < floor) start = floor;
  windowStart = start;
  if (wkKey >= weekKeyOf(new Date())) targetWeek = wkKey;
  activateTab("plan"); // renderPlanner() runs inside
}
// Dismiss the popover on an outside click or any scroll.
document.addEventListener("click", (e) => {
  const pop = $("#weekPop");
  if (!pop || pop.classList.contains("hidden")) return;
  if (e.target.closest("#weekPop") || e.target.closest(".week-bubble")) return;
  hideWeekPop();
});
window.addEventListener("scroll", () => hideWeekPop(), true);

// ---- Day detail / event editor ----
function openDayEditor(dateKey) {
  dayEditorDate = dateKey;
  const d = parseKey(dateKey);
  $("#dayEditorTitle").textContent = d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "long",
    day: "numeric",
  });
  setDayEditorMode("list"); // resets the form and renders the day's events
  $("#dayEditor").classList.remove("hidden");
  pushOverlayState(); // Back closes the editor rather than the app
}
// The pop-up has two modes: "list" shows the day's events + an Add button;
// "form" shows the add/edit prompts. The top-left button and Back peel form→list.
function setDayEditorMode(mode) {
  dayEditorMode = mode;
  const listMode = mode === "list";
  $("#dayEventList").classList.toggle("hidden", !listMode);
  $("#dayAddBtn").parentElement.classList.toggle("hidden", !listMode);
  $("#addEventForm").classList.toggle("hidden", listMode);
  $("#dayEditorClose").textContent = listMode ? "Close" : "Back";
  if (listMode) {
    closeEmojiPicker();
    resetEventForm();
    renderDayEvents();
  } else {
    $("#dayEventEmpty").classList.add("hidden");
  }
}
// Enter form mode to add a brand-new event (Back returns to the list).
function openEventForm() {
  resetEventForm();
  setDayEditorMode("form");
  pushOverlayState();
  $("#addEventTitle").focus();
}
function closeDayEditor() {
  closeEmojiPicker();
  $("#dayEditor").classList.add("hidden");
  dayEditorDate = null;
  editingEventId = null;
}
function renderDayEvents() {
  const list = $("#dayEventList");
  list.innerHTML = "";
  const dayEvents = eventsOnDay(dayEditorDate);
  const dayTodos = todosDueOn(dayEditorDate);
  $("#dayEventEmpty").classList.toggle("hidden", dayEvents.length + dayTodos.length > 0);
  dayEvents.forEach((e) => {
    const row = document.createElement("div");
    row.className = "event-row" + (e.id === editingEventId ? " editing" : "");
    const rep = repeatSummary(e);
    row.innerHTML = `
      <span class="event-bubbles">${personBubbles(e.person)}</span>
      ${e.time ? `<span class="event-time">${fmtTime(e.time)}</span>` : ""}
      <span class="event-title">${e.emoji ? `<span class="ev-emoji">${e.emoji}</span>` : ""}${escapeHtml(e.title)}${rep ? `<span class="event-repeat">↻ ${escapeHtml(rep)}</span>` : ""}</span>
      <button class="event-del" aria-label="Delete event">✕</button>`;
    row.querySelector(".event-title").addEventListener("click", () => startEditEvent(e));
    row.querySelector(".event-bubbles").addEventListener("click", () => startEditEvent(e));
    row.querySelector(".event-del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (e.repeat && e.repeat !== "none" &&
          !confirm("Delete this repeating event and all its occurrences?")) return;
      events = events.filter((x) => x.id !== e.id);
      if (editingEventId === e.id) resetEventForm();
      saveEvents();
      renderDayEvents();
      renderCalendar();
      renderHomeIfActive();
    });
    list.appendChild(row);
  });
  // To-dos due this day (the to-do↔calendar sync) — tap to edit the task.
  dayTodos.forEach((t) => {
    const row = document.createElement("div");
    row.className = "event-row day-todo-row" + (t.done ? " done" : "");
    row.innerHTML = `
      <span class="q-dot q${t.quadrant}"></span>
      <span class="event-title">${escapeHtml(t.title)}</span>
      <span class="day-todo-tag">To-do</span>`;
    row.addEventListener("click", () => {
      const todo = todos.find((x) => x.id === t.id);
      if (todo) openTodoEditor(todo.quadrant, todo.id);
    });
    list.appendChild(row);
  });
}
function startEditEvent(e) {
  editingEventId = e.id;
  setEventPerson(e.person);
  $("#addEventTitle").value = e.title;
  setEventTime(e.time || "");
  setEventRepeat(e.repeat, e.days);
  setEventEmoji(e.emoji || "");
  $("#addEventSubmit").textContent = "Save";
  setDayEditorMode("form"); // show the prompts, populated for editing
  pushOverlayState(); // Back returns to the list
  $("#addEventTitle").focus();
}
function resetEventForm() {
  editingEventId = null;
  setEventPerson("0");
  $("#addEventTitle").value = "";
  setEventTime("");
  setEventRepeat("none");
  setEventEmoji("");
  $("#addEventSubmit").textContent = "Add";
}
function setEventPerson(p) {
  eventPerson = p;
  document
    .querySelectorAll("#eventPerson [data-p]")
    .forEach((b) => b.classList.toggle("on", b.dataset.p === p));
}
document.querySelectorAll("#eventPerson [data-p]").forEach((b) => {
  b.addEventListener("click", () => setEventPerson(b.dataset.p));
});

$("#addEventForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("#addEventTitle").value.trim();
  if (!title || !dayEditorDate) return;
  const time = getEventTime();
  const { repeat, days } = getEventRepeat();
  const emoji = getEventEmoji();
  if (editingEventId) {
    const ev = events.find((x) => x.id === editingEventId);
    if (ev) {
      ev.title = title;
      ev.person = eventPerson;
      ev.time = time;
      ev.repeat = repeat;
      ev.days = days;
      ev.emoji = emoji;
    }
  } else {
    events.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      date: dayEditorDate,
      title,
      person: eventPerson,
      time,
      repeat,
      days,
      emoji,
    });
  }
  saveEvents();
  renderCalendar();
  renderHomeIfActive();
  dismissOverlays(); // form → list, showing the updated events for the day
});
$("#dayAddBtn").addEventListener("click", openEventForm);
// Top-left button: "Back" (form → list) or "Close" (list → shut), via one peel.
$("#dayEditorClose").addEventListener("click", dismissOverlays);
// Tapping the dimmed backdrop (outside the card) closes the pop-up.
$("#dayEditor").addEventListener("click", (e) => {
  if (e.target === $("#dayEditor")) dismissOverlays();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#dayEditor").classList.contains("hidden")) dismissOverlays();
});
buildEventTimeOptions();
buildEmojiPicker();
$("#eventRepeat").addEventListener("change", syncRepeatDaysVisibility);
$("#eventEmojiBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleEmojiPicker();
});
// Clicking anywhere outside the dropdown (or its button) closes it.
document.addEventListener("click", (e) => {
  if ($("#emojiPicker").classList.contains("hidden")) return;
  if (e.target.closest("#emojiPicker") || e.target.closest("#eventEmojiBtn")) return;
  closeEmojiPicker();
});

// ============================================================
//  Home (dashboard — the day's pertinent info in content-sized cards)
// ============================================================
function dashCard(title) {
  const card = document.createElement("div");
  card.className = "dash-card";
  card.innerHTML =
    `<div class="dash-head"><h3>${escapeHtml(title)}</h3></div><div class="dash-body"></div>`;
  return card;
}
function dashEmpty(msg) {
  const d = document.createElement("div");
  d.className = "dash-empty";
  d.textContent = msg;
  return d;
}

function renderHome() {
  const grid = $("#dashGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const todayKey = isoDate(new Date());
  const weekKey = weekKeyOf(new Date());

  // — Grocery quick-add (top of the screen; items go straight to this week) —
  {
    const card = dashCard("Grocery");
    const body = card.querySelector(".dash-body");
    const form = document.createElement("form");
    form.className = "dash-add";
    form.innerHTML =
      `<input type="text" placeholder="Add to this week's list…" autocomplete="off" />` +
      `<button type="submit">Add</button>`;
    const input = form.querySelector("input");
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const name = input.value.trim();
      if (!addGroceryItem(name)) return;
      toast(`Added “${name}” to this week's list`);
      input.value = "";
      if (groceryWeek === weekKey) renderGrocery(lastGroceryRecipes, weekKey);
    });
    body.appendChild(form);
    const link = document.createElement("button");
    link.type = "button";
    link.className = "dash-link";
    link.textContent = "Open grocery list →";
    link.addEventListener("click", () => activateTab("grocery"));
    body.appendChild(link);
    grid.appendChild(card);
  }

  // — This week's recipes (from the Planner) —
  const dishes = weekDishes(weekKey);
  {
    const card = dashCard("Recipes");
    const body = card.querySelector(".dash-body");
    if (!dishes.length) body.appendChild(dashEmpty("No dishes planned this week."));
    else
      dishes.forEach((r) => {
        const row = document.createElement("div");
        row.className = "dash-row recipe-row";
        row.innerHTML = `<img src="${r.image || placeholder()}" alt="" loading="lazy" /><span class="dash-row-title">${escapeHtml(r.title)}</span>`;
        const img = row.querySelector("img");
        img.onerror = () => (img.src = placeholder());
        row.addEventListener("click", () => showRecipe(r.id));
        body.appendChild(row);
      });
    grid.appendChild(card);
  }

  // — Today's calendar events —
  const dayEvents = eventsOnDay(todayKey);
  {
    const card = dashCard("Calendar");
    const body = card.querySelector(".dash-body");
    if (!dayEvents.length) body.appendChild(dashEmpty("Nothing scheduled today."));
    else
      dayEvents.forEach((e) => {
        const row = document.createElement("div");
        row.className = "dash-row event-row-dash";
        row.innerHTML =
          `<span class="event-bubbles">${personBubbles(e.person)}</span>` +
          (e.time ? `<span class="dash-time">${fmtTime(e.time)}</span>` : "") +
          `<span class="dash-row-title">${e.emoji ? `<span class="ev-emoji">${e.emoji}</span>` : ""}${escapeHtml(e.title)}</span>`;
        row.addEventListener("click", () => openDayEditor(todayKey));
        body.appendChild(row);
      });
    grid.appendChild(card);
  }

  // — To-dos due in the next 7 days —
  const dueTodos = todosDueNext7Days();
  {
    const card = dashCard("To-Do");
    const body = card.querySelector(".dash-body");
    if (!dueTodos.length) body.appendChild(dashEmpty("Nothing due in the next 7 days."));
    else
      dueTodos.forEach((t) => {
        const row = document.createElement("div");
        row.className = "dash-row todo-row-dash" + (t.done ? " done" : "");
        row.innerHTML =
          `<span class="q-dot q${t.quadrant}"></span>` +
          `<span class="dash-row-title">${escapeHtml(t.title)}</span>` +
          `<span class="dash-due${isOverdue(t.due) && !t.done ? " overdue" : ""}">${fmtDue(t.due)}</span>`;
        row.addEventListener("click", () => openTodoEditor(t.quadrant, t.id));
        body.appendChild(row);
      });
    grid.appendChild(card);
  }

  // — Chores completed today (green = Andrew, rose = Katie) —
  const doneToday = tracker.items
    .map((it) => ({ it, a: personCount(it, "0", todayKey), k: personCount(it, "1", todayKey) }))
    .filter((x) => x.a + x.k > 0);
  {
    const card = dashCard("Chores");
    const body = card.querySelector(".dash-body");
    if (!doneToday.length) body.appendChild(dashEmpty("No chores logged today yet."));
    else
      doneToday.forEach(({ it, a, k }) => {
        const row = document.createElement("div");
        row.className = "dash-row chore-row-dash";
        row.innerHTML = `<span class="dash-row-title">${escapeHtml(it.name)}</span><span class="dash-pips">${pipBoxes(a, k)}</span>`;
        body.appendChild(row);
      });
    const totalDone = doneToday.reduce((n, x) => n + x.a + x.k, 0);
    if (totalDone) {
      const total = document.createElement("div");
      total.className = "dash-total";
      total.textContent = `${totalDone} completed today`;
      body.appendChild(total);
    }
    grid.appendChild(card);
  }
}

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
  const sel = $("#addChoreCat");
  if (!sel) return;
  const prev = sel.value;
  const cats = [...new Set(tracker.items.map((it) => (it.category || "").trim()).filter(Boolean))];
  CHORE_CAT_ORDER.forEach((c) => {
    if (!cats.includes(c)) cats.push(c);
  });
  cats.sort(choreCatSort);
  // A native <select> works reliably on mobile (unlike an <input list> datalist);
  // the trailing option reveals a text box for a brand-new room.
  sel.innerHTML =
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("") +
    `<option value="__new__">＋ New room…</option>`;
  if (prev && prev !== "__new__" && cats.includes(prev)) sel.value = prev;
  syncNewChoreCat();
}
// Show the "new room" text box only when "＋ New room…" is picked.
function syncNewChoreCat() {
  const isNew = $("#addChoreCat").value === "__new__";
  $("#addChoreCatNew").classList.toggle("hidden", !isNew);
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

$("#addChoreCat").addEventListener("change", () => {
  syncNewChoreCat();
  if ($("#addChoreCat").value === "__new__") $("#addChoreCatNew").focus();
});
$("#addChoreForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#addChoreInput");
  const name = input.value.trim();
  if (!name) return;
  const catSel = $("#addChoreCat");
  const category =
    catSel.value === "__new__" ? $("#addChoreCatNew").value.trim() : catSel.value.trim();
  tracker.items.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name,
    category,
    done: { "0": {}, "1": {} },
  });
  saveTracker();
  input.value = ""; // keep the category so you can add several to the same room
  // If a new room was just created, make it the selected option going forward.
  if (catSel.value === "__new__" && category) {
    renderChoreCatOptions();
    catSel.value = category;
    syncNewChoreCat();
    $("#addChoreCatNew").value = "";
  }
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
$("#modalClose").addEventListener("click", dismissOverlays);
modal.addEventListener("click", (e) => {
  if (e.target === modal) dismissOverlays();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) dismissOverlays();
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
  pushOverlayState(); // Back closes the recipe rather than the app
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
  history.replaceState({ tab: HOME_TAB }, ""); // base "home" entry for the Back button
  updatePlanCount();
  updateFavCount();
  updateNotesCount();
  updateTargetBanner();
  renderPlanner();
  renderCalendar();
  renderHome(); // Home dashboard is the default landing view
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
