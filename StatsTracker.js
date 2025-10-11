// StatsTracker.js
(() => {
  try {
    // ===== Extension wiring (ST-style) =====
    const MODULE_NAME = 'stats_tracker';

    // ST brukar exposa extension_settings + saveSettingsDebounced
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
    const DEFAULT_USER_NAME = (window.STT_USER_NAME || 'User');       // sätt gärna via global
    const DEFAULT_BOT_NAME  = (window.STT_BOT_NAME  || 'Assistant');

    const DEFAULT_STATS = {
      Health: 80,
      Sustenance: 80,
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
      presets: {
        user: {},
        bot: {}
      },
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

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function escapeAttr(s) { return escapeHtml(s); }
    function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    // -------------- Rendering --------------
    function renderPanel(kind) {
      // kind: 'user' | 'bot'
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

      // attach listeners
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
      // adjust bar masks
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
      const bank = state.presets[kind] || {};
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

    // -------------- Events --------------
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
        state.presets[kind][name] = JSON.parse(JSON.stringify(state[kind]));
        persist();
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
          const preset = state.presets[kind][id];
          if (preset) {
            state[kind] = JSON.parse(JSON.stringify(preset));
            persist();
            renderPanel(kind);
          }
        } else {
          delete state.presets[kind][id];
          persist();
          renderPresets(kind);
        }
        return;
      }
    }

    function findKindFromInput(inp) {
      const panel = inp.closest('.stats-panel');
      return panel.id.includes('user') ? 'user' : 'bot';
    }

    // -------------- Parser (AI output -> state) --------------
    // 1) Robust: ```stats ...yaml-ish... ```
    // 2) Fallback: “<user>’s Stats\n---\n- Health: X% ... 💎: Mood | Conditions”
    const FENCE_STATS = /```stats\s+([\s\S]*?)```/i;
    const CLASSIC_BLOCK = new RegExp(
      String.raw`${escapeReg(DEFAULT_USER_NAME)}'s Stats\s*\n---\n- Health:\s*([0-9]+)%\n- Sustenance:\s*([0-9]+)%\n- Energy:\s*([0-9]+)%\n- Hygiene:\s*([0-9]+)%\n- Arousal:\s*([0-9]+)%\n💎:\s*([\s\S]*?)$`,
      'mi'
    );

    function parseAndUpdateFromMessage(text) {
      if (!text) return;

      // Prefer fenced stats block
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

      // Fallback: classic single-user block like the one in your example
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
        if (Array.isArray(obj.Conditions)) target.Con
