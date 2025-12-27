// StatsTracker.js
(() => {
  // ===== Extension wiring (ST-style) =====
  const MODULE_NAME = 'stats_tracker';

  // ST brukar exposa extension_settings + saveSettingsDebounced globalt
  window.extension_settings = window.extension_settings || {};
  const _defaults = {
    enableSysMessages: true,
    autoOpenBot:  true,
    autoOpenUser: true,
    autoUpdate:   true,   // styr MutationObservern
    autoStatsPrompt: ''   // reserverad om du senare vill pusha system-prompter
  };
  extension_settings[MODULE_NAME] = Object.assign({}, _defaults, extension_settings[MODULE_NAME] || {});
  const saveSettingsDebounced = window.saveSettingsDebounced || (()=>{});

  // ===== Panel + state =====
  const USER_PANEL_ID = 'user-stats-panel';
  const BOT_PANEL_ID  = 'bot-stats-panel';
  const STORAGE_KEY   = 'stats-tracker-v1';
  const DEFAULT_USER_NAME = (window.STT_USER_NAME || 'User');
  const DEFAULT_BOT_NAME  = (window.STT_BOT_NAME  || 'Assistant');

  const DEFAULT_STATS = {
    Health: 80,
    Sustenance: 80,  // "Nutrition" eller "Satiety" är språkligt snyggare, men vi behåller Sustenance för kompatibilitet
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
    presets: { user: {}, bot: {} },
    visible: { user: true, bot: true }
  };

  // -------------- Utilities --------------
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

  function createEl(tag, attrs={}, html='') {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
    if (html !== undefined && html !== null) el.innerHTML = html;
    return el;
  }

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  // -------------- Panel rendering --------------
  function statRow(label, field, value) {
    const v = clamp(value);
    return `
      <div class="stat-row">
        <div class="stat-label">${escapeHtml(label)}:</div>
        <div class="stat-bar" data-value="${v}">
          <div class="stat-mask" style="width: calc(100% - ${v}%);"></div>
        </div>
        <div class="stat-value">${v}%</div>
        <input class="stat-input" data-field="${field}" type="number" min="0" max="100" value="${v}">
      </div>`;
  }

  function metaRow(label, field, value, kind) {
    const val = field === 'Conditions' ? escapeHtml((value || []).join(', ')) : escapeHtml(value || '');
    const ph  = field === 'Conditions' ? 'comma,separated,tags' : 'Mood...';
    return `
      <div class="meta-row">
        <div class="meta-label">${escapeHtml(label)}:</div>
        <input class="meta-input" data-field="${field}" data-k="${kind}" type="text" placeholder="${ph}" value="${val}">
      </div>`;
  }

  function actionsRow(kind) {
    return `
      <div class="actions-row">
        <button class="stats-btn" data-action="reset" data-k="${kind}">Reset</button>
        <button class="stats-btn" data-action="save-preset" data-k="${kind}">Spara preset</button>
        <button class="stats-btn" data-action="load-last" data-k="${kind}">Ladda senast</button>
        <span class="stats-btn icon" data-action="min" title="Minimize">_</span>
        <span class="stats-btn icon" data-action="close" title="Close">×</span>
      </div>`;
  }

  function renderPresets(kind, panelEl) {
    const wrapId = `${kind}-stats-presets`;
    let host = panelEl.querySelector(`#${wrapId}`);
    if (!host) {
      host = createEl('div', { id: wrapId, class: 'presets-wrap' });
      panelEl.querySelector('.stats-content').appendChild(host);
    }
    host.innerHTML = `<div class="presets-title">Presets</div><div class="presets-list"></div>`;
    const listEl = host.querySelector('.presets-list');

    const map = state.presets[kind] || {};
    Object.keys(map).forEach(key => {
      const row = createEl('div', { class: 'preset-row' });
      row.innerHTML = `
        <div>${escapeHtml(key)}</div>
        <div>
          <button class="stats-btn" data-action="use-preset" data-k="${kind}" data-id="${escapeAttr(key)}">Ladda</button>
          <button class="stats-btn" data-action="del-preset" data-k="${kind}" data-id="${escapeAttr(key)}">Radera</button>
        </div>`;
      listEl.appendChild(row);
    });
  }

  function renderPanel(kind) {
    const id   = kind === 'user' ? USER_PANEL_ID : BOT_PANEL_ID;
    const name = kind === 'user' ? state.userName : state.botName;
    const stats= kind === 'user' ? state.user : state.bot;

    let panel = document.getElementById(id);
    if (!panel) {
      panel = createEl('div', { id, class: 'stats-panel' });
      panel.innerHTML = `
        <div class="stats-header">
          <h3>${escapeHtml(name)}'s Stats</h3>
          <div class="stats-actions">
            <span class="stats-btn icon" data-action="min">_</span>
            <span class="stats-btn icon" data-action="close">×</span>
          </div>
        </div>
        <div class="stats-content"></div>
      `;
      document.body.appendChild(panel);
      makeDraggable(panel, panel.querySelector('.stats-header'));
    }

    const content = panel.querySelector('.stats-content');
    content.innerHTML = `
      ${statRow('Health', 'Health', stats.Health)}
      ${statRow('Sustenance', 'Sustenance', stats.Sustenance)}
      ${statRow('Energy', 'Energy', stats.Energy)}
      ${statRow('Hygiene', 'Hygiene', stats.Hygiene)}
      ${statRow('Arousal', 'Arousal', stats.Arousal)}
      ${metaRow('Mood', 'Mood', stats.Mood, kind)}
      ${metaRow('Conditions', 'Conditions', stats.Conditions, kind)}
      ${actionsRow(kind)}
    `;

    // events
    content.querySelectorAll('.stat-input').forEach(inp => {
      inp.addEventListener('input', onStatInputLive);
      inp.addEventListener('change', onStatInputChange);
    });
    content.querySelectorAll('.meta-input').forEach(inp => inp.addEventListener('change', onMetaChange));
    content.querySelectorAll('.stats-btn').forEach(btn => btn.addEventListener('click', onActionClick));

    renderPresets(kind, panel);

    // show/hide
    panel.style.display = state.visible[kind] ? 'block' : 'none';
    panel.querySelector('.stats-header h3').textContent = `${name}'s Stats`;
  }

  function findKindFromInput(inp) {
    const panel = inp.closest('.stats-panel');
    return panel && panel.id.includes('user') ? 'user' : 'bot';
  }

  // Live uppdatering av procentfältet
  function onStatInputLive(e) {
    const inp = e.currentTarget;
    let v = clamp(inp.value);
    inp.value = v;
    const row = inp.closest('.stat-row');
    row.querySelector('.stat-value').textContent = `${v}%`;
    row.querySelector('.stat-mask').style.width = `calc(100% - ${v}%)`;
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
      el.closest('.stats-panel').classList.toggle('minimized');
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
      state.presets[kind][name] = JSON.parse(JSON.stringify(state[kind]));
      persist();
      renderPresets(kind, document.getElementById(kind === 'user' ? USER_PANEL_ID : BOT_PANEL_ID));
      return;
    }
    if (action === 'load-last') {
      alert('Ingen historikstack implementerad. Använd presets så länge.');
      return;
    }
    if (action === 'use-preset') {
      const id = el.getAttribute('data-id');
      const src = state.presets[kind]?.[id];
      if (!src) return;
      state[kind] = JSON.parse(JSON.stringify(src));
      persist();
      renderPanel(kind);
      return;
    }
    if (action === 'del-preset') {
      const id = el.getAttribute('data-id');
      if (state.presets[kind]?.[id]) delete state.presets[kind][id];
      persist();
      renderPresets(kind, document.getElementById(kind === 'user' ? USER_PANEL_ID : BOT_PANEL_ID));
      return;
    }
  }

  // -------------- Lättviktig "lös parser" (om du vill importera från text i chatten) --------------
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

  function parseAndUpdateFromMessage(text) {
    if (!text || typeof text !== 'string') return;
    const fence = text.match(/```([\s\S]*?)```/);
    const raw = fence ? fence[1] : text;
    const obj = parseLooseYaml(raw);
    if (obj.user) mergeStats(state.user, obj.user);
    if (obj.bot)  mergeStats(state.bot, obj.bot);
    persist();
    renderPanel('user'); renderPanel('bot');
  }

  function mergeStats(target, obj) {
    ['Health','Sustenance','Energy','Hygiene','Arousal'].forEach(k => {
      if (obj[k] != null) target[k] = clamp(obj[k]);
    });
    if (obj.Mood != null) target.Mood = String(obj.Mood);
    if (obj.Conditions != null) {
      if (Array.isArray(obj.Conditions)) target.Conditions = obj.Conditions.map(String);
      else target.Conditions = String(obj.Conditions).split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  // -------------- Chat hook / MutationObserver --------------
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
  obs.observe(chatRoot, { childList: true, subtree: true });

  // Exponera liten switch för settings-UI
  window.StatsTrackerEnableAutoUpdate = function (on) {
    observerEnabled = !!on;
  };

  // -------------- API på window --------------
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

  // -------------- Settings UI (Extensions-fliken) --------------
  function createSettingsUI() {
    if (typeof $ !== 'function') return; // jQuery krävs i ST UI
    const $host = $("#extensions_settings");
    if (!$host.length) return;

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
            <input type="checkbox" id="stats-sys-toggle"
              ${extension_settings[MODULE_NAME].enableSysMessages ? 'checked' : ''}>
          </div>

          <div class="flex-container">
            <label for="stats-auto-bot">Auto-open bot panel</label>
            <input type="checkbox" id="stats-auto-bot"
              ${extension_settings[MODULE_NAME].autoOpenBot ? 'checked' : ''}>
          </div>

          <div class="flex-container">
            <label for="stats-auto-user">Auto-open user panel</label>
            <input type="checkbox" id="stats-auto-user"
              ${extension_settings[MODULE_NAME].autoOpenUser ? 'checked' : ''}>
          </div>

          <div class="flex-container">
            <label for="stats-auto-update">Enable auto updates</label>
            <input type="checkbox" id="stats-auto-update"
              ${extension_settings[MODULE_NAME].autoUpdate ? 'checked' : ''}>
          </div>

          <div class="flex-container">
            <label for="stats-prompt-input">System Prompt (optional):</label>
            <textarea id="stats-prompt-input" rows="4" placeholder="Enter system prompt for auto stats (optional)">${
              extension_settings[MODULE_NAME].autoStatsPrompt || ''
            }</textarea>
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
      if ($(this).prop('checked')) StatsTracker.showBot(true);
    });

    $("#stats-auto-user").on("input", function () {
      extension_settings[MODULE_NAME].autoOpenUser = $(this).prop('checked');
      saveSettingsDebounced();
      if ($(this).prop('checked')) StatsTracker.showUser(true);
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

  // === ST context integration (namn + event) ===
  function integrateWithSTContext() {
    try {
      const ctxApi = window.SillyTavern?.getContext?.() || null;
      if (!ctxApi) return;

      const refreshNames = () => {
        try {
          const context = window.SillyTavern.getContext();
          const character = context.characters?.[context.characterId]?.name || 'Assistant';
          state.botName = character;
          persist();
          renderPanel('bot');
        } catch {}
      };

      const { eventSource, event_types } = window.SillyTavern.getContext();
      eventSource?.on?.(event_types.CHAT_CHANGED, refreshNames);
      eventSource?.on?.(event_types.CHARACTER_CHANGED, refreshNames);
      refreshNames();
    } catch (e) {
      console.warn('[StatsTracker] ST context integration failed:', e);
    }
  }

  // -------------- First render --------------
  renderPanel('user');
  renderPanel('bot');

  // Visa per default enligt state
  if (state.visible.user) document.getElementById(USER_PANEL_ID).style.display = 'block';
  if (state.visible.bot)  document.getElementById(BOT_PANEL_ID).style.display  = 'block';

  // Knyt ST-context
  integrateWithSTContext();

  // Skapa settings-UI när ST:s Extensions finns
  if (typeof $ === 'function') {
    const tryInitSettings = () => {
      if (document.querySelector('#extensions_settings')) {
        createSettingsUI();
        if (extension_settings[MODULE_NAME].autoOpenBot) {
          setTimeout(() => StatsTracker.showBot(true), 1000);
        }
        if (extension_settings[MODULE_NAME].autoOpenUser) {
          setTimeout(() => StatsTracker.showUser(true), 1000);
        }
      } else {
        setTimeout(tryInitSettings, 500);
      }
    };
    tryInitSettings();
  }

  console.log('[StatsTracker] loaded');
})();
