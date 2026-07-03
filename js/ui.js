/* =======================================================================
 * AeroEdu ui.js — 控制面板 + 遥测 HUD + AI 场景面板
 * -----------------------------------------------------------------------
 * 职责:
 *   - 渲染左侧控制面板 (PID 滑块 / 风扰 / 模式按钮)
 *   - 渲染右上遥测 HUD (高度/速度/姿态/RPM)
 *   - 渲染底部 AI 场景输入框 + 解析报告
 *   - 通过回调与 main.js 通信 (不直接操作物理/渲染)
 * ======================================================================= */

(function (global) {
  'use strict';

  class AeroUI {
    constructor(root) {
      this.root = root;
      this.handlers = {};
      this._build();
    }

    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); }
    _emit(event, payload) { (this.handlers[event] || []).forEach(fn => fn(payload)); }

    _build() {
      this.root.innerHTML = `
        <div class="ae-panel" id="ae-panel-left">
          <div class="ae-panel-header">
            <span class="ae-logo">翼启 <em>AeroEdu</em></span>
            <span class="ae-badge">飞控可视化教学平台</span>
          </div>

          <div class="ae-section">
            <div class="ae-section-title">飞行模式</div>
            <div class="ae-mode-grid">
              <button data-mode="hover" class="ae-mode-btn active">悬停</button>
              <button data-mode="circle" class="ae-mode-btn">圆周</button>
              <button data-mode="figure8" class="ae-mode-btn">8字</button>
              <button data-mode="landing" class="ae-mode-btn">着陆</button>
            </div>
            <div class="ae-row">
              <label>目标高度</label>
              <input type="range" id="ae-alt" min="0.2" max="6" step="0.1" value="2.0">
              <span class="ae-val" id="ae-alt-v">2.0 m</span>
            </div>
          </div>

          <div class="ae-section">
            <div class="ae-section-title">PID 调参 <span class="ae-hint">(实时生效)</span></div>
            <div class="ae-pid-tabs">
              <button data-pid="alt" class="ae-pid-tab active">高度</button>
              <button data-pid="roll" class="ae-pid-tab">横滚</button>
              <button data-pid="pitch" class="ae-pid-tab">俯仰</button>
              <button data-pid="yaw" class="ae-pid-tab">偏航</button>
            </div>
            <div class="ae-row"><label>Kp</label><input type="range" id="ae-kp" min="0" max="20" step="0.1"><span class="ae-val" id="ae-kp-v"></span></div>
            <div class="ae-row"><label>Ki</label><input type="range" id="ae-ki" min="0" max="8" step="0.05"><span class="ae-val" id="ae-ki-v"></span></div>
            <div class="ae-row"><label>Kd</label><input type="range" id="ae-kd" min="0" max="6" step="0.05"><span class="ae-val" id="ae-kd-v"></span></div>
            <div class="ae-pid-presets">
              <button data-preset="soft">柔和</button>
              <button data-preset="balanced">均衡</button>
              <button data-preset="agile">激进</button>
              <button data-preset="oscillate">振荡</button>
            </div>
          </div>

          <div class="ae-section">
            <div class="ae-section-title">环境扰动</div>
            <div class="ae-row"><label>侧风 X</label><input type="range" id="ae-wx" min="-12" max="12" step="0.1" value="0"><span class="ae-val" id="ae-wx-v">0.0</span></div>
            <div class="ae-row"><label>逆风 Y</label><input type="range" id="ae-wy" min="-12" max="12" step="0.1" value="0"><span class="ae-val" id="ae-wy-v">0.0</span></div>
            <div class="ae-row"><label>阵风 Z</label><input type="range" id="ae-wz" min="-5" max="5" step="0.1" value="0"><span class="ae-val" id="ae-wz-v">0.0</span></div>
            <button id="ae-gust-btn" class="ae-mini-btn">注入随机阵风</button>
          </div>

          <div class="ae-section">
            <div class="ae-row ae-tight">
              <button id="ae-reset" class="ae-mini-btn">重置</button>
              <button id="ae-pause" class="ae-mini-btn">暂停</button>
              <button id="ae-trail" class="ae-mini-btn">清轨迹</button>
            </div>
          </div>
        </div>

        <div class="ae-hud" id="ae-hud">
          <div class="ae-hud-row"><span>高度</span><b id="hud-alt">0.00</b><span>m</span></div>
          <div class="ae-hud-row"><span>爬升率</span><b id="hud-vz">0.00</b><span>m/s</span></div>
          <div class="ae-hud-row"><span>水平速度</span><b id="hud-vh">0.00</b><span>m/s</span></div>
          <div class="ae-hud-divider"></div>
          <div class="ae-hud-row"><span>横滚</span><b id="hud-roll">0.0</b><span>°</span></div>
          <div class="ae-hud-row"><span>俯仰</span><b id="hud-pitch">0.0</b><span>°</span></div>
          <div class="ae-hud-row"><span>偏航</span><b id="hud-yaw">0.0</b><span>°</span></div>
          <div class="ae-hud-divider"></div>
          <div class="ae-hud-row ae-rpm"><span>RPM</span><b id="hud-rpm">0 0 0 0</b></div>
          <div class="ae-hud-status" id="hud-status">就绪</div>
        </div>

        <div class="ae-ai" id="ae-ai">
          <div class="ae-ai-header">
            <span class="ae-ai-title">✦ AI 场景生成</span>
            <span class="ae-ai-sub">输入自然语言, 自动配置工况与 PID</span>
          </div>
          <div class="ae-ai-input-row">
            <input type="text" id="ae-ai-text" placeholder="例: 5级侧风下悬停在3米,使用激进PID">
            <button id="ae-ai-run">生成</button>
          </div>
          <div class="ae-ai-examples" id="ae-ai-examples"></div>
          <pre class="ae-ai-report" id="ae-ai-report"></pre>
        </div>
      `;
      this._wire();
      this._populateExamples();
      this._currentPid = 'alt';
    }

    _wire() {
      // 模式按钮
      this.root.querySelectorAll('.ae-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.root.querySelectorAll('.ae-mode-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this._emit('mode', btn.dataset.mode);
        });
      });
      // 高度
      const alt = this.root.querySelector('#ae-alt');
      alt.addEventListener('input', () => {
        this.root.querySelector('#ae-alt-v').textContent = parseFloat(alt.value).toFixed(1) + ' m';
        this._emit('targetAlt', parseFloat(alt.value));
      });
      // PID tabs
      this.root.querySelectorAll('.ae-pid-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          this.root.querySelectorAll('.ae-pid-tab').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this._currentPid = btn.dataset.pid;
          this._emit('pidTab', btn.dataset.pid);
        });
      });
      // PID sliders
      ['kp', 'ki', 'kd'].forEach(k => {
        const el = this.root.querySelector('#ae-' + k);
        el.addEventListener('input', () => {
          const v = parseFloat(el.value);
          this.root.querySelector('#ae-' + k + '-v').textContent = v.toFixed(2);
          this._emit('pid', { which: this._currentPid, k, v });
        });
      });
      // PID presets
      this.root.querySelectorAll('.ae-pid-presets button').forEach(btn => {
        btn.addEventListener('click', () => this._emit('preset', btn.dataset.preset));
      });
      // 风
      ['wx', 'wy', 'wz'].forEach(k => {
        const el = this.root.querySelector('#ae-' + k);
        el.addEventListener('input', () => {
          const v = parseFloat(el.value);
          this.root.querySelector('#ae-' + k + '-v').textContent = v.toFixed(1);
          this._emit('wind', { x: parseFloat(this.root.querySelector('#ae-wx').value), y: parseFloat(this.root.querySelector('#ae-wy').value), z: parseFloat(this.root.querySelector('#ae-wz').value) });
        });
      });
      // 阵风按钮
      this.root.querySelector('#ae-gust-btn').addEventListener('click', () => this._emit('gust', null));
      // 重置/暂停/清轨迹
      this.root.querySelector('#ae-reset').addEventListener('click', () => this._emit('reset', null));
      const pauseBtn = this.root.querySelector('#ae-pause');
      pauseBtn.addEventListener('click', () => { this._emit('pause', null); pauseBtn.textContent = pauseBtn.textContent === '暂停' ? '继续' : '暂停'; });
      this.root.querySelector('#ae-trail').addEventListener('click', () => this._emit('clearTrail', null));
      // AI
      const aiText = this.root.querySelector('#ae-ai-text');
      const runAi = () => this._emit('aiRun', aiText.value);
      this.root.querySelector('#ae-ai-run').addEventListener('click', runAi);
      aiText.addEventListener('keydown', e => { if (e.key === 'Enter') runAi(); });
    }

    _populateExamples() {
      const box = this.root.querySelector('#ae-ai-examples');
      const examples = global.AeroScenario ? global.AeroScenario.EXAMPLES : [];
      box.innerHTML = examples.map(e => `<span class="ae-chip" data-ex="${e}">${e}</span>`).join('');
      box.querySelectorAll('.ae-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          this.root.querySelector('#ae-ai-text').value = chip.dataset.ex;
          this._emit('aiRun', chip.dataset.ex);
        });
      });
    }

    // ---- 由 main.js 调用 ----
    setMode(mode) {
      this.root.querySelectorAll('.ae-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    }
    setPidSliders(which, p) {
      this._currentPid = which;
      this.root.querySelectorAll('.ae-pid-tab').forEach(b => b.classList.toggle('active', b.dataset.pid === which));
      const set = (id, val) => {
        const el = this.root.querySelector(id);
        el.value = val;
        this.root.querySelector(id + '-v').textContent = val.toFixed(2);
      };
      set('#ae-kp', p.kp); set('#ae-ki', p.ki); set('#ae-kd', p.kd);
    }
    setWindSliders(w) {
      const set = (id, v) => {
        const el = this.root.querySelector(id);
        el.value = v;
        this.root.querySelector(id + '-v').textContent = v.toFixed(1);
      };
      set('#ae-wx', w.x); set('#ae-wy', w.y); set('#ae-wz', w.z);
    }
    setAltSlider(v) {
      const el = this.root.querySelector('#ae-alt'); el.value = v;
      this.root.querySelector('#ae-alt-v').textContent = v.toFixed(1) + ' m';
    }
    setAiReport(text) {
      this.root.querySelector('#ae-ai-report').textContent = text;
    }
    setStatus(text) {
      this.root.querySelector('#hud-status').textContent = text;
    }

    // 更新遥测 (每帧)
    updateTelemetry(s) {
      const rad2deg = r => (r * 180 / Math.PI).toFixed(1);
      const set = (id, v) => { const el = this.root.querySelector(id); if (el) el.textContent = v; };
      set('#hud-alt', s.pos.z.toFixed(2));
      set('#hud-vz', s.vel.z.toFixed(2));
      set('#hud-vh', Math.hypot(s.vel.x, s.vel.y).toFixed(2));
      set('#hud-roll', rad2deg(s.ang.x));
      set('#hud-pitch', rad2deg(s.ang.y));
      set('#hud-yaw', rad2deg(s.ang.z));
      set('#hud-rpm', s.rotorRPM.map(r => Math.round(r)).join(' '));
    }
  }

  global.AeroUI = AeroUI;
})(typeof window !== 'undefined' ? window : globalThis);
