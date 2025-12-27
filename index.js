import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

console.log("[StatsTracker] Loading extension...");

const MODULE_NAME = "stats_tracker";

const DEFAULT_SYSTEM_PROMPT = `You are a stats tracking system for roleplay chat.

Your job: infer and update the CURRENT stats for BOTH characters (the user and the assistant character) based on the recent conversation and the current stats.

Rules:
- Output MUST be valid JSON, and ONLY JSON. No Markdown fences, no commentary.
- Use this exact shape:
{
  "user": { "Health": 0-100, "Sustenance": 0-100, "Energy": 0-100, "Hygiene": 0-100, "Arousal": 0-100, "GenitalSize": number (cm), "Mood": "string", "Conditions": ["string", "..."], "Appearance": "string" },
  "bot":  { same fields as user }
}
- Clamp numeric values to 0..100.
- Conditions: pick up to 3 concise tags (single words or short phrases). If unknown, guess.
- Appearance: short free text (aim ~200 chars). Include physical traits + outfit. Use line breaks if helpful.
- Mood: a short descriptive word/phrase (e.g., "Neutral", "Happy", "Anxious", "Playful").
- Prefer small, realistic changes per update unless the messages clearly indicate a big change.
- Arousal equals to sexual arousal.
- Try to update each values as realistically as possible according to the current story.
- GenitalSize: realistic adult size in centimeters. Clamp to 0–100. GenitalSize should rarely change. Treat it as a physical constant.
`;

const DEFAULTS = {
  enableSysMessages: true,
  autoOpenUser: true,
  autoOpenBot: true,
  autoUpdate: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  recentMessageCount: 8,
  state: {
    user: {
      Health: 80,
      Sustenance: 80,
      Energy: 80,
      Hygiene: 80,
      Arousal: 0,
      GenitalSize: 0, // cm
      Mood: "Neutral",
      Conditions: ["none"],
      Appearance: "No data yet.",
    },
    bot: {
      Health: 80,
      Sustenance: 80,
      Energy: 80,
      Hygiene: 80,
      Arousal: 0,
      GenitalSize: 0, // cm
      Mood: "Neutral",
      Conditions: ["none"],
      Appearance: "No data yet.",
    },
  },
};

function initSettings() {
  if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = structuredClone(DEFAULTS);
  } else {
    extension_settings[MODULE_NAME] = Object.assign(
      structuredClone(DEFAULTS),
      extension_settings[MODULE_NAME]
    );

    extension_settings[MODULE_NAME].state =
      extension_settings[MODULE_NAME].state || structuredClone(DEFAULTS.state);

    extension_settings[MODULE_NAME].state.user = Object.assign(
      structuredClone(DEFAULTS.state.user),
      extension_settings[MODULE_NAME].state.user || {}
    );

    extension_settings[MODULE_NAME].state.bot = Object.assign(
      structuredClone(DEFAULTS.state.bot),
      extension_settings[MODULE_NAME].state.bot || {}
    );
  }
}

const clamp = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
};

function clampTextToBox(str, maxChars = 220) {
  // Keep it readable, compact, and not an LLM essay.
  // Strategy:
  // - Trim
  // - Collapse excessive blank lines
  // - Hard limit to maxChars (safe cut)
  let t = String(str ?? "").trim();
  if (!t) return "No data yet.";

  // Normalize line breaks + trim each line
  t = t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l, idx, arr) => {
      // keep line if it's not empty, or if it's a single empty line between text blocks
      if (l) return true;
      // allow at most one consecutive empty line
      const prev = arr[idx - 1];
      return prev && prev.trim() !== "";
    })
    .join("\n");

  // Collapse huge whitespace blocks
  t = t.replace(/[ \t]{2,}/g, " ");

  if (t.length > maxChars) {
    t = t.slice(0, maxChars).trimEnd();
    // avoid ending mid-word if easy
    t = t.replace(/\s+\S{0,12}$/, "").trimEnd() || t;
    t += "…";
  }
  return t;
}

function normalizeStats(obj) {
  const out = {};
  for (const key of ["Health", "Sustenance", "Energy", "Hygiene", "Arousal"]) {
    const c = clamp(obj?.[key]);
    if (c !== null) out[key] = c;
  }

  // Genital size in cm (accept a number, keep realistic)
if (obj?.GenitalSize != null || obj?.genitalSize != null) {
  const raw = obj?.GenitalSize ?? obj?.genitalSize;
  const n = Number(raw);
  if (Number.isFinite(n)) {
    // Clamp to a sane range and keep one decimal
    out.GenitalSize = Math.max(0, Math.min(100, Math.round(n * 10) / 10));
  }
}


  if (obj?.Mood != null) out.Mood = String(obj.Mood).trim().slice(0, 60) || "Neutral";

  if (obj?.Conditions != null) {
    let arr = obj.Conditions;
    if (typeof arr === "string") {
      arr = arr.split(/,|\n/).map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(arr)) arr = [];
    arr = arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
    out.Conditions = arr.length ? arr : ["none"];
  }

  if (obj?.Appearance != null) {
    out.Appearance = clampTextToBox(obj.Appearance, 220);
  }

  return out;
}

function mergeInto(target, patch) {
  if (!patch) return;
  for (const [k, v] of Object.entries(patch)) target[k] = v;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeEl(tag, attrs = {}, html = "") {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  if (html) el.innerHTML = html;
  return el;
}

const UI = {
  visible: { user: false, bot: false },
  minimized: { user: false, bot: false },
};

function getCurrentBotName() {
  try {
    const ctx = getContext();
    const char = ctx?.characters?.[ctx.characterId];
    return (char?.name || "Character").trim();
  } catch {
    return "Character";
  }
}

function buildStatRow(label, value) {
  const pct = clamp(value) ?? 0;
  return `
    <div class="st-row">
      <div class="st-label">${escapeHtml(label)}:</div>
      <div class="st-barwrap">
        <div class="st-bar" style="width:${pct}%"></div>
      </div>
      <div class="st-value">${pct}%</div>
    </div>
  `;
}

function buildMoodRow(mood) {
  const m = (mood ?? "Neutral").toString().trim();
  return `
    <div class="st-meta">
      <div class="st-meta-label">Mood:</div>
      <div class="st-meta-value">${escapeHtml(m || "Neutral")}</div>
    </div>
  `;
}

function buildConditionsRow(conditions) {
  const arr = Array.isArray(conditions) ? conditions : [];
  const lines = arr.slice(0, 3).map((s) => String(s).trim()).filter(Boolean);
  const text = lines.length ? lines.join("\n") : "none";
  return `
    <div class="st-meta">
      <div class="st-meta-label">Conditions:</div>
      <textarea class="st-conditions" rows="3" readonly>${escapeHtml(text)}</textarea>
    </div>
  `;
}

function buildAppearanceRow(appearance) {
  const text = clampTextToBox(appearance ?? "No data yet.", 220);
  // This is intentionally free-form. If it overflows, textarea scrollbars handle it.
  return `
    <div class="st-meta">
      <div class="st-meta-label">Appearance:</div>
      <textarea class="st-appearance" rows="3" readonly>${escapeHtml(text)}</textarea>
    </div>
  `;
}

function ensurePanel(kind) {
  const id = kind === "user" ? "st-user-panel" : "st-bot-panel";
  let el = document.getElementById(id);
  if (el) return el;

  el = makeEl("div", { id, class: "stats-panel" });
  el.innerHTML = `
    <div class="stats-header">
      <h3 class="stats-title"></h3>
      <div class="stats-actions">
        <span class="stats-btn icon" data-action="min">−</span>
        <span class="stats-btn icon" data-action="close">×</span>
      </div>
    </div>
    <div class="stats-content"></div>
  `;
  document.body.appendChild(el);

  el.querySelector('[data-action="close"]')?.addEventListener("click", () => hidePanel(kind));
  el.querySelector('[data-action="min"]')?.addEventListener("click", () => toggleMinimize(kind));

  makeDraggable(el, el.querySelector(".stats-header"));
  return el;
}

function setPanelTitle(kind) {
  const el = ensurePanel(kind);
  const title = el.querySelector(".stats-title");
  if (!title) return;

  if (kind === "user") title.textContent = "Your Stats";
  else title.textContent = `${getCurrentBotName()}'s Stats`;
}

function render(kind) {
  const settings = extension_settings[MODULE_NAME];
  const stats = kind === "user" ? settings.state.user : settings.state.bot;

  const el = ensurePanel(kind);
  setPanelTitle(kind);

  const content = el.querySelector(".stats-content");
  if (!content) return;

  if (UI.minimized[kind]) {
    content.style.display = "none";
    return;
  } else {
    content.style.display = "block";
  }

  const conditions = Array.isArray(stats.Conditions) ? stats.Conditions : ["none"];

  content.innerHTML = `
    ${buildStatRow("Health", stats.Health)}
    ${buildStatRow("Sustenance", stats.Sustenance)}
    ${buildStatRow("Energy", stats.Energy)}
    ${buildStatRow("Hygiene", stats.Hygiene)}
    ${buildStatRow("Arousal", stats.Arousal)}
    ${buildCmRow("Genital size", stats.GenitalSize, 100)}
    ${buildMoodRow(stats.Mood)}
    ${buildConditionsRow(conditions)}
    ${buildAppearanceRow(stats.Appearance)}
  `;
}

function buildCmRow(label, value, maxCm = 40) {
  const n = Number(value);
  const cm = Number.isFinite(n) ? n : 0;
  const clamped = Math.max(0, Math.min(maxCm, cm));
  const widthPct = (clamped / maxCm) * 100;

  return `
    <div class="st-row">
      <div class="st-label">${escapeHtml(label)}:</div>
      <div class="st-barwrap">
        <div class="st-bar" style="width:${widthPct}%"></div>
      </div>
      <div class="st-value">${clamped.toFixed(1).replace(/\.0$/, "")} cm</div>
    </div>
  `;
}

function showPanel(kind) {
  const el = ensurePanel(kind);
  setPanelTitle(kind);
  el.style.display = "flex";
  UI.visible[kind] = true;
  render(kind);
}

function hidePanel(kind) {
  const el = ensurePanel(kind);
  el.style.display = "none";
  UI.visible[kind] = false;
  UI.minimized[kind] = false;

  const minBtn = el.querySelector('[data-action="min"]');
  if (minBtn) minBtn.textContent = "−";
}

function toggleMinimize(kind) {
  UI.minimized[kind] = !UI.minimized[kind];
  const el = ensurePanel(kind);
  const minBtn = el.querySelector('[data-action="min"]');
  if (minBtn) minBtn.textContent = UI.minimized[kind] ? "+" : "−";
  render(kind);
}

// Tiny draggable (no jQuery needed)
function makeDraggable(panelEl, handleEl) {
  if (!panelEl || !handleEl) return;

  let dragging = false;
  let startX = 0,
    startY = 0,
    startLeft = 0,
    startTop = 0;

  handleEl.style.cursor = "move";

  handleEl.addEventListener("mousedown", (e) => {
    if (e.target?.closest?.(".stats-actions")) return;

    dragging = true;
    startX = e.clientX;
    startY = e.clientY;

    const rect = panelEl.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    panelEl.style.position = "fixed";
    panelEl.style.left = `${startLeft}px`;
    panelEl.style.top = `${startTop}px`;

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panelEl.style.left = `${startLeft + dx}px`;
    panelEl.style.top = `${startTop + dy}px`;
  }

  function onUp() {
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
}

function createSettingsUI() {
  const settings = extension_settings[MODULE_NAME];

  const html = `
    <div class="stats-tracker-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Stats Tracker Settings</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="flex-container">
            <label for="st-enable-sys">Enable system messages</label>
            <input type="checkbox" id="st-enable-sys" ${settings.enableSysMessages ? "checked" : ""}>
          </div>
          <div class="flex-container">
            <label for="st-auto-open-user">Auto-open user panel</label>
            <input type="checkbox" id="st-auto-open-user" ${settings.autoOpenUser ? "checked" : ""}>
          </div>
          <div class="flex-container">
            <label for="st-auto-open-bot">Auto-open character panel</label>
            <input type="checkbox" id="st-auto-open-bot" ${settings.autoOpenBot ? "checked" : ""}>
          </div>
          <div class="flex-container">
            <label for="st-auto-update">Enable auto updates</label>
            <input type="checkbox" id="st-auto-update" ${settings.autoUpdate ? "checked" : ""}>
          </div>
          <div class="flex-container">
            <label for="st-prompt">System Prompt:</label>
            <textarea id="st-prompt" rows="8" placeholder="Enter a system prompt for the stats tracker">${escapeHtml(
              settings.systemPrompt || ""
            )}</textarea>
          </div>
          <div class="flex-container">
            <button id="st-prompt-reset" class="menu_button">Reset to Default Prompt</button>
            <button id="st-prompt-view" class="menu_button">View Current Prompt</button>
          </div>
        </div>
      </div>
    </div>
  `;

  $("#extensions_settings").append(html);

  $("#st-enable-sys").on("input", function () {
    settings.enableSysMessages = $(this).prop("checked");
    saveSettingsDebounced();
  });

  $("#st-auto-open-user").on("input", function () {
    settings.autoOpenUser = $(this).prop("checked");
    saveSettingsDebounced();
  });

  $("#st-auto-open-bot").on("input", function () {
    settings.autoOpenBot = $(this).prop("checked");
    saveSettingsDebounced();
  });

  $("#st-auto-update").on("input", function () {
    settings.autoUpdate = $(this).prop("checked");
    saveSettingsDebounced();
  });

  $("#st-prompt").on("change", function () {
    settings.systemPrompt = $(this).val() || DEFAULTS.systemPrompt;
    saveSettingsDebounced();
  });

  $("#st-prompt-reset").on("click", function () {
    settings.systemPrompt = DEFAULTS.systemPrompt;
    $("#st-prompt").val(settings.systemPrompt);
    saveSettingsDebounced();
    if (settings.enableSysMessages) toastr.info("System prompt reset to default.", "Stats Tracker");
  });

  $("#st-prompt-view").on("click", function () {
    const p = settings.systemPrompt || "";
    const preview = p.length > 160 ? p.slice(0, 160) + "..." : p;
    toastr.info(
      `Prompt preview: ${preview}\n\nFull length: ${p.length} characters`,
      "Current System Prompt",
      { timeOut: 15000, extendedTimeOut: 30000 }
    );
  });
}

// Auto update via local LLM after each AI message
let appInitialized = false;
let updateTimer = null;
let isUpdating = false;

function getRecentMessages(n) {
  const ctx = getContext();
  const chat = ctx?.chat;
  if (!Array.isArray(chat) || chat.length === 0) return "";

  const slice = chat.slice(-n);
  return slice
    .map((m) => {
      const who = m?.is_user ? "User" : (m?.name || "Assistant");
      const text = (m?.mes || "").replace(/\s+/g, " ").trim();
      return `${who}: ${text}`;
    })
    .join("\n");
}

function buildAnalysisPrompt() {
  const settings = extension_settings[MODULE_NAME];
  const payload = {
    user: settings.state.user,
    bot: settings.state.bot,
    botName: getCurrentBotName(),
  };

  const recent = getRecentMessages(settings.recentMessageCount || 8);

  return [
    settings.systemPrompt || DEFAULTS.systemPrompt,
    "",
    "Context:",
    JSON.stringify(payload, null, 2),
    "",
    "Recent messages:",
    recent || "(no messages)",
  ].join("\n");
}

function safeParseJson(text) {
  let t = String(text).trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // Grab first JSON object block (defensive)
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s !== -1 && e !== -1 && e > s) t = t.slice(s, e + 1);

  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function updateStatsFromLLM() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.autoUpdate) return;
  if (!appInitialized) return;
  if (isUpdating) return;

  isUpdating = true;

  try {
    const ctx = getContext();
    const prompt = buildAnalysisPrompt();

    let result = "";
    if (typeof ctx.generateRaw === "function") {
      result = await ctx.generateRaw({
        prompt,
        systemPrompt: "You update stats based on roleplay chat. Output ONLY valid JSON.",
      });
    } else if (typeof ctx.generateQuietPrompt === "function") {
      result = await ctx.generateQuietPrompt({ quietPrompt: prompt });
    } else {
      console.warn("[StatsTracker] No generation function available (generateRaw/generateQuietPrompt).");
      return;
    }

    if (!result || typeof result !== "string") return;

    const parsed = safeParseJson(result);
    if (!parsed) {
      console.warn("[StatsTracker] Bad JSON from model:", result);
      if (settings.enableSysMessages) toastr.warning("Stats update failed (bad JSON).", "Stats Tracker");
      return;
    }

    const userPatch = normalizeStats(parsed.user || {});
    const botPatch = normalizeStats(parsed.bot || {});
    mergeInto(settings.state.user, userPatch);
    mergeInto(settings.state.bot, botPatch);

    // Ensure appearance always exists (defensive for older saved states)
    if (!settings.state.user.Appearance) settings.state.user.Appearance = "No data yet.";
    if (!settings.state.bot.Appearance) settings.state.bot.Appearance = "No data yet.";

    saveSettingsDebounced();

    if (UI.visible.user) render("user");
    if (UI.visible.bot) render("bot");
  } catch (err) {
    console.error("[StatsTracker] updateStatsFromLLM failed:", err);
    if (extension_settings[MODULE_NAME].enableSysMessages) {
      toastr.error("Stats update failed. Check console for details.", "Stats Tracker");
    }
  } finally {
    isUpdating = false;
  }
}

function scheduleUpdate(delayMs = 1100) {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => updateStatsFromLLM(), delayMs);
}

function updateForCurrentCharacter() {
  if (UI.visible.bot) {
    setPanelTitle("bot");
    render("bot");
  }
}

function setupEventListeners() {
  const ctx = getContext();
  const { eventSource, event_types } = ctx;

  eventSource.on(event_types.APP_READY, () => {
    appInitialized = true;
    console.log("[StatsTracker] APP_READY, will process new AI messages.");
  });

  eventSource.on(event_types.CHAT_CHANGED, updateForCurrentCharacter);
  eventSource.on(event_types.CHARACTER_CHANGED, updateForCurrentCharacter);

  eventSource.on(event_types.MESSAGE_RECEIVED, (data) => {
    if (!data || data.is_user) return;
    scheduleUpdate(1100);
  });
}

function maybeAutoOpen() {
  const settings = extension_settings[MODULE_NAME];
  if (settings.autoOpenUser) setTimeout(() => showPanel("user"), 800);
  if (settings.autoOpenBot) setTimeout(() => showPanel("bot"), 900);
}

$(async () => {
  try {
    initSettings();
    createSettingsUI();
    setupEventListeners();
    maybeAutoOpen();
    console.log("[StatsTracker] Loaded.");
  } catch (e) {
    console.error("[StatsTracker] Failed to initialize:", e);
  }
});





