// ---------- State ----------
const STORAGE_KEY = "mealPlanner.week.v1";
let week = loadWeek(); // array of { id, title, image, readyInMinutes, servings }

function loadWeek() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}
function saveWeek() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(week));
  updateWeekCount();
}
function inWeek(id) {
  return week.some((r) => String(r.id) === String(id));
}

// ---------- Elements ----------
const $ = (sel) => document.querySelector(sel);
const results = $("#results");
const weekList = $("#weekList");
const weekEmpty = $("#weekEmpty");
const groceryList = $("#groceryList");
const groceryEmpty = $("#groceryEmpty");
const groceryMeta = $("#groceryMeta");

// ---------- Tabs ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});
function activateTab(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".panel").forEach((p) =>
    p.classList.toggle("active", p.id === `tab-${name}`)
  );
  if (name === "week") renderWeek();
}

// ---------- Search ----------
let searchMode = "dish"; // "dish" = by title, "ingredients" = by what you have on hand

$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});
// Re-run the search immediately when any filter changes.
$("#dietSelect").addEventListener("change", runSearch);
$("#calFilter").addEventListener("change", runSearch);
$("#gfFilter").addEventListener("change", runSearch);

// Search-mode toggle (Dish name vs Ingredients I have).
document.querySelectorAll("#searchMode .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    searchMode = btn.dataset.mode;
    document
      .querySelectorAll("#searchMode .seg")
      .forEach((b) => b.classList.toggle("active", b === btn));
    const input = $("#searchInput");
    if (searchMode === "ingredients") {
      input.placeholder = "Ingredients you have… e.g. ground beef, rice, onion";
      $("#searchHint").innerHTML =
        "Searching by <strong>ingredients you have</strong>. List them comma-separated — recipes that use the most of them show first.";
    } else {
      input.placeholder = "Search dishes, ingredients… e.g. chicken pasta, tacos, salmon";
      $("#searchHint").innerHTML =
        "Searching by <strong>dish name</strong>. Switch to “Ingredients I have” to cook with what's already in your kitchen.";
    }
    if (input.value.trim()) runSearch();
  });
});

async function runSearch() {
  const query = $("#searchInput").value.trim();
  const diet = $("#dietSelect").value;
  const under500 = $("#calFilter").checked;
  const gf = $("#gfFilter").checked;
  results.innerHTML = `<div class="loading"><div class="spinner"></div>Searching recipes…</div>`;
  try {
    const params = new URLSearchParams({ query, diet, number: "12", mode: searchMode });
    if (under500) params.set("under500", "1");
    if (gf) params.set("gf", "1");
    const res = await fetch(`/api/search?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");
    renderResults(data.results);
  } catch (err) {
    results.innerHTML = `<div class="empty">😕 ${escapeHtml(err.message)}</div>`;
  }
}

function renderResults(list) {
  if (!list || !list.length) {
    results.innerHTML = `<div class="empty">No recipes found. Try a different search.</div>`;
    return;
  }
  results.innerHTML = "";
  list.forEach((r) => results.appendChild(recipeCard(r, "search")));
}

// ---------- Cards ----------
function recipeCard(r, context) {
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
  if (context === "week") {
    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      week = week.filter((x) => String(x.id) !== String(r.id));
      saveWeek();
      renderWeek();
    });
    actions.appendChild(remove);
  } else {
    const add = document.createElement("button");
    add.className = "add-btn" + (inWeek(r.id) ? " added" : "");
    add.textContent = inWeek(r.id) ? "✓ In week" : "＋ Add to week";
    add.addEventListener("click", () => {
      if (inWeek(r.id)) return;
      week.push({
        id: r.id,
        title: r.title,
        image: r.image,
        readyInMinutes: r.readyInMinutes,
        servings: r.servings,
        calories: r.calories,
      });
      saveWeek();
      add.classList.add("added");
      add.textContent = "✓ In week";
      toast(`Added “${r.title}” to this week`);
    });
    actions.appendChild(add);
  }
  return card;
}

// ---------- This Week ----------
function renderWeek() {
  weekList.innerHTML = "";
  if (!week.length) {
    weekEmpty.classList.remove("hidden");
    $("#makeGrocery").disabled = true;
    $("#makeGrocery").style.opacity = 0.5;
  } else {
    weekEmpty.classList.add("hidden");
    $("#makeGrocery").disabled = false;
    $("#makeGrocery").style.opacity = 1;
    week.forEach((r) => weekList.appendChild(recipeCard(r, "week")));
  }
}
$("#clearWeek").addEventListener("click", () => {
  if (!week.length) return;
  if (confirm("Remove all dishes from this week?")) {
    week = [];
    saveWeek();
    renderWeek();
  }
});

// ---------- Grocery list ----------
$("#makeGrocery").addEventListener("click", buildGrocery);

async function buildGrocery() {
  if (!week.length) return;
  activateTab("grocery");
  groceryEmpty.classList.add("hidden");
  groceryList.innerHTML = `<div class="loading"><div class="spinner"></div>Building your grocery list…</div>`;
  groceryMeta.textContent = "";
  try {
    const ids = week.map((r) => r.id).join(",");
    const res = await fetch(`/api/recipes?ids=${encodeURIComponent(ids)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load ingredients");
    renderGrocery(data.recipes);
  } catch (err) {
    groceryList.innerHTML = `<div class="empty">😕 ${escapeHtml(err.message)}</div>`;
  }
}

function renderGrocery(recipes) {
  // Combine ingredients across all recipes.
  // Key on name + unit so "2 cup" + "1 cup" sums, but "cloves" vs "cup" stay separate.
  const combined = new Map();
  recipes.forEach((recipe) => {
    (recipe.ingredients || []).forEach((ing) => {
      const name = (ing.name || "").trim();
      if (!name) return;
      const unit = (ing.unit || "").trim().toLowerCase();
      const key = `${name.toLowerCase()}|${unit}`;
      if (!combined.has(key)) {
        combined.set(key, {
          name,
          unit,
          amount: 0,
          aisle: ing.aisle || "Other",
          usedIn: new Set(),
        });
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

  // Group by aisle.
  const byAisle = {};
  for (const item of combined.values()) {
    (byAisle[item.aisle] ||= []).push(item);
  }
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

  const dishCount = recipes.length;
  const itemCount = combined.size;
  groceryMeta.textContent = `${itemCount} items for ${dishCount} dish${dishCount === 1 ? "" : "es"}. Tap an item to check it off.`;
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

// ---------- Grocery actions ----------
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

// ---------- Recipe modal ----------
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
    modalBody.innerHTML = `
      <img src="${r.image || placeholder()}" alt="${escapeHtml(r.title)}" />
      <h2>${escapeHtml(r.title)}</h2>
      <p class="card-meta">${[
        r.readyInMinutes ? `⏱ ${r.readyInMinutes} min` : "",
        r.servings ? `🍽 ${r.servings} servings` : "",
      ].filter(Boolean).join(" · ")}</p>
      <span class="gf-note">✓ Gluten-free</span>
      ${n ? `<div class="nutri">
        <span><strong>${n.calories ?? "?"}</strong> cal</span>
        <span><strong>${n.protein ?? "?"}g</strong> protein</span>
        <span><strong>${n.carbs ?? "?"}g</strong> carbs</span>
        <span><strong>${n.fat ?? "?"}g</strong> fat</span>
        <em>per serving</em>
      </div>` : ""}
      <h3>Ingredients</h3>
      <ul class="ing-list">
        ${(r.ingredients || []).map((i) => `<li>${escapeHtml(i.original || i.name)}</li>`).join("")}
      </ul>
      ${r.sourceUrl ? `<p><a href="${r.sourceUrl}" target="_blank" rel="noopener">View full recipe & instructions →</a></p>` : ""}
      <div class="card-actions" style="margin-top:16px">
        <button class="add-btn" id="modalAdd">${inWeek(r.id) ? "✓ In week" : "＋ Add to week"}</button>
      </div>`;
    const addBtn = $("#modalAdd");
    if (inWeek(r.id)) addBtn.classList.add("added");
    addBtn.addEventListener("click", () => {
      if (inWeek(r.id)) return;
      week.push({ id: r.id, title: r.title, image: r.image, readyInMinutes: r.readyInMinutes, servings: r.servings, calories: r.nutrition ? r.nutrition.calories : undefined });
      saveWeek();
      addBtn.classList.add("added");
      addBtn.textContent = "✓ In week";
      toast(`Added “${r.title}” to this week`);
    });
  } catch (err) {
    modalBody.innerHTML = `<div class="empty">😕 ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- Helpers ----------
function updateWeekCount() {
  $("#weekCount").textContent = week.length;
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
  // Round nicely: whole numbers stay whole, else 2 decimals trimmed.
  const rounded = Math.round(amount * 100) / 100;
  const num = Number.isInteger(rounded) ? rounded : parseFloat(rounded.toFixed(2));
  return `${num}${unit ? " " + unit : ""}`;
}
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
function placeholder() {
  return "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%' height='100%' fill='#f0ece5'/><text x='50%' y='50%' font-size='48' text-anchor='middle' dy='.35em'>🍽️</text></svg>`
  );
}

// ---------- Startup ----------
async function init() {
  updateWeekCount();
  renderWeek();
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    if (!cfg.hasKey) $("#keyBanner").classList.remove("hidden");
  } catch {
    /* server not reachable yet — ignore */
  }
  // Show a friendly starter search.
  runSearch();
}
init();
