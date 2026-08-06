// ============================================================
//  Changelog / "What's new"
//  When you ship a change worth announcing, add a new entry at the
//  TOP of this list with a build number one higher than the current
//  highest. The first time each device opens the app after that ships,
//  it sees every entry newer than the one it last acknowledged. Brand-
//  new installs are marked caught-up silently (nothing is "new" to them).
// ============================================================
const CHANGELOG = [
  {
    build: 5,
    date: "August 5, 2026",
    changes: [
      "New live weather card at the top of the Home screen — current temperature and conditions, with a heads-up tag when rain, storms or snow are due soon (e.g. “🌧️ Rain in 2 hr”).",
      "Set your town under Settings → Weather, now its own card; it defaults to your home town and syncs across your devices.",
    ],
  },
  {
    build: 4,
    date: "August 5, 2026",
    changes: [
      "Fixed households leaking into each other: signing a different household into the same phone could show it another family's calendar and events. Households are now kept fully separate, and a phone no longer carries one household's data into the next login.",
      "Cleanup: any data that had leaked into a household it didn't belong to has been removed from those households. Your own household's calendar, events and everything else are untouched.",
      "Recipes saved to your meal plans now stay viewable even after the daily recipe limit is reached or the app restarts — the full ingredients and steps are cached for good.",
      "You can now uncheck a chore on the Assigned board — tap a checked-off chore again to clear it.",
    ],
  },
  {
    build: 3,
    date: "August 4, 2026",
    changes: [
      "Your household can now have up to six people. Add or remove them under Settings → Household Members, each with their own name and colour.",
      "Chores, the calendar, the assigned board and to-dos all show everyone’s colours — assign a chore or tag an event to as many people as you like.",
    ],
  },
  {
    build: 2,
    date: "August 4, 2026",
    changes: [
      "Settings looks tidier: the calendar options now sit in their own card, with a “Household Members” heading above the names.",
      "Chores assigned to both people now show a matching two-tone stripe that wraps the card’s rounded corner, just like a single assignment.",
    ],
  },
  {
    build: 1,
    date: "August 4, 2026",
    changes: [
      "Store mode: sort your grocery list by your store’s real aisle order, so you can shop straight through without backtracking. Turn it on from the Grocery tab.",
      "New “Low-acid” filter in recipe search hides common heartburn/reflux triggers.",
      "Added this “What’s new” note, so you’ll get a quick summary whenever the app updates.",
    ],
  },
];
const APP_BUILD = CHANGELOG.length ? Math.max(...CHANGELOG.map((e) => e.build)) : 0;
const SEEN_BUILD_KEY = "homebase.seenBuild.v1";

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
let lowAcidFilter = false; // opt-in "Low-acid" (GERD) recipe filter
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
// Notes ride along on the favorite object, so they sync like everything else.
// Only favorited recipes can carry a note (unfavoriting drops it).
const favById = (id) => favorites.find((r) => String(r.id) === String(id));
const getFavNote = (id) => (favById(id)?.note || "");
const hasFavNote = (id) => !!getFavNote(id).trim();
function setFavNote(id, text) {
  const f = favById(id);
  if (!f) return;
  const t = String(text).trim();
  if (t) f.note = t;
  else delete f.note;
  saveFavorites();
}

// ---- Household settings (people's names) — synced like the other data ----
// The household holds 2–6 people. People 3–6 are added/removed in Settings; the
// data model is index-based ("0".."5"), so a person is identified by their slot.
const SETTINGS_KEY = "mealPlanner.settings.v1";
const PEOPLE_MIN = 2;
const PEOPLE_MAX = 6;
const DEFAULT_PEOPLE = ["Andrew", "Katie", "Person 3", "Person 4", "Person 5", "Person 6"];
// Each person's colour is household-synced (every phone matches), unlike the
// per-device colour theme. Defaults mirror Theme.PERSON_COLORS in theme.js.
const DEFAULT_COLORS = ["#4f8c62", "#cf8a55", "#5b8fb0", "#b07cc6", "#cc6b7a", "#5fae9c"];
// Home-dashboard weather location (household-synced). Defaults to Alton, IL.
const DEFAULT_WEATHER = { label: "Alton, IL", lat: 38.8906, lon: -90.1843 };
let settings = loadSettings();
let settingsPushTimer = null;
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (s && typeof s === "object") return normalizeSettings(s);
  } catch {
    /* ignore */
  }
  return { people: DEFAULT_PEOPLE.slice(0, PEOPLE_MIN), colors: DEFAULT_COLORS.slice(0, PEOPLE_MIN) };
}
// Coerce to 2–6 non-empty names + matching valid #rrggbb colours. The number of
// people is however many names are stored, clamped to [PEOPLE_MIN, PEOPLE_MAX].
function normalizeSettings(s) {
  const p = Array.isArray(s.people) ? s.people : [];
  const c = Array.isArray(s.colors) ? s.colors : [];
  const n = Math.max(PEOPLE_MIN, Math.min(PEOPLE_MAX, p.length || PEOPLE_MIN));
  const people = [];
  const colors = [];
  for (let i = 0; i < n; i++) {
    const name = typeof p[i] === "string" ? p[i].trim() : "";
    people.push(name || DEFAULT_PEOPLE[i] || `Person ${i + 1}`);
    const v = typeof c[i] === "string" ? c[i].trim().toLowerCase() : "";
    colors.push(/^#[0-9a-f]{6}$/.test(v) ? v : DEFAULT_COLORS[i] || DEFAULT_COLORS[0]);
  }
  const out = { people, colors };
  // Carry the weather location through if it's a valid {label,lat,lon}.
  const w = s.weather;
  if (w && typeof w === "object" && Number.isFinite(w.lat) && Number.isFinite(w.lon)) {
    out.weather = { label: String(w.label || "").slice(0, 60), lat: w.lat, lon: w.lon };
  }
  return out;
}
// The household's saved weather location, falling back to the Alton default.
function weatherLoc() {
  return (settings && settings.weather) || DEFAULT_WEATHER;
}
// How many people the household currently has, and their indices [0..count-1].
function peopleCount() {
  return (settings.people && settings.people.length) || PEOPLE_MIN;
}
function activePeople() {
  return Array.from({ length: peopleCount() }, (_, i) => i);
}
function personColor(i) {
  return (settings.colors && settings.colors[i]) || DEFAULT_COLORS[i] || DEFAULT_COLORS[0];
}
// Readable ink to sit on a person's filled colour (delegates to the theme maths).
function personInk(i) {
  return (window.Theme && window.Theme.readableInk(personColor(i))) || "#20221c";
}
// Inline custom properties every per-person element carries, so the person UI
// scales past two people without a class per slot.
function personStyle(i) {
  return `--pc:${personColor(i)};--pc-ink:${personInk(i)}`;
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  scheduleSettingsPush();
}
function scheduleSettingsPush() {
  if (!syncEnabled) return;
  clearTimeout(settingsPushTimer);
  settingsPushTimer = setTimeout(() => {
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    }).catch(() => {});
  }, 700);
}
// People are stored by index ("0".."5"); names are just display labels.
function personName(i) {
  return (settings.people && settings.people[i]) || DEFAULT_PEOPLE[i] || `Person ${i + 1}`;
}
function personInitial(i) {
  const n = personName(i).trim();
  return (n[0] || "?").toUpperCase();
}
// Rebuild the dynamic person surfaces (calendar legend, event picker, Settings
// editor) and repaint the synced hues. Fires on every data refresh / edit.
function applyPeopleLabels() {
  renderPersonLegend();
  renderEventPersonPicker();
  renderPeopleEditor();
  applyPersonColors(); // keep the synced person hues painted
}
// The calendar's colour key — one chip per household member.
function renderPersonLegend() {
  const wrap = document.getElementById("calLegendPeople");
  if (!wrap) return;
  wrap.innerHTML = activePeople()
    .map(
      (i) =>
        `<span class="legend-item"><span class="pbubble" style="${personStyle(i)}">${escapeHtml(
          personInitial(i)
        )}</span> ${escapeHtml(personName(i))}</span>`
    )
    .join("");
}
// Paint the household's person colours onto the CSS person variables.
function applyPersonColors() {
  if (window.Theme && window.Theme.applyPersonColors) {
    window.Theme.applyPersonColors(settings.colors || []);
  }
}

// ---- Cross-device sync (active only when the server has shared storage) ----
let syncEnabled = false;
let household = "local"; // which household this session belongs to (from /api/config)
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
    const [pr, fr, gr, nr, tr, er, dr, sr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
      fetch("/api/grocery").then((r) => r.json()),
      fetch("/api/notes").then((r) => r.json()),
      fetch("/api/tracker").then((r) => r.json()),
      fetch("/api/events").then((r) => r.json()),
      fetch("/api/todos").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
    ]);
    if (sr.enabled && sr.settings && Array.isArray(sr.settings.people)) {
      settings = normalizeSettings(sr.settings);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      applyPeopleLabels();
    }
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
      tracker = normalizeTracker(tr.tracker);
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
    const [pr, fr, gr, nr, tr, er, dr, sr] = await Promise.all([
      fetch("/api/plan").then((r) => r.json()),
      fetch("/api/favorites").then((r) => r.json()),
      fetch("/api/grocery").then((r) => r.json()),
      fetch("/api/notes").then((r) => r.json()),
      fetch("/api/tracker").then((r) => r.json()),
      fetch("/api/events").then((r) => r.json()),
      fetch("/api/todos").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
    ]);
    if (sr.enabled) {
      const serverPeople = sr.settings && Array.isArray(sr.settings.people) ? sr.settings.people : null;
      // A saved name that differs from the default means the household set it → server wins.
      const serverHasNames = serverPeople && serverPeople.some((n, i) => (n || "").trim() && n.trim() !== DEFAULT_PEOPLE[i]);
      if (serverHasNames) {
        settings = normalizeSettings(sr.settings);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } else if (settings.people.some((n, i) => n !== DEFAULT_PEOPLE[i])) {
        scheduleSettingsPush();
      }
      applyPeopleLabels();
    }
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
        tracker = normalizeTracker(st);
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
    try {
      const str = await fetch("/api/store").then((r) => r.json());
      if (str.enabled && str.store && str.store.stores && Object.keys(str.store.stores).length) {
        storeData = normalizeStore(str.store);
        localStorage.setItem(STORE_KEY, JSON.stringify(storeData));
      } else if (Object.keys(storeData.stores).length) {
        saveStore(); // push our local store layout up if the server has none
      }
    } catch {
      /* ignore */
    }
    updatePlanCount();
    updateFavCount();
    updateNotesCount();
    renderPlanner();
  } catch {
    /* ignore */
  }
}

// This browser stamps which household its cached (localStorage) data belongs to.
// If a DIFFERENT household signs in here, the cached copies must be dropped
// BEFORE initSync runs — otherwise the previous household's plan/events/etc. get
// pushed up into the new household's (empty) server store, leaking data across
// families. Wiping them lets server-wins repopulate the correct household.
const HOUSEHOLD_OWNER_KEY = "homebase.householdOwner.v1";
function guardHouseholdData() {
  // Built here (not at module scope) because several of these key constants are
  // declared further down the file — referencing them up here would hit the
  // temporal dead zone and throw at load. By call time they're all initialized.
  const SYNCED_KEYS = [
    PLAN_KEY, FAV_KEY, SETTINGS_KEY, GROCERY_KEY, STORE_KEY,
    NOTES_KEY, TODOS_KEY, EVENTS_KEY, TRACKER_KEY,
  ];
  let owner = null;
  try {
    owner = localStorage.getItem(HOUSEHOLD_OWNER_KEY);
  } catch {
    /* storage unavailable — nothing to guard */
  }
  if (owner && owner !== household) {
    // Different family on this device: clear the cached data and re-hydrate the
    // in-memory copies from the now-empty store (each loader returns its default).
    for (const k of SYNCED_KEYS) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
    plan = loadPlan();
    favorites = loadFavorites();
    settings = loadSettings();
    grocery = loadGrocery();
    storeData = loadStore();
    notes = loadNotes();
    todos = loadTodos();
    events = loadEvents();
    tracker = loadTracker();
    applyPeopleLabels();
  }
  try {
    localStorage.setItem(HOUSEHOLD_OWNER_KEY, household);
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
// Sunday-based week start — used only for the Calendar month grid's layout
// (the Planner/chore logic stays Monday-based via startOfWeek above).
function startOfWeekSun(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  date.setDate(date.getDate() - date.getDay()); // getDay(): 0 = Sunday
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
// Settings now lives on the Home dashboard instead of the tab strip.
$(".home-settings")?.addEventListener("click", () => activateTab("settings"));
// Meal Planner sub-nav (Planner / Find Recipes / Grocery List), one row per panel.
document.querySelectorAll(".meal-nav .chip").forEach((chip) => {
  chip.addEventListener("click", () => activateTab(chip.dataset.mv));
});

// Drag-to-scroll the tab strip with a mouse (touch already scrolls natively).
(function enableTabDragScroll() {
  const strip = document.querySelector(".tabs");
  if (!strip) return;
  let down = false, startX = 0, startScroll = 0, moved = false, captured = false, pid = null;
  strip.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") return;
    down = true;
    moved = false;
    captured = false;
    pid = e.pointerId;
    startX = e.clientX;
    startScroll = strip.scrollLeft;
  });
  strip.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    // Only start capturing/scrolling once it's clearly a drag, so a plain click
    // still reaches the tab button and navigates.
    if (Math.abs(dx) > 4) {
      moved = true;
      if (!captured) { try { strip.setPointerCapture(pid); captured = true; } catch {} }
    }
    if (moved) strip.scrollLeft = startScroll - dx;
  });
  const end = (e) => {
    if (!down) return;
    down = false;
    if (captured) { try { strip.releasePointerCapture(e.pointerId); } catch {} }
    captured = false;
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
  if (name === "settings") {
    applyPeopleLabels(); // fill the name inputs with the current values
    renderThemeEditor(); // draw the theme picker in its current state
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
    !$("#recurEditor").classList.contains("hidden") ||
    !$("#quadModal").classList.contains("hidden") ||
    !$("#todoEditor").classList.contains("hidden")
  );
}
// Close only the top-most overlay. Overlays can stack — e.g. the quadrant
// pop-up with a task editor on top — and each has its own history entry, so a
// single Back peels off one layer at a time. Order = top of the stack first.
function closeOpenOverlays() {
  // The custom recurrence screen stacks on top of the day editor — peel it first.
  if (!$("#recurEditor").classList.contains("hidden")) return closeRecurEditor();
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

// Opt-in "Low-acid" (GERD) filter bubble under the search bar. Heuristic — it
// excludes common reflux-trigger ingredients server-side, then re-runs the search.
$("#lowAcidToggle").addEventListener("click", () => {
  lowAcidFilter = !lowAcidFilter;
  const btn = $("#lowAcidToggle");
  btn.classList.toggle("on", lowAcidFilter);
  btn.setAttribute("aria-pressed", String(lowAcidFilter));
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
    lowAcid: lowAcidFilter,
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
  if (p.lowAcid) params.set("lowacid", "1");

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

  // Notepad badge signals this favorite carries notes; tap it to open the recipe.
  if (hasFavNote(r.id)) {
    const note = document.createElement("button");
    note.className = "note-badge";
    note.setAttribute("aria-label", "Has notes");
    note.title = getFavNote(r.id);
    note.innerHTML = notepadIcon(16);
    note.addEventListener("click", (e) => {
      e.stopPropagation();
      showRecipe(r.id);
    });
    card.appendChild(note);
  }

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

// ============================================================
//  Store mode — sort the grocery list by a real store's aisle layout.
//  Tier 1 = the item's category (above). Tier 2 = this store: a seeded Walmart
//  aisle DB (fuzzy-matched by name) + a crowdsourced item->aisle map + a
//  walk-path order. Per-store data syncs; the on/off toggle is per-device.
// ============================================================
const STORE_KEY = "mealPlanner.store.v1";
const STOREMODE_KEY = "mealPlanner.storeMode";
let storeData = loadStore();
let storeMode = localStorage.getItem(STOREMODE_KEY) === "1";
let storePushTimer = null;
let seed = null; // { aisleOrder, categoryAisle, items:[{tokens,aisle}], landmarks }

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === "object") return normalizeStore(s);
  } catch { /* ignore */ }
  return { activeId: "", stores: {} };
}
function normalizeStore(s) {
  const stores = {};
  const src = s && s.stores && typeof s.stores === "object" ? s.stores : {};
  Object.values(src).forEach((st) => {
    if (!st || typeof st.id !== "string") return;
    const itemAisles = {};
    if (st.itemAisles && typeof st.itemAisles === "object") {
      Object.entries(st.itemAisles).forEach(([k, v]) => {
        if (v && typeof v === "object") itemAisles[k] = { aisle: String(v.aisle || ""), confirmed: Boolean(v.confirmed) };
        else if (typeof v === "string") itemAisles[k] = { aisle: v, confirmed: true };
      });
    }
    stores[st.id] = {
      id: st.id,
      name: typeof st.name === "string" ? st.name : "My store",
      zip: typeof st.zip === "string" ? st.zip : "",
      order: Array.isArray(st.order) ? st.order.filter((a) => typeof a === "string") : [],
      itemAisles,
      seeded: Boolean(st.seeded),
    };
  });
  const activeId = typeof s.activeId === "string" && stores[s.activeId] ? s.activeId : Object.keys(stores)[0] || "";
  return { activeId, stores };
}
function saveStore() {
  localStorage.setItem(STORE_KEY, JSON.stringify(storeData));
  if (!syncEnabled) return;
  clearTimeout(storePushTimer);
  storePushTimer = setTimeout(() => {
    fetch("/api/store", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ store: storeData }) }).catch(() => {});
  }, 700);
}
function activeStore() { return storeData.stores[storeData.activeId] || null; }
const normItem = (name) => (name || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Turn a product/ingredient name into matchable keywords (drop filler + brand-ish
// and packaging words) so recipe ingredients match Walmart product names.
const SEED_STOP = new Set(
  "the a an of for with and to in on great value fresh organic each count pack bag box can jar bottle carton tub roll size family natural gluten free non dairy reduced fat low sodium original".split(" ")
);
function singular(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y"; // berries -> berry
  if (w.length > 4 && /(oes|ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2); // tomatoes -> tomato
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1); // beans -> bean, grounds -> ground
  return w;
}
function tokenize(name) {
  return normItem(name)
    .split(" ")
    .filter((w) => w.length > 2 && !SEED_STOP.has(w) && !/^\d+$/.test(w))
    .map(singular);
}
async function loadSeed() {
  if (seed) return seed;
  try {
    const data = await fetch("/wood-river-aisles.json").then((r) => r.json());
    seed = {
      name: data.store || "Walmart",
      aisleOrder: Array.isArray(data.aisleOrder) ? data.aisleOrder : [],
      categoryAisle: data.categoryAisle || {},
      landmarks: data.aisleLandmarks || {},
      items: (data.items_pages_3_to_10 || [])
        .map(([n, a]) => ({ tokens: tokenize(n), aisle: a }))
        .filter((x) => x.aisle && x.tokens.length),
    };
  } catch {
    seed = { name: "Walmart", aisleOrder: [], categoryAisle: {}, landmarks: {}, items: [] };
  }
  return seed;
}
// Fuzzy-match a grocery item name to the seeded product DB; returns an aisle when
// the word overlap is strong enough, else "".
function seedAisleFor(name) {
  if (!seed || !seed.items.length) return "";
  const toks = tokenize(name);
  if (!toks.length) return "";
  const tset = new Set(toks);
  let best = "", bestScore = 0, bestHit = 0;
  for (const it of seed.items) {
    let hit = 0;
    for (const t of it.tokens) if (tset.has(t)) hit++;
    if (!hit) continue;
    // reward covering the grocery item's words without over-rewarding long names
    const score = hit / toks.length + hit / it.tokens.length * 0.25;
    if (score > bestScore) { bestScore = score; bestHit = hit; best = it.aisle; }
  }
  // Need 2+ shared words: a single shared word (e.g. "milk", "cheese") matches too
  // many processed products, so those fall through to the correct category map.
  return bestHit >= 2 && bestScore >= 0.5 ? best : "";
}
// Resolve an item's aisle. source: "user" (confirmed/entered), "seed" (auto),
// "category" (Tier-1 fallback), or "" (unknown).
function resolveAisle(name, tier1) {
  const st = activeStore();
  if (st) {
    const rec = st.itemAisles[normItem(name)];
    if (rec && rec.aisle) return { aisle: rec.aisle, source: rec.confirmed ? "user" : "seed" };
    const sa = seedAisleFor(name);
    if (sa) return { aisle: sa, source: "seed" };
  }
  const ca = seed && seed.categoryAisle[tier1];
  if (ca) return { aisle: ca, source: "category" };
  return { aisle: "", source: "" };
}
// Position of an aisle code in the walk path: the store's own order wins, then
// the seeded order, then a zone (prefix) + number fallback.
function zoneRank(code) {
  const m = (code || "").toUpperCase().match(/^([A-Z]+)(\d*)/);
  const prefix = m ? m[1] : (code || "");
  const num = m && m[2] ? parseInt(m[2], 10) : 0;
  const Z = { AD: 0, AP: 1, AB: 2, A: 3, AC: 4, F: 10, G: 11, H: 12, I: 13, J: 14, K: 15, L: 16, Y: 20, Z: 30 };
  let zp = Z[prefix];
  if (zp === undefined) zp = Z[prefix.slice(0, 2)] ?? Z[prefix.slice(0, 1)] ?? 99;
  return zp * 1000 + num;
}
function aisleRank(code) {
  if (!code) return 1e9; // unknown aisles sink to the bottom
  const st = activeStore();
  if (st && st.order.length) { const i = st.order.indexOf(code); if (i !== -1) return i; }
  if (seed && seed.aisleOrder.length) { const j = seed.aisleOrder.indexOf(code); if (j !== -1) return 1000 + j; }
  return 100000 + zoneRank(code);
}
// Create the Wood River store (seeded from the map) the first time store mode is
// switched on, and adopt the walk-path order if the store has none yet.
async function ensureStoreSeeded() {
  await loadSeed();
  let st = activeStore();
  if (!st) {
    const id = "wood-river";
    storeData.stores[id] = { id, name: seed.name, zip: "62095", order: seed.aisleOrder.slice(), itemAisles: {}, seeded: true };
    storeData.activeId = id;
    saveStore();
  } else if (!st.order.length && seed.aisleOrder.length) {
    st.order = seed.aisleOrder.slice();
    saveStore();
  }
}

// Crowdsourcing: the first time an item is checked off in store mode, confirm the
// seeded aisle (or ask for an unknown one). After that it's never asked again.
function maybeAskAisle(name, tier1) {
  const st = activeStore();
  if (!st) return;
  const rec = st.itemAisles[normItem(name)];
  if (rec && rec.confirmed) return;
  const { aisle, source } = resolveAisle(name, tier1);
  // Only confirm an aisle we actually stand behind (seed/user); a bare category
  // guess asks for the real aisle instead of prefilling a wrong one.
  const known = source === "seed" || source === "user";
  openAislePrompt(name, known ? aisle : "");
}
let aislePromptKey = null;
let aislePromptSeed = "";
function openAislePrompt(name, aisle) {
  const modal = $("#aislePrompt");
  if (!modal) return;
  aislePromptKey = normItem(name);
  aislePromptSeed = aisle || "";
  $("#aislePromptName").textContent = capitalize(name);
  $("#aislePromptMsg").textContent = aisle ? `We have this in Aisle ${aisle}. Is that right?` : "Which aisle is this in?";
  const input = $("#aislePromptInput");
  input.value = aisle || "";
  modal.classList.remove("hidden");
  requestAnimationFrame(() => { input.focus(); input.select(); });
}
// Any response marks the item confirmed so we don't ask again ("ask once").
// Save uses the (edited) input; "Not sure" keeps the seeded value.
function finishAislePrompt(save) {
  const modal = $("#aislePrompt");
  const st = activeStore();
  if (st && aislePromptKey) {
    const val = save
      ? $("#aislePromptInput").value.trim().toUpperCase().replace(/^AISLE\s+/, "")
      : aislePromptSeed;
    st.itemAisles[aislePromptKey] = { aisle: val, confirmed: true };
    saveStore();
  }
  aislePromptKey = null;
  if (modal) modal.classList.add("hidden");
  if (groceryWeek) renderGrocery(lastGroceryRecipes, groceryWeek);
}

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
  // In store mode an item groups by its store aisle only when we actually know it
  // (user-confirmed or a confident seed match). When we don't, it groups under its
  // general category instead — parked next to that category's assumed aisle — so a
  // guess never masquerades as a real aisle. Confirming an item's aisle (on
  // check-off) moves it into that aisle's own group.
  const byAisle = {};
  const staplesList = [];
  function storeGroup(name, tier1) {
    const { aisle, source } = resolveAisle(name, tier1);
    if ((source === "user" || source === "seed") && aisle) return { key: aisle, meta: { cat: false } };
    return { key: "cat:" + tier1, meta: { cat: true, category: tier1 } };
  }
  const bucketOf = (name, tier1) => {
    if (!storeMode) return (byAisle[tier1] ||= { extras: [], items: [] });
    const g = storeGroup(name, tier1);
    return (byAisle[g.key] ||= { extras: [], items: [], meta: g.meta });
  };

  for (const item of combined.values()) {
    const overridden = Boolean(wk.overrides[item.key]);
    // In store mode pantry staples flow into their aisle instead of a side bucket.
    if (isStaple(item.name) && !overridden && !storeMode) {
      staplesList.push(item);
      continue;
    }
    const tier1 = wk.overrides[item.key] || item.aisle;
    bucketOf(item.name, tier1).items.push(item);
  }
  // This week's own manual items, plus still-unbought items carried from earlier weeks.
  const extrasToShow = [
    ...wk.extras.map((extra) => ({ extra, origin: weekKey, carried: Boolean(extra.carried) })),
    ...carriedExtrasFor(weekKey).map(({ extra, origin }) => ({ extra, origin, carried: true })),
  ];
  extrasToShow.forEach((row) => {
    const tier1 = row.extra.aisle || categorizeItem(row.extra.name);
    bucketOf(row.extra.name, tier1).extras.push(row);
  });

  // Real aisles sort by the walk order; a category group sits just after the aisle
  // its category is assumed to be in (or at the very end when that's unknown too).
  const groupRank = (key) => {
    const b = byAisle[key];
    if (b.meta && b.meta.cat) {
      const ca = seed && seed.categoryAisle[b.meta.category];
      return (ca ? aisleRank(ca) : 1e8) + 0.5;
    }
    return aisleRank(key);
  };
  const sortAisles = storeMode
    ? (a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b)
    : (a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b));
  Object.keys(byAisle)
    .sort(sortAisles)
    .forEach((key) => {
      const group = byAisle[key];
      const collapsed = groceryCollapsed.has(key);
      const count = group.extras.length + group.items.length;
      const section = document.createElement("div");
      section.className = "aisle" + (collapsed ? " collapsed" : "");
      const header = document.createElement("h3");
      header.className = "aisle-head";
      let label = escapeHtml(key);
      let landmark = "";
      if (storeMode) {
        if (group.meta && group.meta.cat) {
          section.classList.add("cat-group");
          label = escapeHtml(group.meta.category || "Other");
          landmark = `<span class="aisle-landmark">category — check off to set the aisle</span>`;
        } else {
          label = "Aisle " + escapeHtml(key);
          const lm = seed && seed.landmarks[key];
          if (lm) landmark = `<span class="aisle-landmark">${escapeHtml(lm)}</span>`;
        }
      }
      header.innerHTML = `<span class="chev">${collapsed ? "▸" : "▾"}</span> ${label} <span class="aisle-count">${count}</span>${landmark}`;
      header.addEventListener("click", () => {
        groceryCollapsed.has(key) ? groceryCollapsed.delete(key) : groceryCollapsed.add(key);
        renderGrocery(lastGroceryRecipes, weekKey);
      });
      const itemsWrap = document.createElement("div");
      itemsWrap.className = "aisle-items";
      // Unbought items first (alphabetical); checked-off ones sink to the bottom.
      const aisleRows = [
        ...group.extras.map((row) => ({
          checked: Boolean(row.extra.checked),
          name: (row.extra.name || "").toLowerCase(),
          build: () => extraRow(row.extra, row.origin, row.carried),
        })),
        ...group.items.map((item) => ({
          checked: Boolean(wk.checked[item.key]),
          name: item.name.toLowerCase(),
          build: () => groceryRow(item, weekKey),
        })),
      ];
      aisleRows
        .sort((a, b) => a.checked - b.checked || a.name.localeCompare(b.name))
        .forEach((row) => itemsWrap.appendChild(row.build()));
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
      .sort((a, b) => Boolean(wk.checked[a.key]) - Boolean(wk.checked[b.key]) || a.name.localeCompare(b.name))
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
  const tier1 = wk.overrides[item.key] || item.aisle;
  cb.addEventListener("change", () => {
    row.classList.toggle("checked", cb.checked);
    if (cb.checked) wk.checked[item.key] = true;
    else delete wk.checked[item.key];
    saveGrocery();
    // Store mode: the first time an item is checked off, confirm/ask its aisle.
    if (cb.checked && storeMode) maybeAskAisle(item.name, tier1);
    renderGrocery(lastGroceryRecipes, weekKey); // re-sort: checked items sink to the bottom
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
    if (e.target.checked && storeMode) maybeAskAisle(extra.name, extra.aisle || categorizeItem(extra.name));
    renderGrocery(lastGroceryRecipes, groceryWeek); // re-sort: checked items sink to the bottom
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

// ---- Store mode: sort the grocery list by a store's aisle layout. ----
function updateStoreHint() {
  const hint = $("#storeHint");
  if (!hint) return;
  const st = activeStore();
  hint.classList.toggle("hidden", !storeMode);
  if (storeMode) hint.textContent = st ? `Sorted for ${st.name}. Check items off to confirm their aisle.` : "Store mode on.";
}
$("#storeMode").addEventListener("click", async () => {
  storeMode = !storeMode;
  localStorage.setItem(STOREMODE_KEY, storeMode ? "1" : "0");
  $("#storeMode").classList.toggle("on", storeMode);
  $("#storeMode").setAttribute("aria-pressed", String(storeMode));
  if (storeMode) await ensureStoreSeeded();
  updateStoreHint();
  if (groceryWeek) renderGrocery(lastGroceryRecipes, groceryWeek);
});
// Aisle-confirm prompt buttons.
$("#aislePromptForm").addEventListener("submit", (e) => { e.preventDefault(); finishAislePrompt(true); });
$("#aislePromptSkip").addEventListener("click", () => finishAislePrompt(false));
// Restore store-mode state on load (and warm the seed so resolution works).
(async () => {
  const btn = $("#storeMode");
  if (btn) {
    btn.classList.toggle("on", storeMode);
    btn.setAttribute("aria-pressed", String(storeMode));
  }
  if (storeMode) { await loadSeed(); await ensureStoreSeeded(); updateStoreHint(); }
})();

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
// todo = { id, quadrant: 1|2|3|4, title, note, due: "YYYY-MM-DD", done, doneBy: ["0"|"1"], ts }
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
// Short "when" label for a date on the Home dashboard's 7-day list.
function dashDayLabel(dateKey) {
  const today = new Date();
  const todayKey = isoDate(today);
  const tmr = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (dateKey === todayKey) return "Today";
  if (dateKey === isoDate(tmr)) return "Tmrw";
  return parseKey(dateKey).toLocaleDateString(undefined, { weekday: "short" });
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

// Normalize a task's completion attribution into a set of person-index strings.
// `doneBy` is now an array (e.g. ["0"], ["0","1"]); older tasks may still carry a
// single "0"/"1" or the legacy "both" — this reads all three shapes uniformly.
function doneBySet(t) {
  const v = t.doneBy;
  if (Array.isArray(v)) return v.filter((p) => /^[0-5]$/.test(p));
  if (v === "both") return ["0", "1"];
  if (/^[0-5]$/.test(v || "")) return [v];
  return [];
}
// Completion control: one independent toggle per household member so you record
// WHO finished the task. Each button flips that person on/off on its own, so a
// task can be done by anyone or several people at once. `doneBy` holds the
// selected people; `done` stays the simple boolean the rest of the app reads
// (true whenever anyone is selected).
function todoDoneControl(t) {
  const wrap = document.createElement("div");
  wrap.className = "todo-doneby-pick";
  const set = doneBySet(t);
  activePeople().forEach((pi) => {
    const p = String(pi);
    const name = personName(pi);
    const b = document.createElement("button");
    b.type = "button";
    const active = set.includes(p);
    b.className = "todo-doneby" + (active ? " on" : "");
    b.setAttribute("style", personStyle(pi));
    b.textContent = personInitial(pi);
    b.title = active ? `Done by ${name} — tap to remove` : `Mark done by ${name}`;
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = doneBySet(t);
      const i = next.indexOf(p);
      if (i >= 0) next.splice(i, 1);
      else next.push(p);
      next.sort();
      t.doneBy = next;
      t.done = next.length > 0;
      saveTodos();
      afterTodosChanged();
    });
    wrap.appendChild(b);
  });
  return wrap;
}
// A small "✓ by <name>" tag appended to a completed task so the attribution
// reads clearly next to the (still-legible) struck-through title.
function todoDoneTag(t) {
  const set = doneBySet(t);
  if (!t.done || !set.length) return null;
  const tag = document.createElement("span");
  tag.className = "todo-doneby-tag";
  if (set.length === 1) {
    tag.setAttribute("style", personStyle(Number(set[0])));
    tag.textContent = `✓ ${personName(Number(set[0]))}`;
  } else {
    // Several people: a neutral (accent) tag rather than any one person's colour.
    tag.classList.add("multi");
    tag.textContent =
      set.length === 2
        ? `✓ ${personName(Number(set[0]))} & ${personName(Number(set[1]))}`
        : `✓ ${set.length} people`;
  }
  return tag;
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
  const doneTag = todoDoneTag(t);
  if (t.due || t.note || doneTag) {
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
    if (doneTag) meta.appendChild(doneTag);
    body.appendChild(meta);
  }
  row.append(todoDoneControl(t), body);
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
  const doneTag = todoDoneTag(t);
  if (t.due || doneTag) {
    const meta = document.createElement("div");
    meta.className = "todo-meta";
    if (t.due) {
      const due = document.createElement("span");
      due.className = "todo-due" + (isOverdue(t.due) && !t.done ? " overdue" : "");
      due.textContent = fmtDue(t.due);
      meta.appendChild(due);
    }
    if (doneTag) meta.appendChild(doneTag);
    body.appendChild(meta);
  }
  body.addEventListener("click", () => openTodoEditor(t.quadrant, t.id));
  row.append(todoDoneControl(t), body);
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
// event = { id, date: "YYYY-MM-DD", title, people: ["0".."5"], time?: "HH:MM" }
// (older events carry a single `person` of "0" | "1" | "both"; see evPeople()).
const EVENTS_KEY = "mealPlanner.events.v1";
let events = loadEvents();
let eventsPushTimer = null;
let calMonth = startOfMonth(new Date()); // first of the month currently on screen
let dayEditorDate = null; // which day the editor is open for
let dayEditorMode = "list"; // "list" (events + Add button) | "form" (add/edit prompts)
let editingEventId = null; // event being edited (null = adding new)
let eventPeople = ["0"]; // selected people in the add/edit form (one or more)

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
// ---- Katie's pay schedule (hardcoded for the andrew-katie household) ----
// Payday is the 16th and the last day of each month; if either lands on a
// weekend it moves to the Friday before. Only shown for their household.
const PAY_HOUSEHOLDS = new Set(["andrew-katie", "local"]);
const payEnabled = () => PAY_HOUSEHOLDS.has(household);
function shiftToFridayIfWeekend(d) {
  const g = d.getDay();
  if (g === 6) d.setDate(d.getDate() - 1); // Saturday → Friday
  else if (g === 0) d.setDate(d.getDate() - 2); // Sunday → Friday
  return d;
}
function katiePaydaysInMonth(year, month) {
  const mid = shiftToFridayIfWeekend(new Date(year, month, 16));
  const last = shiftToFridayIfWeekend(new Date(year, month + 1, 0)); // day 0 of next month = last of this
  return [isoDate(mid), isoDate(last)];
}
function isKatiePayday(dateKey) {
  if (!payEnabled()) return false;
  const d = parseKey(dateKey);
  return katiePaydaysInMonth(d.getFullYear(), d.getMonth()).includes(dateKey);
}
function paydayLabel() {
  return `${personName(1)} payday`;
}

// ---- Recurrence engine (Google-style rules stored on event.recur) ----
// recur = { freq: "daily|weekly|monthly|yearly", interval, weekdays:[0..6],
//           monthMode: "day|weekday|lastday", ends:{ type:"never|onDate|after",
//           date, count } }. Older events use the legacy `repeat`/`days` fields.
function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}
function isLastDayOfMonth(d) {
  return d.getDate() === daysInMonth(d.getFullYear(), d.getMonth());
}
function nthWeekdayOfMonth(d) {
  return Math.floor((d.getDate() - 1) / 7) + 1; // 1st..5th occurrence of its weekday
}
function daysBetween(a, b) {
  const A = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const B = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((B - A) / 86400000);
}
// 1-based index of the occurrence on day d, but stops counting once it passes
// `cap` (so an "after N" series is cheap to evaluate far in the future).
function occurrenceIndexCapped(e, d, cap) {
  const r = e.recur;
  const s = parseKey(e.date);
  const interval = Math.max(1, r.interval || 1);
  if (r.freq === "daily") return Math.floor(daysBetween(s, d) / interval) + 1;
  if (r.freq === "monthly")
    return Math.floor(((d.getFullYear() - s.getFullYear()) * 12 + (d.getMonth() - s.getMonth())) / interval) + 1;
  if (r.freq === "yearly") return Math.floor((d.getFullYear() - s.getFullYear()) / interval) + 1;
  // weekly: count matching days from start to d, bailing out past the cap.
  const wds = r.weekdays && r.weekdays.length ? r.weekdays : [s.getDay()];
  const sw = startOfWeekSun(s);
  let count = 0;
  const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  while (cur <= d) {
    const weeks = Math.floor(daysBetween(sw, startOfWeekSun(cur)) / 7);
    if (weeks % interval === 0 && wds.includes(cur.getDay())) {
      count++;
      if (count > cap) return count;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}
function occursOnRecur(e, dateKey) {
  const r = e.recur;
  if (dateKey < e.date) return false;
  if (r.ends && r.ends.type === "onDate" && r.ends.date && dateKey > r.ends.date) return false;
  const d = parseKey(dateKey);
  const s = parseKey(e.date);
  const interval = Math.max(1, r.interval || 1);
  let matches = false;
  switch (r.freq) {
    case "daily":
      matches = daysBetween(s, d) % interval === 0;
      break;
    case "weekly": {
      const wds = r.weekdays && r.weekdays.length ? r.weekdays : [s.getDay()];
      if (!wds.includes(d.getDay())) break;
      const weeks = Math.floor(daysBetween(startOfWeekSun(s), startOfWeekSun(d)) / 7);
      matches = weeks % interval === 0;
      break;
    }
    case "monthly": {
      const months = (d.getFullYear() - s.getFullYear()) * 12 + (d.getMonth() - s.getMonth());
      if (months < 0 || months % interval !== 0) break;
      if (r.monthMode === "lastday") matches = isLastDayOfMonth(d);
      else if (r.monthMode === "weekday")
        matches = d.getDay() === s.getDay() && nthWeekdayOfMonth(d) === nthWeekdayOfMonth(s);
      else matches = d.getDate() === s.getDate();
      break;
    }
    case "yearly": {
      const years = d.getFullYear() - s.getFullYear();
      if (years < 0 || years % interval !== 0) break;
      matches = d.getMonth() === s.getMonth() && d.getDate() === s.getDate();
      break;
    }
  }
  if (!matches) return false;
  if (r.ends && r.ends.type === "after") {
    const cap = Math.max(1, r.ends.count || 1);
    if (occurrenceIndexCapped(e, d, cap) > cap) return false;
  }
  return true;
}
// Legacy events (no `recur`) keep their original simple behaviour exactly.
function legacyOccursOn(e, dateKey) {
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
// Does a (possibly recurring) event land on this day? A recurrence is anchored
// at the event's own `date` and never fires before it.
function occursOn(e, dateKey) {
  if (e.recur && e.recur.freq) return occursOnRecur(e, dateKey);
  return legacyOccursOn(e, dateKey);
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
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NTH_WORD = ["", "first", "second", "third", "fourth", "fifth"];
// Human-readable summary of a recurrence rule, for chips/rows and the picker.
function recurSummary(e) {
  const r = e.recur;
  const s = parseKey(e.date);
  const n = Math.max(1, r.interval || 1);
  const plural = n > 1 ? `${n} ` : "";
  let base = "";
  switch (r.freq) {
    case "daily":
      base = n > 1 ? `Every ${n} days` : "Every day";
      break;
    case "weekly": {
      const wds = (r.weekdays && r.weekdays.length ? r.weekdays : [s.getDay()])
        .slice()
        .sort((a, b) => a - b);
      // Mon–Fri is the "Every weekday" preset.
      if (n === 1 && wds.length === 5 && wds.every((x) => x >= 1 && x <= 5)) {
        base = "Every weekday";
      } else {
        const names = wds.map((x) => WEEKDAYS_SHORT[x]).join(", ");
        base = n > 1 ? `Every ${n} weeks on ${names}` : `Weekly on ${names}`;
      }
      break;
    }
    case "monthly": {
      const every = n > 1 ? `Every ${n} months ` : "Monthly ";
      if (r.monthMode === "lastday") base = every + "on the last day";
      else if (r.monthMode === "weekday")
        base = every + `on the ${NTH_WORD[nthWeekdayOfMonth(s)] || nthWeekdayOfMonth(s) + "th"} ${WEEKDAYS_FULL[s.getDay()]}`;
      else base = every + `on day ${s.getDate()}`;
      break;
    }
    case "yearly":
      base = (n > 1 ? `Every ${n} years ` : "Annually ") + `on ${MONTHS_FULL[s.getMonth()].slice(0, 3)} ${s.getDate()}`;
      break;
    default:
      base = "";
  }
  if (r.ends && r.ends.type === "onDate" && r.ends.date)
    base += `, until ${parseKey(r.ends.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  else if (r.ends && r.ends.type === "after" && r.ends.count)
    base += `, ${r.ends.count} times`;
  return base;
}
function repeatSummary(e) {
  if (e.recur && e.recur.freq) return recurSummary(e);
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
// The people an event belongs to, as an array of indices. Migrates the old model
// where `person` was "0" / "1" / "both".
function evPeople(e) {
  if (Array.isArray(e.people)) {
    const list = e.people.filter((p) => Number(p) < peopleCount());
    return list.length ? list : ["0"];
  }
  if (e.person === "both") return ["0", "1"];
  if (/^[0-5]$/.test(e.person || "")) return [e.person];
  return ["0"];
}
// Small person "bubble(s)" matching the chores visual — one per selected person.
function personBubbles(people) {
  return people
    .map((p) => `<span class="pbubble" style="${personStyle(Number(p))}">${escapeHtml(personInitial(Number(p)))}</span>`)
    .join("");
}
// Inline tint for an event chip: one person → their hue; several → the accent.
function eventTint(people) {
  const c = people.length === 1 ? personColor(Number(people[0])) : "var(--accent)";
  return `background:color-mix(in srgb, ${c} 20%, transparent);--elc:${c}`;
}
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

// ---- Recurrence picker (Google-style presets + a Custom screen) ----
// The event form's Repeat <select> is rebuilt per event so presets read from the
// event's start date (e.g. "Weekly on Tuesday"). `pendingRecur` holds the rule
// currently chosen; the Custom screen edits it in full.
let pendingRecur = null; // recurrence object, or null for "Does not repeat"
let recurAnchorKey = null; // the start date the presets are worded around
const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);

// Build the preset <option> list for a given start date. "Monthly on the last
// day" only appears when the start date is itself the last day of its month.
function buildRepeatSelect(anchorKey) {
  const sel = $("#eventRepeat");
  if (!sel) return;
  const s = parseKey(anchorKey);
  const opts = [
    ["none", "Does not repeat"],
    ["daily", "Daily"],
    ["weekly", `Weekly on ${WEEKDAYS_FULL[s.getDay()]}`],
    ["monthly", `Monthly on day ${s.getDate()}`],
  ];
  if (isLastDayOfMonth(s)) opts.push(["lastday", "Monthly on the last day"]);
  opts.push(["yearly", `Annually on ${MONTHS_FULL[s.getMonth()].slice(0, 3)} ${s.getDate()}`]);
  opts.push(["weekdays", "Every weekday (Mon–Fri)"]);
  opts.push(["custom", "Custom…"]);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join("");
}
function presetToRecur(value, anchorKey) {
  const s = parseKey(anchorKey);
  switch (value) {
    case "daily":
      return { freq: "daily", interval: 1, ends: { type: "never" } };
    case "weekly":
      return { freq: "weekly", interval: 1, weekdays: [s.getDay()], ends: { type: "never" } };
    case "monthly":
      return { freq: "monthly", interval: 1, monthMode: "day", ends: { type: "never" } };
    case "lastday":
      return { freq: "monthly", interval: 1, monthMode: "lastday", ends: { type: "never" } };
    case "yearly":
      return { freq: "yearly", interval: 1, ends: { type: "never" } };
    case "weekdays":
      return { freq: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5], ends: { type: "never" } };
    default:
      return null;
  }
}
// Which preset (if any) a rule corresponds to — else "custom".
function matchPresetValue(recur, anchorKey) {
  if (!recur || !recur.freq) return "none";
  const s = parseKey(anchorKey);
  const simple = (!recur.ends || recur.ends.type === "never") && (recur.interval || 1) === 1;
  if (!simple) return "custom";
  if (recur.freq === "daily") return "daily";
  if (recur.freq === "yearly") return "yearly";
  if (recur.freq === "weekly") {
    const wds = (recur.weekdays || []).slice().sort((a, b) => a - b);
    if (wds.length === 1 && wds[0] === s.getDay()) return "weekly";
    if (wds.length === 5 && wds.every((x) => x >= 1 && x <= 5)) return "weekdays";
    return "custom";
  }
  if (recur.freq === "monthly") {
    if (recur.monthMode === "lastday") return isLastDayOfMonth(s) ? "lastday" : "custom";
    if (recur.monthMode === "weekday") return "custom";
    return "monthly";
  }
  return "custom";
}
// Migrate an older event's legacy repeat into the new recurrence object.
function legacyToRecur(e) {
  const s = parseKey(e.date);
  switch (e.repeat) {
    case "daily":
      return { freq: "daily", interval: 1, ends: { type: "never" } };
    case "weekly":
      return { freq: "weekly", interval: 1, weekdays: [s.getDay()], ends: { type: "never" } };
    case "monthly":
    case "monthdays":
      return { freq: "monthly", interval: 1, monthMode: "day", ends: { type: "never" } };
    default:
      return null;
  }
}
function ensureCustomOptionLabel(v) {
  const sel = $("#eventRepeat");
  if (!sel) return;
  const opt = [...sel.options].find((o) => o.value === "custom");
  if (!opt) return;
  opt.textContent =
    v === "custom" && pendingRecur
      ? "Custom: " + recurSummary({ recur: pendingRecur, date: recurAnchorKey })
      : "Custom…";
}
// Point the form's picker at an event (or null for a new one).
function initRepeatForForm(anchorKey, event) {
  recurAnchorKey = anchorKey || isoDate(new Date());
  pendingRecur =
    event && event.recur && event.recur.freq ? clone(event.recur) : event ? legacyToRecur(event) : null;
  buildRepeatSelect(recurAnchorKey);
  const v = matchPresetValue(pendingRecur, recurAnchorKey);
  ensureCustomOptionLabel(v);
  $("#eventRepeat").value = v;
}
function getEventRepeat() {
  return { recur: pendingRecur };
}
function onRepeatSelectChange() {
  const v = $("#eventRepeat").value;
  if (v === "custom") {
    openRecurEditor();
  } else {
    pendingRecur = presetToRecur(v, recurAnchorKey);
    ensureCustomOptionLabel(v);
  }
}

// ---- Custom recurrence screen ----
let recurEditorApplied = false;
let recurEditorReturnValue = "none"; // select value to restore if cancelled
function buildWeekdayChips() {
  const wrap = $("#recurWeekdays");
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = "1";
  const labels = ["S", "M", "T", "W", "T", "F", "S"]; // Sunday-first
  wrap.innerHTML = labels
    .map((l, i) => `<button type="button" class="recur-wd" data-wd="${i}" aria-label="${WEEKDAYS_FULL[i]}">${l}</button>`)
    .join("");
  wrap.querySelectorAll(".recur-wd").forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
}
function buildMonthModeOptions() {
  const sel = $("#recurMonthMode");
  const s = parseKey(recurAnchorKey);
  const nth = NTH_WORD[nthWeekdayOfMonth(s)] || nthWeekdayOfMonth(s) + "th";
  const opts = [
    ["day", `On day ${s.getDate()}`],
    ["weekday", `On the ${nth} ${WEEKDAYS_FULL[s.getDay()]}`],
    ["lastday", "On the last day of the month"],
  ];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join("");
}
function syncRecurSections() {
  const unit = $("#recurUnit").value;
  $("#recurWeekly").classList.toggle("hidden", unit !== "weekly");
  $("#recurMonthly").classList.toggle("hidden", unit !== "monthly");
}
function fillRecurEditor(r) {
  $("#recurInterval").value = Math.max(1, r.interval || 1);
  $("#recurUnit").value = r.freq || "weekly";
  const wds = r.weekdays && r.weekdays.length ? r.weekdays : [parseKey(recurAnchorKey).getDay()];
  $("#recurWeekdays")
    .querySelectorAll(".recur-wd")
    .forEach((b) => b.classList.toggle("on", wds.includes(+b.dataset.wd)));
  $("#recurMonthMode").value = r.monthMode || "day";
  const ends = r.ends || { type: "never" };
  document.querySelectorAll('input[name="recurEnd"]').forEach((rb) => (rb.checked = rb.value === (ends.type || "never")));
  $("#recurEndDate").value = ends.date || "";
  $("#recurEndCount").value = ends.count || 13;
  syncRecurSections();
}
function readRecurEditor() {
  const freq = $("#recurUnit").value;
  const interval = Math.max(1, parseInt($("#recurInterval").value, 10) || 1);
  const recur = { freq, interval, ends: { type: "never" } };
  if (freq === "weekly") {
    const wds = [...$("#recurWeekdays").querySelectorAll(".recur-wd.on")].map((b) => +b.dataset.wd);
    recur.weekdays = wds.length ? wds.sort((a, b) => a - b) : [parseKey(recurAnchorKey).getDay()];
  }
  if (freq === "monthly") recur.monthMode = $("#recurMonthMode").value;
  const endType = (document.querySelector('input[name="recurEnd"]:checked') || {}).value || "never";
  if (endType === "onDate") recur.ends = { type: "onDate", date: $("#recurEndDate").value || "" };
  else if (endType === "after")
    recur.ends = { type: "after", count: Math.max(1, parseInt($("#recurEndCount").value, 10) || 1) };
  return recur;
}
function openRecurEditor() {
  recurEditorApplied = false;
  recurEditorReturnValue = matchPresetValue(pendingRecur, recurAnchorKey);
  buildWeekdayChips();
  buildMonthModeOptions();
  const seed =
    pendingRecur && pendingRecur.freq
      ? clone(pendingRecur)
      : { freq: "weekly", interval: 1, weekdays: [parseKey(recurAnchorKey).getDay()], monthMode: "day", ends: { type: "never" } };
  fillRecurEditor(seed);
  $("#recurEditor").classList.remove("hidden");
  pushOverlayState(); // Back / tap-away closes the custom screen, not the app
}
function closeRecurEditor() {
  $("#recurEditor").classList.add("hidden");
  if (!recurEditorApplied) {
    // Cancelled: revert the "Custom…" selection to whatever was chosen before.
    $("#eventRepeat").value = recurEditorReturnValue;
    ensureCustomOptionLabel(recurEditorReturnValue);
  }
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

// Whether the calendar grid starts each week on Monday. Per-device (like the
// colour theme), NOT synced — stored locally so each phone can choose.
const WEEKSTART_KEY = "mealPlanner.weekStart";
function weekStartsMonday() {
  return localStorage.getItem(WEEKSTART_KEY) === "mon";
}

function renderCalendar() {
  const grid = $("#calGrid");
  if (!grid) return;
  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  $("#calLabel").textContent = `${MONTHS_FULL[month]} ${year}`;

  // 6-week window starting on the Sunday (or Monday) on/before the 1st.
  const monday = weekStartsMonday();
  const gridStart = monday ? startOfWeek(new Date(year, month, 1)) : startOfWeekSun(new Date(year, month, 1));
  const wdEl = $("#calWeekdays");
  if (wdEl) {
    const labels = monday
      ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    wdEl.innerHTML = labels.map((d) => `<span>${d}</span>`).join("");
  }
  const todayKey = isoDate(new Date());
  hideWeekPop();
  grid.innerHTML = "";

  for (let w = 0; w < 6; w++) {
    const rowStart = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7);
    // The Planner week is Mon–Sun; the "R" bubble tracks the Monday in this row.
    // On Sunday-start rows that Monday is rowStart + 1 day; on Monday-start rows
    // it's rowStart itself.
    const wkKey = weekKeyOf(new Date(rowStart.getFullYear(), rowStart.getMonth(), rowStart.getDate() + (monday ? 0 : 1)));
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

      // Katie's payday, then events, then any to-do items due that day.
      const chips = [
        ...(isKatiePayday(key)
          ? [
              `<div class="cal-event payday"><span class="pay-ico">$</span><span class="cal-event-title">${escapeHtml(paydayLabel())}</span></div>`,
            ]
          : []),
        ...eventsOnDay(key).map((e) => {
          const ps = evPeople(e);
          return `<div class="cal-event" style="${eventTint(ps)}">${personBubbles(ps)}<span class="cal-event-title">${e.emoji ? `<span class="ev-emoji">${e.emoji}</span>` : ""}${escapeHtml(e.title)}</span></div>`;
        }),
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
  const payday = isKatiePayday(dayEditorDate);
  $("#dayEventEmpty").classList.toggle("hidden", dayEvents.length + dayTodos.length + (payday ? 1 : 0) > 0);
  // Katie's payday — a read-only marker (not a stored/editable event).
  if (payday) {
    const row = document.createElement("div");
    row.className = "event-row payday-row";
    row.innerHTML = `
      <span class="pay-ico">$</span>
      <span class="event-title">${escapeHtml(paydayLabel())}</span>
      <span class="day-todo-tag pay-tag">Payday</span>`;
    list.appendChild(row);
  }
  dayEvents.forEach((e) => {
    const row = document.createElement("div");
    row.className = "event-row" + (e.id === editingEventId ? " editing" : "");
    const rep = repeatSummary(e);
    row.innerHTML = `
      <span class="event-bubbles">${personBubbles(evPeople(e))}</span>
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
  setEventPeople(evPeople(e));
  $("#addEventTitle").value = e.title;
  setEventTime(e.time || "");
  initRepeatForForm(e.date, e); // presets read from the event's start date
  setEventEmoji(e.emoji || "");
  $("#addEventSubmit").textContent = "Save";
  setDayEditorMode("form"); // show the prompts, populated for editing
  pushOverlayState(); // Back returns to the list
  $("#addEventTitle").focus();
}
function resetEventForm() {
  editingEventId = null;
  setEventPeople(["0"]);
  $("#addEventTitle").value = "";
  setEventTime("");
  initRepeatForForm(dayEditorDate, null);
  setEventEmoji("");
  $("#addEventSubmit").textContent = "Add";
}
// Build the event editor's person picker — one toggle chip per household member.
// (Rebuilt whenever the household changes.) The chips multi-select.
function renderEventPersonPicker() {
  const wrap = document.getElementById("eventPerson");
  if (!wrap) return;
  wrap.innerHTML = activePeople()
    .map(
      (i) =>
        `<button type="button" class="pbtn" style="${personStyle(i)}" data-p="${i}" aria-pressed="false" aria-label="${escapeHtml(
          personName(i)
        )}" title="${escapeHtml(personName(i))}">${escapeHtml(personInitial(i))}</button>`
    )
    .join("");
  syncEventPersonPicker();
}
function setEventPeople(people) {
  const list = (Array.isArray(people) ? people : [people]).filter((p) => Number(p) < peopleCount());
  eventPeople = list.length ? list : ["0"];
  syncEventPersonPicker();
}
function syncEventPersonPicker() {
  document.querySelectorAll("#eventPerson [data-p]").forEach((b) => {
    const on = eventPeople.includes(b.dataset.p);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
  });
}
// Delegated: tap a chip to add/remove that person; never let the set go empty.
document.getElementById("eventPerson")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-p]");
  if (!b) return;
  const p = b.dataset.p;
  const next = eventPeople.includes(p) ? eventPeople.filter((x) => x !== p) : [...eventPeople, p];
  if (next.length) setEventPeople(next);
});

$("#addEventForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("#addEventTitle").value.trim();
  if (!title || !dayEditorDate) return;
  const time = getEventTime();
  const { recur } = getEventRepeat();
  const emoji = getEventEmoji();
  if (editingEventId) {
    const ev = events.find((x) => x.id === editingEventId);
    if (ev) {
      ev.title = title;
      ev.people = [...eventPeople];
      delete ev.person; // drop the legacy single-person field
      ev.time = time;
      ev.recur = recur; // the new recurrence model
      delete ev.repeat; // drop legacy fields so occursOn uses `recur`
      delete ev.days;
      ev.emoji = emoji;
    }
  } else {
    events.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      date: dayEditorDate,
      title,
      people: [...eventPeople],
      time,
      recur,
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
$("#eventRepeat").addEventListener("change", onRepeatSelectChange);
// Custom recurrence screen wiring.
$("#recurUnit").addEventListener("change", syncRecurSections);
$("#recurDone").addEventListener("click", () => {
  recurEditorApplied = true;
  pendingRecur = readRecurEditor();
  const v = matchPresetValue(pendingRecur, recurAnchorKey);
  ensureCustomOptionLabel(v);
  $("#eventRepeat").value = v;
  dismissOverlays(); // pops the overlay history entry, closing the screen
});
$("#recurCancel").addEventListener("click", dismissOverlays);
$("#recurEditor").addEventListener("click", (e) => {
  if (e.target === $("#recurEditor")) dismissOverlays();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#recurEditor").classList.contains("hidden")) dismissOverlays();
});
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
// A card whose title doubles as a shortcut into its full section. Pass an
// `onNav` callback to make the heading a clickable link into that tab.
function dashCard(title, onNav) {
  const card = document.createElement("div");
  card.className = "dash-card";
  card.innerHTML =
    `<div class="dash-head"><h3>${escapeHtml(title)}</h3></div><div class="dash-body"></div>`;
  if (onNav) {
    const head = card.querySelector(".dash-head");
    head.classList.add("dash-head-link");
    head.setAttribute("role", "link");
    head.setAttribute("tabindex", "0");
    head.addEventListener("click", onNav);
    head.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onNav();
      }
    });
  }
  return card;
}
function dashEmpty(msg) {
  const d = document.createElement("div");
  d.className = "dash-empty";
  d.textContent = msg;
  return d;
}

// Map a WMO weather code to an emoji + short label. Night swaps a couple of
// icons (clear/partly-cloudy) for their moon variants.
function describeWeather(code, isDay) {
  const c = Number(code);
  if (c === 0) return { icon: isDay ? "☀️" : "🌙", text: "Clear" };
  if (c === 1 || c === 2) return { icon: isDay ? "🌤️" : "☁️", text: "Partly cloudy" };
  if (c === 3) return { icon: "☁️", text: "Overcast" };
  if (c === 45 || c === 48) return { icon: "🌫️", text: "Fog" };
  if (c >= 51 && c <= 57) return { icon: "🌦️", text: "Drizzle" };
  if (c >= 61 && c <= 67) return { icon: "🌧️", text: "Rain" };
  if (c >= 71 && c <= 77) return { icon: "❄️", text: "Snow" };
  if (c >= 80 && c <= 82) return { icon: "🌧️", text: "Showers" };
  if (c === 85 || c === 86) return { icon: "🌨️", text: "Snow showers" };
  if (c >= 95) return { icon: "⛈️", text: "Thunderstorm" };
  return { icon: "🌡️", text: "Weather" };
}

// Cache the last reading in memory so switching tabs doesn't re-hit the API.
let weatherCache = null; // { at, key, data }
const WEATHER_CLIENT_TTL = 1000 * 60 * 10; // 10 minutes
async function loadWeather(force) {
  const loc = weatherLoc();
  const key = `${loc.lat},${loc.lon}`;
  if (
    !force &&
    weatherCache &&
    weatherCache.key === key &&
    Date.now() - weatherCache.at < WEATHER_CLIENT_TTL
  ) {
    return weatherCache.data;
  }
  const r = await fetch(`/api/weather?lat=${encodeURIComponent(loc.lat)}&lon=${encodeURIComponent(loc.lon)}`);
  if (!r.ok) throw new Error("weather");
  const data = await r.json();
  if (data && data.error) throw new Error(data.error);
  weatherCache = { at: Date.now(), key, data };
  return data;
}

function renderHome() {
  const grid = $("#dashGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const todayKey = isoDate(new Date());
  const weekKey = weekKeyOf(new Date());

  // — Live weather (Open-Meteo; location set in Settings, defaults to Alton) —
  {
    const card = dashCard("Weather", () => activateTab("settings"));
    const body = card.querySelector(".dash-body");
    const loc = weatherLoc();
    const wx = document.createElement("div");
    wx.className = "dash-weather";
    wx.innerHTML = `<span class="wx-loading">Loading…</span>`;
    body.appendChild(wx);
    loadWeather()
      .then((d) => {
        const { icon, text } = describeWeather(d.code, d.isDay);
        const s = d.soon;
        const tag =
          s && s.emoji && s.label
            ? `<span class="wx-soon">${s.emoji} ${escapeHtml(s.label)} in ${s.hours} hr</span>`
            : "";
        wx.innerHTML =
          `<span class="wx-icon" aria-hidden="true">${icon}</span>` +
          `<span class="wx-temp">${Number.isFinite(d.temp) ? d.temp + "°" : "—"}</span>` +
          `<span class="wx-cond">${escapeHtml(text)}</span>` +
          tag +
          `<span class="wx-place">${escapeHtml(loc.label || "")}</span>`;
      })
      .catch(() => {
        wx.innerHTML = `<span class="wx-err">Weather unavailable right now.</span>`;
      });
    grid.appendChild(card);
  }

  // — Grocery quick-add (top of the screen; items go straight to this week) —
  {
    const card = dashCard("Grocery", () => activateTab("grocery"));
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
    grid.appendChild(card);
  }

  // — This week's recipes (from the Planner) —
  const dishes = weekDishes(weekKey);
  {
    const card = dashCard("Recipes", () => activateTab("plan"));
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

  // — Calendar events for the next 7 days (plus Katie's paydays) —
  {
    const card = dashCard("Calendar", () => activateTab("calendar"));
    const body = card.querySelector(".dash-body");
    // Merge real events and payday markers into one date-ordered list.
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const key = isoDate(d);
      if (isKatiePayday(key)) rows.push({ key, payday: true });
      eventsOnDay(key).forEach((e) => rows.push({ key, ev: e }));
    }
    if (!rows.length) body.appendChild(dashEmpty("Nothing scheduled in the next 7 days."));
    else
      rows.forEach(({ key, ev, payday }) => {
        const row = document.createElement("div");
        const dayTag = `<span class="dash-day">${dashDayLabel(key)}</span>`;
        if (payday) {
          row.className = "dash-row event-row-dash payday-row";
          row.innerHTML =
            dayTag +
            `<span class="pay-ico">$</span>` +
            `<span class="dash-row-title">${escapeHtml(paydayLabel())}</span>`;
          row.addEventListener("click", () => openDayEditor(key));
        } else {
          row.className = "dash-row event-row-dash";
          row.innerHTML =
            dayTag +
            `<span class="event-bubbles">${personBubbles(evPeople(ev))}</span>` +
            (ev.time ? `<span class="dash-time">${fmtTime(ev.time)}</span>` : "") +
            `<span class="dash-row-title">${ev.emoji ? `<span class="ev-emoji">${ev.emoji}</span>` : ""}${escapeHtml(ev.title)}</span>`;
          row.addEventListener("click", () => openDayEditor(key));
        }
        body.appendChild(row);
      });
    grid.appendChild(card);
  }

  // — To-dos due in the next 7 days —
  const dueTodos = todosDueNext7Days();
  {
    const card = dashCard("To-Do", () => {
      notesSubView = "todo";
      activateTab("notes");
    });
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
        // Check the task off (by person / both) right here on the dashboard.
        row.insertBefore(todoDoneControl(t), row.firstChild);
        row.addEventListener("click", () => openTodoEditor(t.quadrant, t.id));
        body.appendChild(row);
      });
    grid.appendChild(card);
  }

  // — Chores completed today (a pip per completion, in each person's colour) —
  const doneToday = tracker.items
    .map((it) => ({ it, counts: activePeople().map((i) => personCount(it, String(i), todayKey)) }))
    .filter((x) => x.counts.some((n) => n > 0));
  {
    const card = dashCard("Chores", () => activateTab("chores"));
    const body = card.querySelector(".dash-body");
    if (!doneToday.length) body.appendChild(dashEmpty("No chores logged today yet."));
    else
      doneToday.forEach(({ it, counts }) => {
        const row = document.createElement("div");
        row.className = "dash-row chore-row-dash";
        row.innerHTML = `<span class="dash-row-title">${escapeHtml(it.name)}</span><span class="dash-pips">${pipBoxes(counts)}</span>`;
        body.appendChild(row);
      });
    const totalDone = doneToday.reduce((n, x) => n + x.counts.reduce((a, b) => a + b, 0), 0);
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
const CHORE_CAT_ORDER = ["General", "Living room", "Kitchen", "Bedroom", "Bathroom", "Outside"];
let tracker = loadTracker(); // { items: [{id,name,category,done:{"0":[],"1":[]}}] }
let trackerPushTimer = null;
let choreViewMode = "list"; // "list" | "assigned" | "history"
let historyRange = "week"; // "week" | "month"
const choreCollapsed = new Set(); // collapsed category names in the checklist
let choreCollapseSeeded = false; // rooms start collapsed on first render for easy scanning

// New households start with an empty chore list and build their own categories —
// no default chores are seeded. (Existing households keep whatever they've synced.)
function maybeSeedChores() {
  localStorage.setItem("mealPlanner.tracker.seeded", "1");
}

function loadTracker() {
  try {
    const t = JSON.parse(localStorage.getItem(TRACKER_KEY));
    if (t && typeof t === "object" && Array.isArray(t.items)) return normalizeTracker(t);
  } catch {
    /* ignore */
  }
  return { items: [], cats: [] };
}
// Normalise a stored/synced tracker: its chore items plus the ordered category
// spine (`cats` = [{name, subs:[]}]) that preserves order and empty categories.
function normalizeTracker(t) {
  const items = t && Array.isArray(t.items) ? normalizeChores(t.items) : [];
  const cats =
    t && Array.isArray(t.cats)
      ? t.cats
          .filter((c) => c && typeof c.name === "string")
          .map((c) => ({
            name: c.name,
            subs: Array.isArray(c.subs) ? c.subs.filter((s) => typeof s === "string") : [],
          }))
      : [];
  return { items, cats };
}
// Per-person completion COUNTS: done = { "0": { "2026-07-30": 2 }, "1": {…} }.
// A chore can be logged multiple times a day, so each date maps to a tally.
function normalizeChores(items) {
  items.forEach((item) => {
    let done = item.done;
    if (!done || typeof done !== "object" || Array.isArray(done)) done = {};
    // Migrate every stored person slot; keep slots for people who no longer exist
    // so their history isn't lost, and ensure a bucket for each current person.
    Object.keys(done).forEach((p) => {
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
    for (let i = 0; i < peopleCount(); i++) if (!done[String(i)]) done[String(i)] = {};
    // very old single `dates` array → attribute past checks to person 0
    if (Array.isArray(item.dates)) item.dates.forEach((d) => (done["0"][d] = (done["0"][d] || 0) + 1));
    item.done = done;
    // Who this chore is assigned to on the Assigned board — an array of person
    // indices (a chore can belong to several). Migrates the old single `assignee`.
    const src = Array.isArray(item.assignees)
      ? item.assignees
      : /^[0-5]$/.test(item.assignee || "")
      ? [item.assignee]
      : [];
    item.assignees = [...new Set(src.filter((p) => /^[0-5]$/.test(p)))];
    delete item.assignee;
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
// Every person slot that has any recorded completion (current people + any older
// slots left behind when the household shrank).
function personKeys(item) {
  return item.done ? Object.keys(item.done) : [];
}
function dayCount(item, key) {
  return personKeys(item).reduce((sum, p) => sum + personCount(item, p, key), 0);
}
// Union of the days anyone logged this chore (for streaks / done-today).
function doneUnion(item) {
  const d = item.done || {};
  const set = new Set();
  personKeys(item).forEach((p) => Object.keys(d[p] || {}).forEach((day) => set.add(day)));
  return set;
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
  if (!item.done) item.done = {};
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
// Clear a person's completions for a day outright (used to uncheck on the
// Assigned board, where the control is a single checkbox rather than a counter).
function clearPersonDate(item, p, key) {
  if (!item.done || !item.done[p]) return;
  delete item.done[p][key];
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
// Filled squares — one per completion, tinted in each person's colour. `counts`
// is an array indexed by person: counts[i] = how many times person i did it.
function pipBoxes(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return "";
  const max = 8;
  let pips = "";
  let shown = 0;
  counts.forEach((n, i) => {
    for (let j = 0; j < n && shown < max; j++, shown++) {
      pips += `<i class="pip" style="${personStyle(i)}" data-p="${i}"></i>`;
    }
  });
  return total > max ? `${pips}<span class="pipn">${total}</span>` : pips;
}
// A bold, unmistakable flame (warm orange with a yellow core) for a kept streak.
function flameIcon() {
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" class="streak-ico">
    <path fill="#ff7a18" d="M13 2c.6 2.7-.4 4.6-1.9 6.3C9.4 10.2 7 12.1 7 15.4A6.4 6.4 0 0 0 13.4 22a6.2 6.2 0 0 0 6.2-6.2c0-2.5-1.3-4.3-2.8-6-1.3-1.5-2.5-3-2.4-5-1 .9-1.7 2-2 3.3C11.9 6 12.7 3.9 13 2z"/>
    <path fill="#ffd23d" d="M12.8 12.4c1 1 1.7 2.1 1.7 3.4a2.8 2.8 0 0 1-5.2 1.4c1 .3 2-.2 2.4-1.1.5-1 .1-2.1-.3-3 .5-.2 1-.5 1.4-.7z"/>
  </svg>`;
}
// A cool snowflake shown when a streak is active but today's chore isn't done
// yet — the streak is "frozen" until it's completed today.
function iceIcon() {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#63c9ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="streak-ico">
    <line x1="12" y1="2.5" x2="12" y2="21.5"/>
    <line x1="3.7" y1="7.2" x2="20.3" y2="16.8"/>
    <line x1="20.3" y1="7.2" x2="3.7" y2="16.8"/>
    <path d="M12 6.2 10.2 8M12 6.2 13.8 8M12 17.8 10.2 16M12 17.8 13.8 16"/>
  </svg>`;
}

// Inline "add" state: which affordance is currently expanded into a text input.
// { kind:"roomChore"|"subChore"|"newSub"|"newCat", cat?, sub? } or null.
let choreAdd = null;
const SUBSEP = String.fromCharCode(31); // delimiter for a room+sub collapse key
const choreId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// Ensure `tracker.cats` (the ordered category spine, with sub-category lists)
// represents every category/sub-category used by a chore. First run seeds it in
// a sensible default order; afterwards it only appends anything missing.
function ensureCats() {
  if (!Array.isArray(tracker.cats)) tracker.cats = [];
  if (!tracker.cats.length && tracker.items.length) {
    [...new Set(tracker.items.map((it) => (it.category || "").trim()).filter(Boolean))]
      .sort(choreCatSort)
      .forEach((name) => tracker.cats.push({ name, subs: [] }));
  }
  const byName = new Map(tracker.cats.map((c) => [c.name, c]));
  tracker.items.forEach((it) => {
    const cn = (it.category || "").trim();
    if (!cn) return;
    let c = byName.get(cn);
    if (!c) {
      c = { name: cn, subs: [] };
      tracker.cats.push(c);
      byName.set(cn, c);
    }
    const sn = (it.subcategory || "").trim();
    if (sn && !c.subs.includes(sn)) c.subs.push(sn);
  });
}

function renderChores() {
  ensureCats();
  const list = $("#choreList");
  list.innerHTML = "";
  const items = tracker.items;

  // Group chores by category for quick lookup.
  const byCat = {};
  items.forEach((it) => {
    const c = (it.category || "").trim();
    (byCat[c] ||= []).push(it);
  });

  if (!choreCollapseSeeded) {
    tracker.cats.forEach((c) => choreCollapsed.add(c.name)); // rooms start collapsed
    choreCollapseSeeded = true;
  }

  const hasAnything = tracker.cats.length || items.length;
  $("#choreEmpty").classList.toggle("hidden", Boolean(hasAnything));

  tracker.cats.forEach((catObj, idx) => {
    list.appendChild(renderChoreCategory(catObj, idx, byCat[catObj.name] || []));
  });

  // Legacy chores with no category — a plain trailing bucket (no edit controls).
  if ((byCat[""] || []).length) {
    const section = document.createElement("div");
    section.className = "chore-group";
    const header = document.createElement("h3");
    header.className = "chore-cat";
    header.innerHTML = `<span class="cat-name">Uncategorised</span> <span class="cat-count">${byCat[""].length}</span>`;
    const itemsWrap = document.createElement("div");
    itemsWrap.className = "chore-items";
    byCat[""].forEach((it) => itemsWrap.appendChild(choreRow(it)));
    section.append(header, itemsWrap);
    list.appendChild(section);
  }

  // "＋ Category" at the very bottom of the list (styled like "＋ sub-category").
  if (choreAdd && choreAdd.kind === "newCat") {
    list.appendChild(inlineAddInput("New category name", "chore-inline-cat", (v) => addCategory(v)));
  } else {
    const addCat = document.createElement("button");
    addCat.type = "button";
    addCat.className = "chore-add-cat";
    addCat.textContent = "＋ Category";
    addCat.addEventListener("click", () => {
      choreAdd = { kind: "newCat" };
      renderChores();
    });
    list.appendChild(addCat);
  }
}

function renderChoreCategory(catObj, idx, roomChores) {
  const cat = catObj.name;
  const collapsed = choreCollapsed.has(cat);
  const section = document.createElement("div");
  section.className = "chore-group" + (collapsed ? " collapsed" : "");
  section.dataset.cat = cat;
  section.dataset.dragkey = cat; // for drag-to-reorder

  const header = document.createElement("h3");
  header.className = "chore-cat";
  header.innerHTML = `<span class="chev">${collapsed ? "▸" : "▾"}</span> <span class="cat-name">${escapeHtml(cat)}</span> <span class="cat-count">${roomChores.length}</span>`;
  header.addEventListener("click", () => {
    const wasCollapsed = choreCollapsed.has(cat);
    toggleCollapse(cat);
    // When a category is opened, its sub-categories start collapsed so the room
    // shows just its general chores + tidy sub-headings to drill into.
    if (wasCollapsed) catObj.subs.forEach((sub) => choreCollapsed.add(cat + SUBSEP + sub));
    renderChores();
  });
  // Right-side controls: Edit-mode reorder/delete + the subtle quick-add "+".
  const actions = document.createElement("span");
  actions.className = "chore-cat-actions";
  const editControls = choreCatEditControls(catObj, roomChores.length);
  actions.appendChild(editControls);
  actions.appendChild(
    choreAddMini(`Add a chore to ${cat}`, () => {
      choreCollapsed.delete(cat);
      choreAdd = { kind: "roomChore", cat };
      renderChores();
    })
  );
  header.appendChild(actions);

  const itemsWrap = document.createElement("div");
  itemsWrap.className = "chore-items";

  // General chores (no sub-category) sit directly under the room.
  const { noSub, subs } = splitBySub(roomChores);
  noSub.forEach((it) => itemsWrap.appendChild(choreRow(it)));
  if (choreAdd && choreAdd.kind === "roomChore" && choreAdd.cat === cat) {
    itemsWrap.appendChild(inlineAddInput(`Add to ${cat}…`, "", (v) => addChoreTo(cat, "", v)));
  }

  // Each sub-category is its own collapsible header beneath the general chores.
  // Rooms with no sub-category render no sub-heading at all.
  catObj.subs.forEach((sub) => {
    const subKey = cat + SUBSEP + sub;
    const subCollapsed = choreCollapsed.has(subKey);
    const subChores = subs[sub] || [];
    const subGroup = document.createElement("div");
    subGroup.className = "chore-subgroup" + (subCollapsed ? " collapsed" : "");
    const subHead = document.createElement("div");
    subHead.className = "chore-subcat";
    subHead.innerHTML = `<span class="chev">${subCollapsed ? "▸" : "▾"}</span> <span class="cat-name">${escapeHtml(sub)}</span> <span class="cat-count">${subChores.length}</span>`;
    subHead.addEventListener("click", () => {
      toggleCollapse(subKey);
      renderChores();
    });
    subHead.appendChild(
      choreAddMini(`Add a chore to ${sub}`, () => {
        choreCollapsed.delete(subKey);
        choreAdd = { kind: "subChore", cat, sub };
        renderChores();
      })
    );
    const subItems = document.createElement("div");
    subItems.className = "chore-subitems";
    subChores.forEach((it) => subItems.appendChild(choreRow(it)));
    if (choreAdd && choreAdd.kind === "subChore" && choreAdd.cat === cat && choreAdd.sub === sub) {
      subItems.appendChild(inlineAddInput(`Add to ${sub}…`, "", (v) => addChoreTo(cat, sub, v)));
    }
    subGroup.append(subHead, subItems);
    itemsWrap.appendChild(subGroup);
  });

  // Subtle, indented affordance to start a brand-new sub-category in this room.
  if (choreAdd && choreAdd.kind === "newSub" && choreAdd.cat === cat) {
    itemsWrap.appendChild(inlineAddInput("New sub-category name", "chore-inline-sub", (v) => addSubcategory(cat, v)));
  } else {
    const addSub = document.createElement("button");
    addSub.type = "button";
    addSub.className = "chore-add-sub";
    addSub.textContent = "＋ sub-category";
    addSub.addEventListener("click", () => {
      choreAdd = { kind: "newSub", cat };
      renderChores();
    });
    itemsWrap.appendChild(addSub);
  }

  section.append(header, itemsWrap);
  // Drag the whole category (via its handle) to reorder among the other categories.
  bindDragSort(section, editControls.querySelector(".drag-handle"), ".chore-group[data-cat]", (keys) =>
    reorderCats(keys)
  );
  return section;
}
function toggleCollapse(key) {
  choreCollapsed.has(key) ? choreCollapsed.delete(key) : choreCollapsed.add(key);
}
// A small, subtle circular "+" used on room and sub-category headers.
function choreAddMini(title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chore-add-mini";
  b.textContent = "+";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", (e) => {
    e.stopPropagation(); // don't toggle the header's collapse
    onClick();
  });
  return b;
}
// A one-line inline add: text box + Add + cancel. Stays open after each add so
// several items can be entered in a row; Escape / ✕ closes it.
function inlineAddInput(placeholder, extraClass, onSubmit) {
  const form = document.createElement("form");
  form.className = "chore-inline-add" + (extraClass ? " " + extraClass : "");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.className = "chore-inline-ok";
  ok.textContent = "Add";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "chore-inline-cancel";
  cancel.textContent = "✕";
  cancel.setAttribute("aria-label", "Cancel");
  form.append(input, ok, cancel);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v) onSubmit(v);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      choreAdd = null;
      renderChores();
    }
  });
  cancel.addEventListener("click", () => {
    choreAdd = null;
    renderChores();
  });
  requestAnimationFrame(() => input.focus());
  return form;
}
function addChoreTo(cat, sub, name) {
  tracker.items.push({ id: choreId(), name, category: cat, subcategory: sub, assignees: [], done: { "0": {}, "1": {} } });
  ensureCats();
  saveTracker();
  renderChores(); // choreAdd stays set -> the input reopens (empty) for the next add
}
function addSubcategory(cat, sub) {
  const c = tracker.cats.find((x) => x.name === cat);
  if (c && !c.subs.includes(sub)) c.subs.push(sub);
  choreCollapsed.delete(cat + SUBSEP + sub);
  saveTracker();
  choreAdd = { kind: "subChore", cat, sub }; // roll straight into adding chores to it
  renderChores();
}
function addCategory(name) {
  if (!tracker.cats.some((x) => x.name === name)) tracker.cats.push({ name, subs: [] });
  choreCollapsed.delete(name);
  saveTracker();
  choreAdd = { kind: "roomChore", cat: name }; // roll straight into adding chores to it
  renderChores();
}
// Edit-mode controls on a category header: a drag handle (reorder) + delete.
function choreCatEditControls(catObj, count) {
  const wrap = document.createElement("span");
  wrap.className = "chore-cat-edit";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "cat-del";
  del.textContent = "✕";
  del.title = count ? "Delete category and its chores" : "Delete category";
  del.setAttribute("aria-label", del.title);
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteCategory(catObj, count);
  });
  wrap.append(dragHandle("Drag to reorder categories"), del);
  return wrap;
}
// A six-dot grip used to start a drag-to-reorder gesture (shown only in Edit
// mode). It's a real button so it's focusable, but its main job is to be grabbed.
function dragHandle(title) {
  const h = document.createElement("button");
  h.type = "button";
  h.className = "drag-handle";
  h.title = title || "Drag to reorder";
  h.setAttribute("aria-label", h.title);
  h.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="currentColor"><circle cx="7" cy="4" r="1.5"/><circle cx="13" cy="4" r="1.5"/><circle cx="7" cy="10" r="1.5"/><circle cx="13" cy="10" r="1.5"/><circle cx="7" cy="16" r="1.5"/><circle cx="13" cy="16" r="1.5"/></svg>`;
  h.addEventListener("click", (e) => e.stopPropagation()); // grabbing ≠ toggling the header
  return h;
}
// Pointer-based drag-to-reorder for one item within its container. Phone-first:
// native HTML5 drag doesn't work on touch, so we use pointer events + capture.
// While dragging, the siblings reflow live under the finger; on drop we read the
// new order of `data-dragkey`s and hand it to onDrop (only if it actually moved).
function bindDragSort(item, handle, itemSel, onDrop) {
  if (!handle) return;
  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const container = item.parentElement;
    if (!container) return;
    e.preventDefault();
    e.stopPropagation();
    // Reordering `item` mid-drag (insertBefore) can silently drop the handle's
    // pointer capture on some browsers, which killed the drag after one step.
    // Listen on `window` instead so moves keep flowing wherever the finger goes;
    // the handle's `touch-action:none` still stops the gesture from scrolling.
    item.classList.add("drag-active");
    const orderKeys = () =>
      [...container.children].filter((c) => c.matches(itemSel)).map((c) => c.dataset.dragkey);
    const initial = orderKeys().join("|");

    const onMove = (ev) => {
      ev.preventDefault();
      const y = ev.clientY;
      const sibs = [...container.children].filter((c) => c !== item && c.matches(itemSel));
      let target = null;
      for (const s of sibs) {
        const r = s.getBoundingClientRect();
        if (y < r.top + r.height / 2) { target = s; break; }
      }
      if (target) container.insertBefore(item, target);
      else {
        const last = sibs[sibs.length - 1]; // drop at the end of the group
        if (last && last.nextSibling !== item) container.insertBefore(item, last.nextSibling);
      }
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      item.classList.remove("drag-active");
      const keys = orderKeys();
      if (keys.join("|") !== initial) onDrop(keys);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  });
}
// Reorder the category spine to match the dropped order of category names.
function reorderCats(orderedNames) {
  const byName = {};
  tracker.cats.forEach((c) => { byName[c.name] = c; });
  const next = [];
  orderedNames.forEach((n) => { if (byName[n] && !next.includes(byName[n])) next.push(byName[n]); });
  tracker.cats.forEach((c) => { if (!next.includes(c)) next.push(c); }); // safety: keep any stragglers
  tracker.cats = next;
  saveTracker();
  renderChores();
}
// Reorder chores *within one group* (same category + sub-category). `tracker.items`
// is a flat list, so we only permute the slots this group's ids occupy, leaving
// every other chore exactly where it was.
function reorderItemsWithin(orderedIds) {
  const idSet = new Set(orderedIds);
  const slots = [];
  const byId = {};
  tracker.items.forEach((it, i) => {
    if (idSet.has(it.id)) { slots.push(i); byId[it.id] = it; }
  });
  orderedIds.forEach((id, k) => {
    if (byId[id] && slots[k] != null) tracker.items[slots[k]] = byId[id];
  });
  saveTracker();
  renderChores();
}
function deleteCategory(catObj, count) {
  if (count && !confirm(`Delete "${catObj.name}" and its ${count} chore${count === 1 ? "" : "s"}?`)) return;
  tracker.items = tracker.items.filter((it) => (it.category || "").trim() !== catObj.name);
  tracker.cats = tracker.cats.filter((c) => c !== catObj);
  saveTracker();
  renderChores();
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
// Split a room's chores into the ones with no sub-category (listed directly
// under the room) and the ones grouped under an optional sub-category heading.
function splitBySub(roomItems) {
  const noSub = [];
  const subs = {};
  roomItems.forEach((it) => {
    const s = (it.subcategory || "").trim();
    if (s) (subs[s] ||= []).push(it);
    else noSub.push(it);
  });
  const subNames = Object.keys(subs).sort((a, b) => a.localeCompare(b));
  return { noSub, subs, subNames };
}
function renderActiveChoreView() {
  const isList = choreViewMode === "list";
  // "Edit" and "Assign" only apply to the checklist.
  $("#choreEdit").classList.toggle("hidden", !isList);
  $("#choreAssign").classList.toggle("hidden", !isList);
  if (!isList) exitChoreModes();
  if (choreViewMode === "history") renderHistory();
  else if (choreViewMode === "assigned") renderAssigned();
  else renderChores();
}
// The Assigned board: one card per person listing the chores assigned to them,
// each tappable to log a completion for that person (hold to remove one).
function renderAssigned() {
  const wrap = $("#choreAssigned");
  if (!wrap) return;
  wrap.innerHTML = "";
  const today = isoDate(new Date());
  activePeople().forEach((pi) => {
    const p = String(pi);
    const mine = tracker.items.filter((it) => (it.assignees || []).includes(p));
    const card = document.createElement("div");
    card.className = "assigned-card";
    card.setAttribute("style", personStyle(pi));
    const head = document.createElement("div");
    head.className = "assigned-head";
    head.innerHTML = `<span class="pbubble" style="${personStyle(pi)}">${escapeHtml(personInitial(pi))}</span> <span class="assigned-name">${escapeHtml(personName(pi))}</span> <span class="assigned-count">${mine.length}</span>`;
    card.appendChild(head);
    if (!mine.length) {
      const empty = document.createElement("div");
      empty.className = "assigned-empty";
      empty.textContent = "No chores assigned yet.";
      card.appendChild(empty);
    } else {
      mine.forEach((it) => {
        const n = personCount(it, p, today);
        const done = n > 0;
        const rowEl = document.createElement("div");
        rowEl.className = "assigned-item" + (done ? " done" : "");
        const trail = [it.category, it.subcategory].filter(Boolean).join(" › ");
        rowEl.innerHTML = `
          <button type="button" class="assigned-check${done ? " on" : ""}" style="${personStyle(pi)}" role="checkbox" aria-checked="${done}" aria-label="${done ? "Uncheck" : "Check off"} ${escapeHtml(it.name)}">${done ? "✓" : ""}</button>
          <span class="assigned-item-name">${escapeHtml(it.name)}${trail ? `<span class="assigned-item-cat">${escapeHtml(trail)}</span>` : ""}</span>
          ${n > 1 ? `<span class="assigned-item-n">${n}×</span>` : ""}`;
        // Checkbox toggle: tap an unchecked chore to mark it done, tap a checked
        // one to clear it (press-hold still removes a single completion).
        bindCount(
          rowEl.querySelector(".assigned-check"),
          () => {
            if (personCount(it, p, today) > 0) clearPersonDate(it, p, today);
            else incPersonDate(it, p, today);
            renderAssigned();
          },
          () => { decPersonDate(it, p, today); renderAssigned(); }
        );
        card.appendChild(rowEl);
      });
    }
    wrap.appendChild(card);
  });
}
// Leave any temporary checklist mode (Edit / Assign) and reset the toggle buttons.
function exitChoreModes() {
  $("#choreChecklist").classList.remove("editing", "assigning");
  updateChoreModeButtons();
}
function updateChoreModeButtons() {
  const cl = $("#choreChecklist").classList;
  const editing = cl.contains("editing");
  const assigning = cl.contains("assigning");
  $("#choreEdit").classList.toggle("on", editing);
  $("#choreEdit").textContent = editing ? "Done" : "Edit";
  $("#choreAssign").classList.toggle("on", assigning);
  $("#choreAssign").textContent = assigning ? "Done" : "Assign";
}

// ---- Assign mode: a temporary state on the checklist (toggled like Edit). While
// it's on, the two A/K buttons already on each chore assign that chore to a person
// (instead of logging a completion). Tap the assigned person again to unassign. ----
function toggleAssignee(item, p) {
  if (!Array.isArray(item.assignees)) item.assignees = [];
  const i = item.assignees.indexOf(p);
  if (i === -1) item.assignees.push(p);
  else item.assignees.splice(i, 1);
  saveTracker();
  renderChores(); // repaint bubble fills + the assignee stripe
}

// Edit and Assign are mutually-exclusive temporary modes over the checklist; each
// re-renders the rows so the A/K buttons pick up the right behaviour and visuals.
$("#choreEdit").addEventListener("click", () => {
  const cl = $("#choreChecklist").classList;
  const willEdit = !cl.contains("editing");
  cl.toggle("editing", willEdit);
  if (willEdit) cl.remove("assigning");
  updateChoreModeButtons();
  renderChores();
});
$("#choreAssign").addEventListener("click", () => {
  const cl = $("#choreChecklist").classList;
  const willAssign = !cl.contains("assigning");
  cl.toggle("assigning", willAssign);
  if (willAssign) cl.remove("editing");
  updateChoreModeButtons();
  renderChores();
});

// ---- Household members editor (Settings tab). Names + colours are one synced
// blob; the household holds 2–6 people, added/removed from the tail so existing
// per-person data (completions, assignments) keeps its slot. ----
// Render one row per member: colour chip, name, and a remove ✕ on the last row
// (only when above the minimum). Re-run whenever the household changes.
function renderPeopleEditor() {
  const list = document.getElementById("peopleList");
  if (!list) return;
  // Don't clobber a field the user is mid-edit (e.g. a sync arriving while typing).
  const active = document.activeElement;
  if (active && list.contains(active)) return;
  const n = peopleCount();
  list.innerHTML = settings.people
    .map((name, i) => {
      const removable = i === n - 1 && n > PEOPLE_MIN;
      return `<div class="person-row" data-i="${i}">
          <input type="color" class="person-color" id="colorInput${i}" value="${personColor(i)}" aria-label="${escapeHtml(
        personName(i)
      )} colour" title="${escapeHtml(personName(i))} colour" />
          <input type="text" class="person-name" id="nameInput${i}" maxlength="20" autocomplete="off" spellcheck="false" value="${escapeHtml(
        name
      )}" placeholder="Person ${i + 1}" />
          ${
            removable
              ? `<button type="button" class="person-remove" aria-label="Remove ${escapeHtml(personName(i))}">✕</button>`
              : `<span class="person-remove-spacer" aria-hidden="true"></span>`
          }
        </div>`;
    })
    .join("");
  const addBtn = document.getElementById("addPersonBtn");
  if (addBtn) addBtn.classList.toggle("hidden", n >= PEOPLE_MAX);
}
// Gather the editor's current values into a fresh, normalised settings blob.
function readPeopleEditor() {
  const people = [];
  const colors = [];
  for (let i = 0; i < peopleCount(); i++) {
    people.push(document.getElementById("nameInput" + i)?.value || "");
    colors.push(document.getElementById("colorInput" + i)?.value || personColor(i));
  }
  return normalizeSettings({ people, colors });
}
function saveNamesEditor() {
  settings = readPeopleEditor();
  saveSettings();
  applyPeopleLabels(); // refresh legend/picker/editor and repaint the person colours
  renderActiveChoreView();
  renderCalendarIfActive();
  toast("Household saved");
}
$("#namesEditor")?.addEventListener("submit", (e) => {
  e.preventDefault();
  saveNamesEditor();
});
// Add a new member at the tail (seeded with a default name + hue), then let the
// user rename it. Persists immediately so a half-added person still syncs.
$("#addPersonBtn")?.addEventListener("click", () => {
  if (peopleCount() >= PEOPLE_MAX) return;
  settings = readPeopleEditor();
  const i = settings.people.length;
  settings.people.push(DEFAULT_PEOPLE[i] || `Person ${i + 1}`);
  settings.colors.push(DEFAULT_COLORS[i] || DEFAULT_COLORS[0]);
  saveSettings();
  applyPeopleLabels();
  renderActiveChoreView();
  renderCalendarIfActive();
});
// Remove the last member (delegated, since rows are re-rendered).
$("#peopleList")?.addEventListener("click", (e) => {
  if (!e.target.closest(".person-remove")) return;
  if (peopleCount() <= PEOPLE_MIN) return;
  settings = readPeopleEditor();
  settings.people.pop();
  settings.colors.pop();
  saveSettings();
  applyPeopleLabels();
  renderActiveChoreView();
  renderCalendarIfActive();
  toast("Household saved");
});
// Live preview while dragging any colour wheel; commit + sync on release. A name
// change commits on blur.
$("#peopleList")?.addEventListener("input", (e) => {
  if (e.target.matches('input[type="color"]') && window.Theme) {
    const colors = settings.people.map((_, i) => document.getElementById("colorInput" + i)?.value || personColor(i));
    window.Theme.applyPersonColors(colors);
  }
});
$("#peopleList")?.addEventListener("change", (e) => {
  if (e.target.matches("input")) saveNamesEditor();
});

// ---- Per-device: start the calendar week on Monday (Settings tab). Stored
// locally (not synced), so each device chooses its own layout. ----
(() => {
  const cb = document.getElementById("weekStartMonday");
  if (!cb) return;
  cb.checked = weekStartsMonday();
  cb.addEventListener("change", () => {
    localStorage.setItem(WEEKSTART_KEY, cb.checked ? "mon" : "sun");
    renderCalendarIfActive();
  });
})();

// ---- Weather location editor (Settings tab). Types a town, geocodes it via
// the server, and stores {label,lat,lon} in the synced settings blob. ----
function renderWeatherInput() {
  const input = document.getElementById("weatherInput");
  if (input && document.activeElement !== input) input.value = weatherLoc().label || "";
}
(() => {
  const form = document.getElementById("weatherForm");
  const input = document.getElementById("weatherInput");
  const out = document.getElementById("weatherResults");
  if (!form || !input || !out) return;
  renderWeatherInput();

  // Commit a chosen place: save it, clear the picker, and refresh the card.
  function choose(place) {
    const label = [place.name, place.admin1 || place.country].filter(Boolean).join(", ");
    settings = normalizeSettings({ ...settings, weather: { label, lat: place.lat, lon: place.lon } });
    saveSettings();
    weatherCache = null; // force a fresh reading for the new spot
    out.innerHTML = "";
    input.value = label;
    renderHomeIfActive();
    toast(`Weather set to ${label}`);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    out.innerHTML = `<div class="weather-hint">Searching…</div>`;
    try {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const j = await r.json();
      const results = (j && j.results) || [];
      if (!results.length) {
        out.innerHTML = `<div class="weather-hint">No matches — try adding the state or country.</div>`;
        return;
      }
      if (results.length === 1) return choose(results[0]);
      // Multiple hits: let the user pick the right one.
      out.innerHTML = "";
      results.forEach((p) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "weather-choice";
        b.textContent = [p.name, p.admin1, p.country].filter(Boolean).join(", ");
        b.addEventListener("click", () => choose(p));
        out.appendChild(b);
      });
    } catch {
      out.innerHTML = `<div class="weather-hint">Couldn't look that up right now.</div>`;
    }
  });
})();

// ---- Colour-theme editor (Settings tab) ----
// State lives in window.Theme (theme.js); it is a per-device preference and is
// NOT synced. This just renders the picker and forwards changes to Theme.apply.
// (The two person colours are a separate, household-synced setting — edited up
// in the names editor, not here.)
const CUSTOM_ROLES = [
  { key: "bg", label: "Background" },
  { key: "card", label: "Cards" },
  { key: "ink", label: "Text" },
  { key: "accent", label: "Accent" },
];

function renderThemeEditor() {
  const grid = $("#themeGrid");
  if (!grid || !window.Theme) return;
  const state = window.Theme.load();
  const activeId = state.mode === "custom" ? "custom" : state.preset || "sage";

  // Build one card per preset, plus a "Custom" card at the end.
  const cards = window.Theme.PRESETS.map((p) => ({ id: p.id, name: p.name, swatch: [p.base.bg, p.base.card, p.base.accent, p.base.ink] }));
  cards.push({ id: "custom", name: "Custom", swatch: window.Theme.swatchFor(state.mode === "custom" ? state : { mode: "custom", custom: window.Theme.baseFor(state) }) });

  grid.innerHTML = cards
    .map((c) => {
      const on = c.id === activeId;
      const swatches = c.swatch.map((col) => `<span style="background:${col}"></span>`).join("");
      return `<button type="button" class="theme-card${on ? " active" : ""}" role="radio" aria-checked="${on}" data-theme="${c.id}">
          <span class="theme-swatches">${swatches}</span>
          <span class="theme-name">${escapeHtml(c.name)}<span class="tick">✓</span></span>
        </button>`;
    })
    .join("");

  renderCustomSwatches(state);
  $("#customTheme").classList.toggle("hidden", activeId !== "custom");
}

function renderCustomSwatches(state) {
  const wrap = $("#customSwatches");
  if (!wrap) return;
  const base = window.Theme.baseFor(state);
  wrap.innerHTML = CUSTOM_ROLES.map((r) => {
    const label = typeof r.label === "function" ? r.label() : r.label;
    const val = base[r.key];
    return `<div class="swatch-row">
        <label for="sw-${r.key}">${escapeHtml(label)}</label>
        <span class="swatch-hex" data-hex="${r.key}">${val}</span>
        <input type="color" id="sw-${r.key}" data-role="${r.key}" value="${val}" aria-label="${escapeHtml(label)} colour" />
      </div>`;
  }).join("");
}

// Pick a preset (or open the custom editor) — apply live and persist.
$("#themeGrid")?.addEventListener("click", (e) => {
  const card = e.target.closest(".theme-card");
  if (!card) return;
  const id = card.dataset.theme;
  let state;
  if (id === "custom") {
    // Seed the custom palette from whatever is showing now.
    state = { mode: "custom", custom: window.Theme.baseFor(window.Theme.load()) };
  } else {
    state = { mode: "preset", preset: id };
  }
  window.Theme.save(state);
  window.Theme.apply(state);
  renderThemeEditor();
});

// Live-update a single colour as the user drags the wheel.
$("#customSwatches")?.addEventListener("input", (e) => {
  const input = e.target.closest('input[type="color"]');
  if (!input) return;
  const role = input.dataset.role;
  const state = window.Theme.load();
  const custom = state.mode === "custom" ? Object.assign({}, state.custom) : window.Theme.baseFor(state);
  custom[role] = input.value;
  const next = { mode: "custom", custom };
  window.Theme.save(next);
  window.Theme.apply(next);
  const hex = $(`.swatch-hex[data-hex="${role}"]`);
  if (hex) hex.textContent = input.value;
  // Keep the "Custom" card preview in step without a full re-render (which would
  // steal focus from the open colour picker).
  const card = document.querySelector('.theme-card[data-theme="custom"] .theme-swatches');
  if (card) {
    const s = window.Theme.swatchFor(next);
    card.innerHTML = s.map((col) => `<span style="background:${col}"></span>`).join("");
  }
});

$("#themeResetCustom")?.addEventListener("click", () => {
  const next = { mode: "custom", custom: Object.assign({}, window.Theme.SAGE_BASE) };
  window.Theme.save(next);
  window.Theme.apply(next);
  renderThemeEditor();
});

// ---- Account block in Settings (only meaningful when the passcode gate is on) ----
function applyAccountInfo(cfg) {
  const on = Boolean(cfg && cfg.authOn);
  $("#accountBlock").classList.toggle("hidden", !on);
  if (on && cfg.household) {
    $("#householdLabel").textContent = `Signed in to: ${cfg.household}`;
  }
}
$("#signOutBtn").addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    /* even if the request fails, clear local state and reload to the gate */
  }
  localStorage.clear(); // don't leak this household's cached data to the next login
  location.reload();
});

// A left-edge stripe showing who a chore is assigned to. One colour band per
// assignee, stacked top→bottom, each an inset box-shadow so the stripe hugs the
// card's rounded corners (the same wrapped look a single assignment has).
function assigneeStripe(assignees) {
  const ps = assignees.filter((p) => Number(p) < peopleCount());
  if (!ps.length) return "";
  const n = ps.length;
  const segs = ps
    .map((p, i) => {
      const radius =
        n === 1 ? "var(--r)" : i === 0 ? "var(--r) var(--r) 0 0" : i === n - 1 ? "0 0 var(--r) var(--r)" : "0";
      return `<span class="astripe-seg" style="top:${(i * 100) / n}%;height:${
        100 / n
      }%;border-radius:${radius};--pc:${personColor(Number(p))}"></span>`;
    })
    .join("");
  return `<span class="astripe" aria-hidden="true">${segs}</span>`;
}

function choreRow(item) {
  const row = document.createElement("div");
  const done = choreDoneToday(item);
  const assigning = $("#choreChecklist").classList.contains("assigning");
  const assignees = Array.isArray(item.assignees) ? item.assignees : [];
  row.className = "chore-item" + (done ? " done" : "") + (assigning ? " assign-mode" : "");
  const today = isoDate(new Date());
  const streak = choreStreak(item);
  const counts = activePeople().map((i) => personCount(item, String(i), today));
  // One button per household member. `pi` drives the person's colour (inline --pc);
  // the letter is just the displayed initial. In Assign mode the same buttons pick
  // who the chore belongs to (filled = theirs) instead of logging a completion.
  const pbtn = (pi) => {
    const p = String(pi);
    const letter = personInitial(pi);
    const name = personName(pi);
    const n = counts[pi];
    if (assigning) {
      const on = assignees.includes(p);
      const t = on ? `Assigned to ${name} — tap to unassign` : `Assign to ${name}`;
      return `<button type="button" class="pbtn${on ? " assign-on" : ""}" style="${personStyle(pi)}" data-p="${p}" aria-pressed="${on}" aria-label="${escapeHtml(t)}" title="${escapeHtml(t)}">${escapeHtml(letter)}</button>`;
    }
    return `<button type="button" class="pbtn${n > 0 ? " on" : ""}" style="${personStyle(pi)}" data-p="${p}" aria-label="${escapeHtml(name)} did this${n > 1 ? " (" + n + "×)" : ""}" title="${escapeHtml(name)} — tap to add, hold to remove">${escapeHtml(letter)}</button>`;
  };
  row.innerHTML = `
    <div class="chore-people">
      ${activePeople().map((i) => pbtn(i)).join("")}
    </div>
    <span class="chore-name">${escapeHtml(item.name)}</span>
    <span class="chore-marks">${pipBoxes(counts)}</span>
    <span class="chore-tags">
      ${streak >= 3
        ? `<span class="streak-pill ${done ? "hot" : "cold"}" title="${
            done
              ? streak + "-day streak — kept today!"
              : streak + "-day streak — frozen; do it today to keep it going"
          }">${done ? flameIcon() : iceIcon()} ${streak}</span>`
        : ""}
    </span>
    <button class="chore-del" aria-label="Delete">✕</button>`;
  // The "whose job" stripe wraps the left edge (absolutely positioned, so it sits
  // behind the row content without affecting the flex layout).
  row.insertAdjacentHTML("beforeend", assigneeStripe(assignees));
  row.querySelectorAll(".pbtn").forEach((btn) => {
    const p = btn.dataset.p;
    if (assigning) {
      // Assign mode: a plain tap assigns/unassigns — no completion logging.
      btn.addEventListener("click", () => toggleAssignee(item, p));
    } else {
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
    }
  });
  // Click a filled box to remove that person's completion (each pip carries its
  // owner's index).
  row.querySelectorAll(".chore-marks .pip").forEach((pip) => {
    pip.title = "Remove one completion";
    pip.addEventListener("click", () => {
      decPersonDate(item, pip.dataset.p, today);
      renderChores();
    });
  });
  row.querySelector(".chore-del").addEventListener("click", () => {
    tracker.items = tracker.items.filter((x) => x.id !== item.id);
    saveTracker();
    renderChores();
  });
  // Drag handle (Edit mode) to reorder this chore within its group.
  row.dataset.dragkey = item.id;
  const handle = dragHandle("Drag to reorder chore");
  row.insertBefore(handle, row.firstChild);
  bindDragSort(row, handle, ".chore-item", (keys) => reorderItemsWithin(keys));
  return row;
}

document.querySelectorAll("#choreView .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    choreViewMode = btn.dataset.view;
    document.querySelectorAll("#choreView .chip").forEach((b) => b.classList.toggle("active", b === btn));
    $("#choreChecklist").classList.toggle("hidden", choreViewMode !== "list");
    $("#choreHistory").classList.toggle("hidden", choreViewMode !== "history");
    $("#choreAssigned").classList.toggle("hidden", choreViewMode !== "assigned");
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

// Fill for a history cell: solid in one person's colour, or a diagonal split
// between everyone who did the chore that day (equal bands). `showCount` shows a
// centred tally when a single person did it more than once (week view only).
function cellFill(item, key, showCount) {
  const doers = activePeople()
    .map((i) => ({ i, n: personCount(item, String(i), key) }))
    .filter((d) => d.n > 0);
  if (!doers.length) return { style: "", inner: "" };
  let bg;
  if (doers.length === 1) {
    bg = personColor(doers[0].i);
  } else {
    const stops = doers
      .map((d, idx) => `${personColor(d.i)} ${(idx * 100) / doers.length}% ${((idx + 1) * 100) / doers.length}%`)
      .join(", ");
    bg = `linear-gradient(135deg, ${stops})`;
  }
  const inner = showCount && doers.length === 1 && doers[0].n > 1 ? `<span class="cellnum">${doers[0].n}</span>` : "";
  return { style: `background:${bg}`, inner };
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

  const histRow = (it) => {
    let r = `<tr><td class="hist-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</td>`;
    days.forEach((d, i) => {
      const key = isoDate(d);
      const isToday = key === todayKey;
      const weekStart = isMonth && i % 7 === 0;
      const { style, inner } = cellFill(it, key, showCount);
      r += `<td class="hist-cell${isToday ? " today" : ""}${weekStart ? " week-start" : ""}"><span class="cell" style="${style}">${inner}</span></td>`;
    });
    return r + `</tr>`;
  };
  let body = `<tbody>`;
  Object.keys(groups)
    .sort(choreCatSort)
    .forEach((cat) => {
      body += `<tr class="hist-room"><td colspan="${days.length + 1}">${escapeHtml(cat || "Other")}</td></tr>`;
      const { noSub, subs, subNames } = splitBySub(groups[cat]);
      noSub.forEach((it) => (body += histRow(it)));
      subNames.forEach((sub) => {
        body += `<tr class="hist-subcat"><td colspan="${days.length + 1}">${escapeHtml(sub)}</td></tr>`;
        subs[sub].forEach((it) => (body += histRow(it)));
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

// ---- "What's new" changelog -------------------------------------------------
// Show any changelog entries this device hasn't acknowledged yet, then record
// the current build so they aren't shown again. First-ever installs are marked
// caught-up without a popup (there's nothing "new" to a fresh install).
function maybeShowWhatsNew() {
  let seen = parseInt(localStorage.getItem(SEEN_BUILD_KEY), 10);
  if (!Number.isFinite(seen)) {
    // No "seen" marker yet. Tell two cases apart:
    //  • Brand-new install — nothing is "new" to them, so catch up silently.
    //  • Existing device from before this feature shipped — it already has app
    //    data, so show the changelog once (treat as never having seen anything).
    const usedBefore = Object.keys(localStorage).some((k) => k.startsWith("mealPlanner."));
    if (!usedBefore) {
      localStorage.setItem(SEEN_BUILD_KEY, String(APP_BUILD));
      return;
    }
    seen = 0; // existing user: everything from build 1 up is new to them
  }
  const unseen = CHANGELOG.filter((e) => e.build > seen).sort((a, b) => b.build - a.build);
  if (!unseen.length) return;

  $("#whatsNewBody").innerHTML = unseen
    .map(
      (e) => `
      <div class="whatsnew-release">
        <p class="whatsnew-date">${escapeHtml(e.date || "")}</p>
        <ul class="whatsnew-list">
          ${e.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}
        </ul>
      </div>`
    )
    .join("");
  $("#whatsNew").classList.remove("hidden");
}
function dismissWhatsNew() {
  $("#whatsNew").classList.add("hidden");
  localStorage.setItem(SEEN_BUILD_KEY, String(APP_BUILD)); // mark caught up
}
{
  const wn = $("#whatsNew");
  $("#whatsNewClose").addEventListener("click", dismissWhatsNew);
  $("#whatsNewGotIt").addEventListener("click", dismissWhatsNew);
  wn.addEventListener("click", (e) => {
    if (e.target === wn) dismissWhatsNew();
  });
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
      </div>
      <div class="recipe-notes" id="recipeNotes"></div>`;

    // Editable notes — available once the recipe is favorited.
    let noteSaveTimer = null;
    function renderRecipeNotes() {
      const box = $("#recipeNotes");
      if (!box) return;
      if (!isFavorite(r.id)) {
        box.innerHTML = `<p class="notes-hint">${notepadIcon(15)} Favorite this recipe to add your own notes.</p>`;
        return;
      }
      box.innerHTML = `
        <label class="notes-head" for="favNoteInput">${notepadIcon(16)} <span>Notes</span></label>
        <textarea id="favNoteInput" class="notes-input" rows="3"
          placeholder="Tweaks, swaps, who liked it…">${escapeHtml(getFavNote(r.id))}</textarea>`;
      const ta = $("#favNoteInput");
      ta.addEventListener("input", () => {
        clearTimeout(noteSaveTimer);
        noteSaveTimer = setTimeout(() => setFavNote(r.id, ta.value), 400);
      });
      ta.addEventListener("blur", () => {
        clearTimeout(noteSaveTimer);
        setFavNote(r.id, ta.value);
      });
    }
    renderRecipeNotes();
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
      renderRecipeNotes(); // show/hide the notes editor to match fav state
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
function notepadIcon(size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/><line x1="8.5" y1="12.5" x2="15" y2="12.5"/><line x1="8.5" y1="16" x2="13" y2="16"/></svg>`;
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
  applyPeopleLabels(); // reflect saved names in the legend/pickers before first paint
  renderPlanner();
  renderCalendar();
  renderHome(); // Home dashboard is the default landing view
  try {
    const cfg = await (await fetch("/api/config")).json();
    if (!cfg.hasKey) $("#keyBanner").classList.remove("hidden");
    syncEnabled = Boolean(cfg.storage);
    household = cfg.household || "local";
    guardHouseholdData(); // drop another household's cached data before it can sync up
    applyAccountInfo(cfg);
    renderCalendarIfActive(); // paint Katie's paydays once the household is known
    renderHomeIfActive();
    await initSync();
  } catch {
    /* server not reachable yet — ignore */
  }
  maybeSeedChores(); // one-time: load the House Chores list if the tracker is empty
  runSearch(); // friendly starter results
  setTopbarHeight();
  maybeShowWhatsNew(); // greet with a changelog if this device is behind
}

// Track the sticky app-bar height so the history weekday row can sit just below it.
function setTopbarHeight() {
  const tb = document.querySelector(".topbar");
  if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
}
window.addEventListener("resize", setTopbarHeight);
window.addEventListener("load", setTopbarHeight);

// Register the service worker so Homebase is installable and works offline.
// Content stays fresh via the worker's network-first strategy, so no reload dance.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {
      /* SW unsupported or blocked — the app still works as a normal page */
    });
  });
}

init();
