/* Colour themes for Homebase.
   Loaded synchronously in <head> so the saved theme paints before the app does
   (no flash of the default palette). Exposes a small window.Theme API that the
   Settings screen (app.js) drives. Theme choice is a per-device preference kept
   in localStorage — it is intentionally NOT synced, so each phone can differ. */
(function () {
  "use strict";

  var THEME_KEY = "mealPlanner.theme.v1";

  /* The CSS custom properties a theme controls. Everything else in style.css
     (rose accents, Eisenhower quadrants, danger) inherits from :root. */
  var VAR_KEYS = [
    "--bg", "--card", "--ink", "--muted", "--line", "--line-faint",
    "--accent", "--accent-dark", "--on-accent",
  ];

  /* ---- colour maths (all inputs/outputs are #rrggbb) ---- */
  function clamp(n) { return Math.max(0, Math.min(255, n)); }
  function hexToRgb(hex) {
    hex = String(hex || "").trim().replace(/^#/, "");
    if (hex.length === 3) hex = hex.split("").map(function (c) { return c + c; }).join("");
    var n = parseInt(hex, 16);
    if (isNaN(n) || hex.length !== 6) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(o) {
    return "#" + [o.r, o.g, o.b].map(function (v) {
      return clamp(Math.round(v)).toString(16).padStart(2, "0");
    }).join("");
  }
  function mix(a, b, t) { // t=0 → a, t=1 → b
    var x = hexToRgb(a), y = hexToRgb(b);
    return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
  }
  function darken(hex, t) { return mix(hex, "#000000", t); }
  function luminance(hex) {
    var c = hexToRgb(hex);
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  }
  // Readable text colour to sit on top of a filled swatch.
  function readableInk(bg) { return luminance(bg) > 0.55 ? "#20221c" : "#f7f8f4"; }

  /* Expand a compact base ({bg,card,ink,accent}) into the full variable map,
     deriving the muted/line/dark/on-colour helpers. Person hues (green/katie)
     are NOT part of a theme — they're a synced household setting (see below). */
  function deriveVars(base) {
    var bg = base.bg, card = base.card, ink = base.ink, accent = base.accent;
    var dark = luminance(bg) < 0.5;
    return {
      "--bg": bg,
      "--card": card,
      "--ink": ink,
      "--muted": mix(ink, bg, 0.42),
      "--line": mix(card, ink, dark ? 0.16 : 0.24),
      "--line-faint": mix(bg, card, 0.5),
      "--accent": accent,
      "--accent-dark": darken(accent, 0.1),
      "--on-accent": readableInk(accent),
    };
  }

  /* The current palette, matching :root in style.css exactly. Used as the
     seed when the user starts customising, and as the first preset. */
  var SAGE_BASE = { bg: "#1a1b16", card: "#2e2f28", ink: "#eaece7", accent: "#a6c199" };

  /* Each person's colour is a HOUSEHOLD setting (synced across devices), not a
     per-device theme choice — so both phones show the same person colours. It is
     stored in app settings and painted via applyPersonColors(). */
  var PERSON_DEFAULTS = { green: "#4f8c62", katie: "#cf8a55" };

  /* Pre-built themes. Sage is first and is the default; selecting it simply
     clears the inline overrides so the hand-tuned :root values apply. */
  var PRESETS = [
    { id: "sage",     name: "Sage",     base: SAGE_BASE },
    { id: "midnight", name: "Midnight", base: { bg: "#14171d", card: "#232a36", ink: "#e7ecf3", accent: "#7fa8d9" } },
    { id: "plum",     name: "Plum",     base: { bg: "#1b141d", card: "#2f2531", ink: "#efe8f0", accent: "#c69bd1" } },
    { id: "espresso", name: "Espresso", base: { bg: "#1c1712", card: "#302620", ink: "#f0e7dc", accent: "#d8a45f" } },
    { id: "nocturne", name: "Nocturne", base: { bg: "#101215", card: "#1d2126", ink: "#e9edf1", accent: "#8bbcae" } },
    { id: "rose",     name: "Rosé",     base: { bg: "#1c1618", card: "#302529", ink: "#f1e8ea", accent: "#d98aa0" } },
    { id: "linen",    name: "Linen",    base: { bg: "#f3f1ea", card: "#ffffff", ink: "#2c302a", accent: "#6f9e7f" } },
  ];

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }
  function withDefaults(custom) {
    var out = {};
    ["bg", "card", "ink", "accent"].forEach(function (k) {
      out[k] = (custom && /^#[0-9a-fA-F]{6}$/.test(custom[k])) ? custom[k] : SAGE_BASE[k];
    });
    return out;
  }

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(THEME_KEY));
      if (s && typeof s === "object" && (s.mode === "preset" || s.mode === "custom")) return s;
    } catch (e) { /* ignore */ }
    return { mode: "preset", preset: "sage" };
  }
  function save(state) {
    try { localStorage.setItem(THEME_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // Resolve a state to its variable map (null ⇒ use :root defaults, i.e. Sage).
  function varsFor(state) {
    if (state && state.mode === "custom") return deriveVars(withDefaults(state.custom));
    var p = (state && presetById(state.preset)) || PRESETS[0];
    return p.id === "sage" ? null : deriveVars(p.base);
  }

  function applyVars(vars) {
    var root = document.documentElement;
    VAR_KEYS.forEach(function (k) { root.style.removeProperty(k); });
    if (vars) Object.keys(vars).forEach(function (k) { root.style.setProperty(k, vars[k]); });
    // Keep the browser chrome / PWA status bar in step with the background.
    var bg = vars ? vars["--bg"]
      : (getComputedStyle(root).getPropertyValue("--bg").trim() || "#1a1b16");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", bg);
  }

  function apply(state) { applyVars(varsFor(state || load())); }

  /* Paint the two person hues (a household setting) onto the person variables,
     deriving the darker/readable-text helpers. Falls back to the sage defaults
     for anything that isn't a valid #rrggbb. */
  function applyPersonColors(green, katie) {
    var root = document.documentElement;
    var g = /^#[0-9a-fA-F]{6}$/.test(green || "") ? green : PERSON_DEFAULTS.green;
    var k = /^#[0-9a-fA-F]{6}$/.test(katie || "") ? katie : PERSON_DEFAULTS.katie;
    root.style.setProperty("--green", g);
    root.style.setProperty("--green-dark", darken(g, 0.1));
    root.style.setProperty("--katie", k);
    root.style.setProperty("--on-green", readableInk(g));
    root.style.setProperty("--on-katie", readableInk(k));
  }

  // Effective compact base for the current state — seeds the custom editor.
  function baseFor(state) {
    if (state && state.mode === "custom") return withDefaults(state.custom);
    var p = (state && presetById(state.preset)) || PRESETS[0];
    return Object.assign({}, p.base);
  }

  window.Theme = {
    PRESETS: PRESETS,
    SAGE_BASE: SAGE_BASE,
    PERSON_DEFAULTS: PERSON_DEFAULTS,
    load: load,
    save: save,
    apply: apply,
    applyPersonColors: applyPersonColors,
    baseFor: baseFor,
    deriveVars: deriveVars,
    swatchFor: function (state) {
      // Small preview palette (used to draw the preset cards): the four colours
      // a theme actually controls now that person hues live in settings.
      var b = baseFor(state);
      return [b.bg, b.card, b.accent, b.ink];
    },
  };

  // Paint the saved theme immediately, before the rest of the page renders.
  apply(load());
})();
