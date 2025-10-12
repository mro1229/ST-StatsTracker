// StatsTracker.js — SillyTavern extension
// Struktur speglar ST Outfits (index): settings via extension_settings, createSettingsUI, slash cmds,
// event hooks (CHAT_CHANGED/CHARACTER_CHANGED), auto-open, samt globala panelcontrollers.
// Robust mot init-timing. Ingen import krävs.

(async () => {
  const MODULE_NAME = 'stats_tracker';

  // ---------------------------
  // SillyTavern context helpers
  // ---------------------------
  function getCtxSafe() {
    try { return window.SillyTavern?.getContext?.() || null; } catch { return null; }
  }
  function getExtSettingsStore() {
    // Outfits använder globalen extension_settings. Vi matchar det mönstret.
    // Om ST av någon anledning inte hunnit sätta den, gör en tom och ST fyller senare.
    window.extension_settings = window.extension_settings || {};
    return window.extension_settings;
  }
  function getSaveSettings() {
    // Outfits importerar saveSettingsDebounced. Vi plockar globalen (samma symbol använder de).
    return window.saveSettingsDebounced || (() => {});
  }

  const ctx = getCtxSafe();                 // kan vara null tidigt
  const extension_settings = getExtSettingsStore();
  const saveSettingsDebounced = getSaveSettings();

  // ---------------------------
  // Defaults + init settings
  // ---------------------------
  const DEFAULTS = Object.freeze({
    enableSysMessages: true,
    autoOpenBot:  true,
    autoOpenUser: true,
    autoUpdate:   true,        // styr MutationObservern
    // promptreserv om du senare vill låta modellen auto-posta statsblock
    autoStatsPrompt: '',
    // plats att spara presets så det lever i samma struktur som Outfits gör
    presets: { user: {}, bot: {} }
  });

  if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = { ...DEFAULTS };
  } else {
    // se till att nya nycklar fylls på efter uppdateringar
    for (const k of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(extension_settings[MODULE_NAME], k)) {
        extension_settings[MODULE_NAME][k] = DEFAULTS[k];
      }
    }
  }

  // ---------------------------
  // Lokal state (panelinnehåll)
  // ---------------------------
  const USER_PANEL_ID = 'user-stats-panel';
  const BOT_PANEL_ID  = 'bot-stats-panel';
  const STORAGE_KEY   = 'stats-tracker-v1';

  const DEFAULT_USER_NAME = (window.STT_USER_NAME || 'User');
  const DEFAULT_BOT_NAME  = (window.STT_BOT_NAME  || 'Assistant');

  const DEFAULT_STATS = {
    Health: 80,
    Sustenance: 80, // byt gärna till "Satiety" om du vill
    Energy: 80,
    Hygiene: 80,
    Arousal: 10,
    Mood: 'Neutral',
    Conditions: []
  };

  const state = loadState() || {
    userName: DEFAULT_USER_NAME,
    botName: DEFAULT_BOT_NAME,
    user: { ...DEFAULT_STATS },
    bot:  { ...DEFAULT_STATS, Arousal: 0 },
    visible: { user: true, bot: true }
  };

  // presets speglas mot extension_settings som Outfits gör
  if (!extension_settings[MODULE_NAME].presets) {
    extension_settings[MODULE_NAME].presets = { user: {}, bot: {} };
    saveSettingsDebounced();
  }

  // ---------------------------
  // Utilities
  // ---------------------------
  function clamp(n, min=0, max=100) {
    n = Number(n);
    if (Number.isNaN(n)) return 0;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function makeDraggable(panel, handle) {
    let sx=0, sy=0, ox=0, oy=0, dragging=false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const rect = panel.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e){
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      panel.style.left = (ox + dx) + 'px';
      panel.style.top  = (oy + dy) + 'px';
      panel.style.right = 'auto';
    }
    function onUp(){
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  }

  function createEl(tag, attrs={}, html='') {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
    if (html) el.innerHTML = html;
    return el;
  }

  // ---------------------------
  // Render
  // ---------------------------
  function renderPanel(kind) {
    const panelId = kind === 'user' ? USER_PANEL_ID : BOT_PANEL_ID;
    let panel = document.getElementById(panelId);
    if (!panel) {
      panel = createEl('div', { id: panelId, class: 'stats-panel' });
      document.body.appendChild(panel);
    }

    const name = state[kind === 'user' ? 'userName' : 'botName'];
    const stats = state[kind];

    panel.innerHTML = `
      <div class="stats-header">
        <h3>${escapeHtml(name)}’s Stats</h3>
        <div class="stats-actions">
          <span title="Minimize" data-action="min" aria-label="Minimize">—</span>
          <span title="Reset to defaults" data-action="reset" aria-label="Reset">⟳</span>
          <span title="Close" data-action="close" aria-label="Close">✕</span>
        </div>
      </div>
      <div class="stats-content">
        ${renderStatRow('Health', stats.Health)}
        ${renderStatRow('Sustenance', stats.Sustenance)}
        ${renderStatRow('Energy', stats.Energy)}
        ${renderStatRow('Hygiene', stats.Hygiene)}
        ${renderStatRow('Arousal', stats.Arousal)}

        <div class="stats-meta">
          <div style="margin-bottom:6px;"><b>💎 Mood</b></div>
          <input class="stats-input" data-k="${kind}" data-field="Mood"
                 style="width: 80%;" value="${escapeAttr(stats.Mood)}" />
          <div style="margin:8px 0 6px;"><b>💎 Conditions</b> <span style="opacity:.8">(kommaseparerade)</span></div>
          <input class="stats-input" data-k="${kind}" data-field="Conditions"
                 style="width: 80%;" value="${escapeAttr(stats.Conditions.join(', '))}" />
        </div>

        <div style="margin-top:10px;">
          <button class="stats-btn" data-action="save-preset" data-k="${kind}">Spara preset</button>
          <button class="stats-btn" data-action="load-last"   data-k="${kind}" style="margin-left:6px;">Ladda senaste</button>
        </div>

        <div class="stats-presets-list" id="${panelId}-presets"></div>
      </div>
    `;

    const header = panel.querySelector('.stats-header');
    makeDraggable(panel, header);

    panel.querySelectorAll('.stat-input').forEach(inp => {
      inp.addEventListener('change', onStatInputChange);
      inp.addEventListener('input', onStatInputLive);
    });
    panel.querySelectorAll('.stats-input').forEach(inp => {
      inp.addEventListener('change', onMetaChange);
    });
    panel.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', onActionClick);
    });

    renderPresets(kind);
    panel.style.display = state.visible[kind] ? 'block' : 'none';

    // uppdatera maskbredd
    panel.querySelectorAll('.stat-bar').forEach(bar => {
      const v = Number(bar.getAttribute('data-value')) || 0;
      const mask = bar.querySelector('.stat-mask');
      mask.style.width = `calc(100% - ${v}%)`;
      mask.style.borderRadius = v >= 99 ? '0' : '0 8px 8px 0';
    });
  }

  function renderStatRow(label, value) {
    value = clamp(value);
    return `
      <div class="stat-row">
        <div class="stat-label">${label}:</div>
        <div class="stat-bar" data-value="${value}">
          <div class="stat-mask"></div>
        </div>
        <input class="stats-input stat-input" data-field="${label}" value="${value}" />
        <div class="stat-value">${value}%</div>
      </div>
    `;
  }

  function renderPresets(kind) {
    const listEl = document.getElementById(
      (kind === 'user' ? USER_PANEL_ID : BOT_PANEL_ID) + '-presets'
    );
    const bank = extension_settings[MODULE_NAME].presets?.[kind] || {};
    listEl.innerHTML = '';
    Object.keys(bank).forEach(key => {
      const row = createEl('div', { class: 'stats-preset' });
      row.innerHTML = `
        <div>${escapeHtml(key)}</div>
        <div>
          <button class="stats-btn" data-action="use-preset" data-k="${kind}" data-id="${escapeAttr(key)}">Ladda</button>
          <button class="stats-btn" data-action="del-preset" data-k="${kind}" data-id="${escapeAttr(key)}">Radera</button>
        </div>
      `;
      listEl.appendChild(row);
    });
  }

  // ---------------------------
  // Events (inputs, knappar)
  // ---------------------------
  function findKindFromInput(inp) {
    const panel = inp.closest('.stats-panel');
    return panel.id.includes('user') ? 'user' : 'bot';
  }

  function onStatInputLive(e) {
    const inp = e.currentTarget;
    let v = clamp(inp.value);
    inp.value = v;
    const row = inp.closest('.stat-row');
    row.querySelector('.stat-value').textContent = `${v}%`;
    const bar = row.querySelector('.stat-bar');
    bar.setAttribute('data-value', v);
    bar.querySelector('.stat-mask').style.width = `calc(100% - ${v}%)`;
  }

  function onStatInputChange(e) {
    const inp = e.currentTarget;
    const field = inp.getAttribute('data-field');
    const kind = findKindFromInput(inp);
    state[kind][field] = clamp(inp.value);
    persist();
  }

  function onMetaChange(e) {
    const inp = e.currentTarget;
    const kind = inp.getAttribute('data-k');
    const field = inp.getAttribute('data-field');
    const v = String(inp.value || '');
    if (field === 'Conditions') {
      state[kind].Conditions = v.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      state[kind][field] = v;
    }
    persist();
  }

  function onActionClick(e) {
    const el = e.currentTarget;
    const action = el.getAttribute('data-action');
    const kind = el.getAttribute('data-k');

    if (action === 'min') {
      const panel = el.closest('.stats-panel');
      panel.classList.toggle('minimized');
      return;
    }
    if (action === 'close') {
      const panel = el.closest('.stats-panel');
      const k = panel.id.includes('user') ? 'user' : 'bot';
      state.visible[k] = false; persist();
      panel.style.display = 'none';
      return;
    }
    if (action === 'reset') {
      if (kind === 'user') state.user = { ...DEFAULT_STATS };
      else state.bot = { ...DEFAULT_STATS, Arousal: 0 };
      persist();
      renderPanel(kind);
      return;
    }
    if (action === 'save-preset') {
      const name = prompt('Namn på preset?');
      if (!name) return;
      // spara i extension_settings som Outfits gör
      extension_settings[MODULE_NAME].presets[kind][name] = JSON.parse(JSON.stringify(state[kind]));
      saveSettingsDebounced();
      renderPresets(kind);
      return;
    }
    if (action === 'load-last') {
      alert('Ingen historikstack implementerad. Använd presets så länge.');
      return;
    }
    if (action === 'use-preset' || action === 'del-preset') {
      const id = el.getAttribute('data-id');
      if (action === 'use-preset') {
        const preset = extension_settings[MODULE_NAME].presets[kind][id];
        if (preset) {
          state[kind] = JSON.parse(JSON.stringify(preset));
          persist();
          renderPanel(kind);
        }
      } else {
        delete extension_settings[MODULE_NAME].presets[kind][id];
        saveSettingsDebounced();
        renderPresets(kind);
      }
      return;
    }
  }

  // ---------------------------
  // Parsning av AI-svar
  // ---------------------------
  const FENCE_STATS = /```stats\s+([\s\S]*?)```/i;
  const CLASSIC_BLOCK = new RegExp(
    String.raw`${escapeReg(DEFAULT_USER_NAME)}'s Stats\s*\n---\n- Health:\s*([0-9]+)%\n- Sustenance:\s*([0-9]+)%\n- Energy:\s*([0-9]+)%\n- Hygiene:\s*([0-9]+)%\n- Arousal:\s*([0-9]+)%\n💎:\s*([\s\S]*?)$`,
    'mi'
  );

  function parseAndUpdateFromMessage(text) {
    if (!text) return;

    // 1) Fenced yaml-ish block
    const m1 = text.match(FENCE_STATS);
    if (m1) {
      try {
        const parsed = parseLooseYaml(m1[1]);
        if (parsed.user)  applyStats('user', parsed.user);
        if (parsed.bot)   applyStats('bot',  parsed.bot);
        persist();
        renderPanel('user'); renderPanel('bot');
        return;
      } catch (err) {
        console.warn('[StatsTracker] fenced stats parse failed:', err);
      }
    }

    // 2) Classic enkel user-block
    const m2 = text.match(CLASSIC_BLOCK);
    if (m2) {
      const [ , h, s, e, hy, a, meta ] = m2;
      const [mood, conditionsRaw] = String(meta).split('|').map(t => String(t || '').trim());
      state.user.Health = clamp(h);
      state.user.Sustenance = clamp(s);
      state.user.Energy = clamp(e);
      state.user.Hygiene = clamp(hy);
      state.user.Arousal = clamp(a);
      state.user.Mood = mood || state.user.Mood;
      state.user.Conditions = (conditionsRaw || '').split(',').map(x => x.trim()).filter(Boolean);
      persist();
      renderPanel('user');
    }
  }

  function applyStats(kind, obj) {
    const target = state[kind];
    if (!target) return;
    ['Health','Sustenance','Energy','Hygiene','Arousal'].forEach(k => {
      if (obj[k] != null) target[k] = clamp(obj[k]);
    });
    if (obj.Mood != null) target.Mood = String(obj.Mood);
    if (obj.Conditions != null) {
      if (Array.isArray(obj.Conditions)) target.Conditions = obj.Conditions.map(String);
      else target.Conditions = String(obj.Conditions).split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  function parseLooseYaml(src) {
    const out = {};
    let cur = null;
    src.split(/\r?\n/).forEach(line => {
      const l = line.trim();
      if (!l) return;
      if (/^user\s*:/.test(l)) { cur = 'user'; out.user = {}; return; }
      if (/^bot\s*:/.test(l))  { cur = 'bot';  out.bot  = {}; return; }
      const m = l.match(/^([A-Za-z]+)\s*:\s*(.+)$/);
      if (m && cur) {
        let key = m[1];
        let val = m[2].trim();
        if (/^\[.*\]$/.test(val)) {
          val = val.slice(1,-1).split(',').map(s => s.trim().replace(/^"(.*)"$/,'$1').replace(/^'(.*)'$/,'$1')).filter(Boolean);
        } else if (/^[0-9]+$/.test(val)) {
          val = Number(val);
        } else {
          val = val.replace(/^"(.*)"$/,'$1').replace(/^'(.*)'$/,'$1');
        }
        if (!out[cur]) out[cur] = {};
        out[cur][key] = val;
      }
    });
    return out;
  }

  // ---------------------------
  // Chat hook (auto-update)
  // ---------------------------
  const chatRoot = document.querySelector('#chat') || document.body;
  let observerEnabled = !!extension_settings[MODULE_NAME].autoUpdate;

  const obs = new MutationObserver(muts => {
    if (!observerEnabled) return;
    for (const m of muts) {
      if (m.addedNodes && m.addedNodes.length) {
        m.addedNodes.forEach(n => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches?.('.assistant, .ai, .chat-assistant, .mes.ai_text')) {
            const text = n.innerText || n.textContent || '';
            parseAndUpdateFromMessage(text);
          } else {
            const ai = n.querySelector?.('.assistant, .ai, .chat-assistant, .mes.ai_text');
            if (ai) parseAndUpdateFromMessage(ai.innerText || ai.textContent || '');
          }
        });
      }
    }
  });
  try { obs.observe(chatRoot, { childList: true, subtree: true }); } catch {}

  // togglas från settings-UI och slash cmd
  window.StatsTrackerEnableAutoUpdate = function(on){ observerEnabled = !!on; };

  // ---------------------------
  // Settings UI (Extensions)
  // ---------------------------
  function createSettingsUI() {
    if (typeof $ !== 'function') return;
    const $host = $("#extensions_settings");
    if (!$host.length) return;

    const s = extension_settings[MODULE_NAME];

    const settingsHtml = `
    <div class="outfit-extension-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Stats Tracker Settings</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="flex-container">
            <label for="stats-sys-toggle">Enable system messages</label>
            <input type="checkbox" id="stats-sys-toggle" ${s.enableSysMessages ? 'checked' : ''}>
          </div>

          <div class="flex-container">
            <label for="stats-auto-bot">Auto-open bot panel</label>
            <input type="checkbox" id="stats-auto-bot" ${s.autoOpenBot ? 'checked' : ''}>
          </div>

          <div class="flex-container">
            <label for="stats-auto-user">Auto-open user panel</label>
            <input type="checkbox" id="stats-auto-user" ${s.autoOpenUser ? 'checked' : ''}>
          </div>

          <div class="flex-container">
            <label for="stats-auto-update">Enable auto updates</label>
            <input type="checkbox" id="stats-auto-update" ${s.autoUpdate ? 'checked' : ''}>
          </div>

          <div class="flex-container">
            <label for="stats-prompt-input">System Prompt (optional):</label>
            <textarea id="stats-prompt-input" rows="4" placeholder="Enter system prompt for auto stats (optional)">${s.autoStatsPrompt || ''}</textarea>
          </div>
        </div>
      </div>
    </div>`;

    $host.append(settingsHtml);

    $("#stats-sys-toggle").on("input", function () {
      extension_settings[MODULE_NAME].enableSysMessages = $(this).prop('checked');
      saveSettingsDebounced();
    });
    $("#stats-auto-bot").on("input", function () {
      extension_settings[MODULE_NAME].autoOpenBot = $(this).prop('checked');
      saveSettingsDebounced();
      if ($(this).prop('checked')) window.botStatsPanel?.show();
    });
    $("#stats-auto-user").on("input", function () {
      extension_settings[MODULE_NAME].autoOpenUser = $(this).prop('checked');
      saveSettingsDebounced();
      if ($(this).prop('checked')) window.userStatsPanel?.show();
    });
    $("#stats-auto-update").on("input", function () {
      const on = $(this).prop('checked');
      extension_settings[MODULE_NAME].autoUpdate = on;
      window.StatsTrackerEnableAutoUpdate(on);
      saveSettingsDebounced();
    });
    $("#stats-prompt-input").on("change", function () {
      extension_settings[MODULE_NAME].autoStatsPrompt = $(this).val();
      saveSettingsDebounced();
    });
  }

  // ---------------------------
  // ST-context integration
  // ---------------------------
  function integrateWithSTContext() {
    try {
      const C = getCtxSafe();
      if (!C) return;

      const refreshNames = () => {
        try {
          const character = C?.characters?.[C?.characterId]?.name || 'Assistant';
          if (character && state.botName !== character) {
            state.botName = character;
            persist();
            renderPanel('bot');
          }
        } catch (inner) {
          console.warn('[StatsTracker] refreshNames failed:', inner);
        }
      };

      const { eventSource, event_types } = C || {};
      if (eventSource && event_types && typeof eventSource.on === 'function') {
        if (event_types.CHAT_CHANGED)       eventSource.on(event_types.CHAT_CHANGED, refreshNames);
        if (event_types.CHARACTER_CHANGED)  eventSource.on(event_types.CHARACTER_CHANGED, refreshNames);
      }
      refreshNames();
    } catch (e) {
      console.warn('[StatsTracker] ST context integration failed:', e);
    }
  }

  // ---------------------------
  // Slash-kommandon (Outfits-style)
  // ---------------------------
  function registerStatsCommands() {
    try {
      const C = getCtxSafe();
      const registerSlashCommand = C?.registerSlashCommand;
      if (typeof registerSlashCommand !== 'function') return;

      registerSlashCommand('stats-bot', (...args) => {
        window.botStatsPanel?.toggle();
        toastr?.info?.('Toggled bot stats panel', 'Stats Tracker');
      }, [], 'Toggle bot stats panel', true, true);

      registerSlashCommand('stats-user', (...args) => {
        window.userStatsPanel?.toggle();
        toastr?.info?.('Toggled user stats panel', 'Stats Tracker');
      }, [], 'Toggle user stats panel', true, true);

      registerSlashCommand('stats-auto', (...args) => {
        const arg = String(args?.[0] || '').toLowerCase();
        if (arg === 'on') {
          extension_settings[MODULE_NAME].autoUpdate = true;
          window.StatsTrackerEnableAutoUpdate(true);
          toastr?.success?.('Auto updates enabled', 'Stats Tracker');
        } else if (arg === 'off') {
          extension_settings[MODULE_NAME].autoUpdate = false;
          window.StatsTrackerEnableAutoUpdate(false);
          toastr?.warning?.('Auto updates disabled', 'Stats Tracker');
        } else {
          const on = !!extension_settings[MODULE_NAME].autoUpdate;
          toastr?.info?.(`Auto updates: ${on ? 'ON' : 'OFF'}`, 'Stats Tracker');
        }
        saveSettingsDebounced();
      }, [], 'Toggle auto updates for stats (on/off)', true, true);
    } catch (e) {
      console.warn('[StatsTracker] Slash command registration failed:', e);
    }
  }

  // ---------------------------
  // Globala panelcontrollers (Outfits-liknande API)
  // ---------------------------
  window.userStatsPanel = {
    show(){ StatsTracker.showUser(true); },
    hide(){ StatsTracker.showUser(false); },
    toggle(){
      const el = document.getElementById(USER_PANEL_ID);
      const vis = el && el.style.display !== 'none';
      StatsTracker.showUser(!vis);
    }
  };
  window.botStatsPanel = {
    show(){ StatsTracker.showBot(true); },
    hide(){ StatsTracker.showBot(false); },
    toggle(){
      const el = document.getElementById(BOT_PANEL_ID);
      const vis = el && el.style.display !== 'none';
      StatsTracker.showBot(!vis);
    }
  };

  // ---------------------------
  // Publikt API
  // ---------------------------
  window.StatsTracker = {
    showUser(v=true){ state.visible.user = !!v; persist(); renderPanel('user'); },
    showBot(v=true){ state.visible.bot = !!v; persist(); renderPanel('bot'); },
    setNames({user, bot}) {
      if (user) state.userName = user;
      if (bot)  state.botName  = bot;
      persist();
      renderPanel('user'); renderPanel('bot');
    },
    importFromMessage(text){ parseAndUpdateFromMessage(text); },
    getState(){ return JSON.parse(JSON.stringify(state)); }
  };

  // ---------------------------
  // Första render + init
  // ---------------------------
  renderPanel('user');
  renderPanel('bot');

  // visa enligt state
  if (state.visible.user) document.getElementById(USER_PANEL_ID).style.display = 'block';
  if (state.visible.bot)  document.getElementById(BOT_PANEL_ID).style.display  = 'block';

  // vänta tills Extensions-UI finns (Outfits gör exakt detta mönster)
  const tryInitSettings = () => {
    try {
      if (document.querySelector('#extensions_settings')) {
        createSettingsUI();
        registerStatsCommands();    // motsvarar registerOutfitCommands i Outfits
        integrateWithSTContext();   // uppdatera namn + händelser

        // auto-open likt Outfits
        if (extension_settings[MODULE_NAME].autoOpenBot) {
          setTimeout(() => window.botStatsPanel.show(), 1000);
        }
        if (extension_settings[MODULE_NAME].autoOpenUser) {
          setTimeout(() => window.userStatsPanel.show(), 1000);
        }
      } else {
        setTimeout(tryInitSettings, 500);
      }
    } catch (e) {
      console.error('[StatsTracker] tryInitSettings error:', e);
    }
  };

  // kör init efter att appen är redo om vi kan; annars kör direkt
  const C2 = getCtxSafe();
  if (C2?.eventSource?.on && C2?.event_types?.APP_READY) {
    C2.eventSource.on(C2.event_types.APP_READY, tryInitSettings);
  }
  // fallback om APP_READY inte triggas i vår timing
  setTimeout(tryInitSettings, 800);

  console.log('[StatsTracker] loaded');
})();
