/* =======================================================================
 * AeroEdu main.js — 主控: 物理仿真 + 渲染循环 + 事件调度
 * -----------------------------------------------------------------------
 * 启动顺序: DOMContentLoaded -> 构建 UI/Scene/Physics -> 绑定事件 -> RAF
 * 仿真步进: 固定步长 1/240s 子步 (提升稳定性), 渲染按 RAF
 * ======================================================================= */

(function () {
  'use strict';

  let physics, scene, ui;
  let mode = 'hover';
  let paused = false;
  let simTime = 0;
  let lastFrame = 0;
  const FIXED_DT = 1 / 240; // 物理子步

  function init() {
    // 物理实例
    const { Quadrotor, Trajectory } = window.AeroEduPhysics;
    physics = new Quadrotor();
    window._traj = Trajectory; // 供模式切换用

    // 渲染
    const container = document.getElementById('ae-canvas-wrap');
    scene = new window.AeroScene(container);

    // UI
    ui = new window.AeroUI(document.getElementById('ae-ui-root'));

    // 初始 PID 滑块
    syncPidSliders('alt');

    bindEvents();
    applyMode('hover');

    lastFrame = performance.now();
    requestAnimationFrame(loop);
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    ui.on('mode', m => applyMode(m));
    ui.on('targetAlt', v => physics.setTarget({ alt: v }));
    ui.on('pidTab', which => syncPidSliders(which));
    ui.on('pid', ({ which, k, v }) => {
      const cur = physics.getPID(which);
      cur[k] = v;
      physics.setPID(which, cur.kp, cur.ki, cur.kd);
    });
    ui.on('preset', style => applyPreset(style));
    ui.on('wind', w => physics.setWind(w.x, w.y, w.z));
    ui.on('gust', () => {
      // 随机阵风: 强冲击 + 衰减
      const g = { x: (Math.random() - 0.5) * 16, y: (Math.random() - 0.5) * 16, z: (Math.random() - 0.5) * 6 };
      physics.setWind(g.x, g.y, g.z);
      ui.setWindSliders(g);
      ui.setStatus('阵风注入中...');
      let t = 0;
      const decay = setInterval(() => {
        t += 0.1;
        const k = Math.max(0, 1 - t / 2);
        physics.setWind(g.x * k, g.y * k, g.z * k);
        ui.setWindSliders({ x: g.x * k, y: g.y * k, z: g.z * k });
        if (k <= 0.01) { clearInterval(decay); ui.setStatus('就绪'); }
      }, 100);
    });
    ui.on('reset', () => { physics.reset(); scene.clearTrail(); simTime = 0; ui.setStatus('已重置'); });
    ui.on('pause', () => { paused = !paused; ui.setStatus(paused ? '已暂停' : '运行中'); });
    ui.on('clearTrail', () => scene.clearTrail());
    ui.on('aiRun', text => runAi(text));
  }

  // ---------- 模式 ----------
  function applyMode(m) {
    mode = m;
    ui.setMode(m);
    // 切模式时清轨迹, 重新规划
    scene.clearTrail();
    simTime = 0;
    if (m === 'landing') {
      // 从当前高度下降
      physics.target.alt = Math.max(0.1, physics.pos.z);
    }
  }

  // 计算当前模式下的目标点 (世界系 ENU)
  function currentTarget(t) {
    const T = window._traj;
    let p;
    switch (mode) {
      case 'circle': p = T.circle(t); break;
      case 'figure8': p = T.figure8(t); break;
      case 'landing': p = T.landing(t); break;
      case 'hover':
      default: p = T.hover(t); break;
    }
    // 用 UI 高度覆盖 z (除 landing)
    if (mode !== 'landing') {
      const altVal = parseFloat(document.getElementById('ae-alt').value);
      p = { x: p.x, y: p.y, z: altVal };
    }
    return p;
  }

  // ---------- PID 预设 ----------
  function applyPreset(style) {
    const p = window.AeroScenario.PID_PRESETS[style];
    if (!p) return;
    const map = { alt: p.alt, roll: p.roll, pitch: p.pitch, yaw: p.yaw };
    Object.keys(map).forEach(which => {
      physics.setPID(which, map[which][0], map[which][1], map[which][2]);
    });
    syncPidSliders(ui._currentPid);
    ui.setStatus('PID: ' + style + ' — ' + p.note);
  }

  function syncPidSliders(which) {
    const p = physics.getPID(which);
    ui.setPidSliders(which, p);
  }

  // ---------- AI 场景 ----------
  function runAi(text) {
    const cfg = window.AeroScenario.parse(text);
    if (!cfg) { ui.setAiReport('未识别到有效指令'); return; }
    ui.setAiReport(window.AeroScenario.explain(cfg));

    // 应用模式
    if (cfg.mode === 'takeoff') cfg.mode = 'hover';
    applyMode(cfg.mode);
    // 风
    physics.setWind(cfg.wind.x, cfg.wind.y, cfg.wind.z);
    ui.setWindSliders(cfg.wind);
    // 高度
    if (cfg.alt !== null) {
      physics.setTarget({ alt: cfg.alt });
      ui.setAltSlider(cfg.alt);
    }
    // PID
    const map = { alt: cfg.pid.alt, roll: cfg.pid.roll, pitch: cfg.pid.pitch, yaw: cfg.pid.yaw };
    Object.keys(map).forEach(which => {
      physics.setPID(which, map[which][0], map[which][1], map[which][2]);
    });
    syncPidSliders('alt');
    ui.setStatus('AI 场景已加载: ' + cfg.mode + ' / ' + cfg.windLabel);
  }

  // ---------- 主循环 ----------
  function loop(now) {
    requestAnimationFrame(loop);
    let frameDt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (frameDt > 0.1) frameDt = 0.1; // 防止切后台后大跳

    if (!paused) {
      // 轨迹模式: 每帧更新目标点, 并把目标位置转成 alt + roll/pitch 指令
      // 简化控制: 高度用 alt 跟踪, 水平用 pitch/roll 前馈
      const tgt = currentTarget(simTime);
      physics.setTarget({ alt: tgt.z });

      // 水平位置误差 -> 期望 pitch(前飞) / roll(侧飞), 小角度近似
      const errX = tgt.x - physics.pos.x;  // 东向
      const errY = tgt.y - physics.pos.y;  // 北向
      // 期望倾斜角 (限幅 25°)
      const maxTilt = 25 * Math.PI / 180;
      const desPitch = clamp(errX * 0.4, -maxTilt, maxTilt);
      const desRoll = clamp(-errY * 0.4, -maxTilt, maxTilt);
      physics.setTarget({ pitch: desPitch, roll: desRoll, yaw: 0 });

      // 物理子步
      const steps = Math.max(1, Math.ceil(frameDt / FIXED_DT));
      const subDt = frameDt / steps;
      let state;
      for (let i = 0; i < steps; i++) {
        state = physics.step(subDt);
      }
      simTime += frameDt;

      // 同步渲染
      scene.sync(state, { showTarget: true });

      // 目标标记位置 (轨迹模式显示航点)
      if (mode === 'circle' || mode === 'figure8') {
        const t = currentTarget(simTime);
        scene.setTargetMarker({ x: t.x, y: t.z, z: -t.y }); // ENU->three
      } else {
        scene.setTargetMarker(null);
      }

      // 遥测
      ui.updateTelemetry(state);
    } else {
      // 暂停时仍渲染 (可旋转视角)
      scene.render(0);
    }

    if (!paused) scene.render(frameDt);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
