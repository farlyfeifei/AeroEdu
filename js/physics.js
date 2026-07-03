/* =======================================================================
 * AeroEdu physics.js — 四旋翼飞行动力学 + PID 控制器 (纯 JS, 无依赖)
 * -----------------------------------------------------------------------
 * 设计目标:
 *   - 真实刚体动力学: 重力 / 旋翼推力 / 空气阻力 / 风扰
 *   - 级联 PID: 高度环 + 姿态环 (roll/pitch/yaw)
 *   - 数值积分: 半隐式 Euler (稳定且廉价, 适合浏览器实时)
 *   - 可独立测试: 不依赖 Three.js, 可在 Node 中跑单元自检
 *
 * 坐标系: ENU (x=东, y=北, z=上), 与 Three.js Y-up 一致
 *         注意: 这里用 z 为上, 渲染层再映射到 Three.js 的 y-up
 * ======================================================================= */

(function (global) {
  'use strict';

  // ---------- 极简向量工具 (避免耦合 Three.js) ----------
  function v3(x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; }
  function vAdd(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
  function vSub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
  function vScale(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
  function vLen(a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
  function vNorm(a) {
    const l = vLen(a) || 1;
    return v3(a.x / l, a.y / l, a.z / l);
  }
  function vCross(a, b) {
    return v3(
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x
    );
  }

  // 欧拉角 (roll, pitch, yaw) -> 旋转矩阵 (列向量形式)
  // 旋转顺序: ZYX (yaw -> pitch -> roll), 航空常用
  function eulerToMatrix(roll, pitch, yaw) {
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // 行向量矩阵
    return {
      x: v3(cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr),
      y: v3(sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr),
      z: v3(-sp, cp * sr, cp * cr),
    };
  }
  // 矩阵 * 向量
  function mApply(m, v) {
    return v3(
      m.x.x * v.x + m.y.x * v.y + m.z.x * v.z,
      m.x.y * v.x + m.y.y * v.y + m.z.y * v.z,
      m.x.z * v.x + m.y.z * v.y + m.z.z * v.z
    );
  }
  function mTranspose(m) {
    return {
      x: v3(m.x.x, m.y.x, m.z.x),
      y: v3(m.x.y, m.y.y, m.z.y),
      z: v3(m.x.z, m.y.z, m.z.z),
    };
  }

  // ---------- PID 控制器 ----------
  class PID {
    constructor(kp, ki, kd, iMax, dFilter) {
      this.kp = kp;
      this.ki = ki;
      this.kd = kd;
      this.iMax = iMax === undefined ? 5 : iMax;
      this.dFilter = dFilter === undefined ? 0.85 : dFilter; // 一阶低通
      this._i = 0;
      this._prevErr = 0;
      this._dFiltered = 0;
    }
    reset() { this._i = 0; this._prevErr = 0; this._dFiltered = 0; }
    set(kp, ki, kd) {
      if (kp !== undefined) this.kp = kp;
      if (ki !== undefined) this.ki = ki;
      if (kd !== undefined) this.kd = kd;
    }
    update(err, dt) {
      const p = this.kp * err;
      this._i += err * dt;
      // 抗积分饱和
      const iTerm = this.ki * this._i;
      if (iTerm > this.iMax) { this._i = this.iMax / (this.ki || 1); }
      else if (iTerm < -this.iMax) { this._i = -this.iMax / (this.ki || 1); }
      // 微分带低通滤波, 抑制噪声
      let dRaw = (err - this._prevErr) / (dt || 1e-3);
      this._dFiltered = this.dFilter * this._dFiltered + (1 - this.dFilter) * dRaw;
      this._prevErr = err;
      return p + this.ki * this._i + this.kd * this._dFiltered;
    }
  }

  // ---------- 四旋翼飞行器 ----------
  class Quadrotor {
    constructor(opts) {
      opts = opts || {};
      // 物理参数 (贴近 250mm 穿越机量级)
      this.mass = opts.mass || 0.8;          // kg
      this.armLen = opts.armLen || 0.16;     // m
      this.g = 9.81;
      // 惯量 (近似为薄板: Ix=Iy, Iz 较大)
      this.I = opts.inertia || { x: 0.004, y: 0.004, z: 0.007 };
      // 阻力
      this.linDrag = opts.linDrag || 0.15;
      this.angDrag = opts.angDrag || 0.02;
      // 推力限幅
      this.thrustMin = opts.thrustMin || 0;
      this.thrustMax = opts.thrustMax || 12; // 单电机 N
      // 状态
      this.pos = v3(0, 0, 1.0);              // 起飞高度 1m
      this.vel = v3(0, 0, 0);
      this.ang = v3(0, 0, 0);                // roll, pitch, yaw
      this.angVel = v3(0, 0, 0);             // body rates p,q,r
      this.rotorRPM = [0, 0, 0, 0];          // 4 个旋翼 (FR, FL, BR, BL)
      this.wind = v3(0, 0, 0);               // 外部风扰 (世界系, m/s)
      // 控制器: 高度 + roll + pitch + yaw
      this.pidAlt = new PID(8.0, 4.0, 3.0, 6, 0.8);
      this.pidRoll = new PID(6.0, 0.5, 1.2, 3, 0.85);
      this.pidPitch = new PID(6.0, 0.5, 1.2, 3, 0.85);
      this.pidYaw = new PID(2.5, 0.1, 0.4, 1.5, 0.9);
      // 目标
      this.target = { alt: 2.0, roll: 0, pitch: 0, yaw: 0 };
      // 噪声 (模拟 IMU 抖动)
      this.sensorNoise = opts.sensorNoise || 0.002;
    }

    reset() {
      this.pos = v3(0, 0, 1.0);
      this.vel = v3(0, 0, 0);
      this.ang = v3(0, 0, 0);
      this.angVel = v3(0, 0, 0);
      this.rotorRPM = [0, 0, 0, 0];
      this.pidAlt.reset(); this.pidRoll.reset();
      this.pidPitch.reset(); this.pidYaw.reset();
    }

    // ---- 控制律: 输出 4 个旋翼推力 (N) ----
    _mixControl(dt) {
      const t = this.target;
      // 高度环: 误差 -> 总推力基线
      const altErr = t.alt - this.pos.z;
      const altOut = this.pidAlt.update(altErr, dt);
      // 悬停推力补偿重力
      const hoverThrust = this.mass * this.g;
      const baseThrust = hoverThrust + altOut; // 总推力

      // 姿态环: 误差 -> 角加速度需求 -> 力矩
      const rollOut = this.pidRoll.update(t.roll - this.ang.x, dt);
      const pitchOut = this.pidPitch.update(t.pitch - this.ang.y, dt);
      const yawOut = this.pidYaw.update(t.yaw - this.ang.z, dt);

      // 混控: 把总推力 + 力矩分配到 4 电机 (X 型)
      // 电机布局 (俯视, x 前, y 右):
      //   FR(前右)  FL(前左)
      //   BR(后右)  BL(后左)
      // roll (+右倾) -> 左侧电机加, 右侧减
      // pitch(+前倾) -> 后侧电机加, 前侧减
      // yaw          -> 对角线差速
      const L = this.armLen;
      const k = 0.05; // 反扭矩系数
      const tFR = baseThrust / 4 - rollOut / (2 * L) - pitchOut / (2 * L) - yawOut / (2 * k);
      const tFL = baseThrust / 4 + rollOut / (2 * L) - pitchOut / (2 * L) + yawOut / (2 * k);
      const tBR = baseThrust / 4 - rollOut / (2 * L) + pitchOut / (2 * L) + yawOut / (2 * k);
      const tBL = baseThrust / 4 + rollOut / (2 * L) + pitchOut / (2 * L) - yawOut / (2 * k);
      const clamp = (v) => Math.max(this.thrustMin, Math.min(this.thrustMax, v));
      const T = [clamp(tFR), clamp(tFL), clamp(tBR), clamp(tBL)];
      // 推力 -> RPM (仅用于视觉, 近似)
      for (let i = 0; i < 4; i++) {
        this.rotorRPM[i] = Math.sqrt(Math.max(0, T[i])) * 1200;
      }
      return T;
    }

    // ---- 动力学前推一步 ----
    step(dt) {
      dt = Math.min(dt, 1 / 60); // 防止大步长发散
      const T = this._mixControl(dt);

      // 1) 旋翼合力 (body +z 方向) + 合力矩
      const R = eulerToMatrix(this.ang.x, this.ang.y, this.ang.z);
      // body z 轴在世界系的方向
      const bodyZWorld = { x: R.z.x, y: R.z.y, z: R.z.z }; // 第三列 (mApply(R, z) 的等价)
      // 实际 mApply(R, v3(0,0,1)) = R 的第三列, 用上面的列定义: R.x.z,R.y.z,R.z.z ... 这里我们的矩阵是行向量, 转置处理
      const bodyUp = mApply(mTranspose(R), v3(0, 0, 1));
      const totalThrust = T[0] + T[1] + T[2] + T[3];
      const thrustForce = vScale(bodyUp, totalThrust);

      // 重力
      const gravity = v3(0, 0, -this.mass * this.g);

      // 线性阻力 (-k * v_world)
      const linDragF = vScale(this.vel, -this.linDrag);

      // 风扰 (相对速度产生额外阻力 -> 等效为外力)
      const relVel = vSub(this.vel, this.wind);
      const windF = vScale(vSub(this.vel, relVel), this.linDrag); // = k*wind
      // 注意: 这里直接把风作为外力 k*v_wind, 简化但直观

      // 合加速度
      const accel = vScale(
        vAdd(vAdd(vAdd(thrustForce, gravity), linDragF), windF),
        1 / this.mass
      );

      // 2) 力矩 (body 系)
      // roll/pitch 力矩来自旋翼推力差 * 臂长
      // yaw 力矩来自旋翼反扭矩
      const L = this.armLen, k = 0.05;
      const tauRoll = L * ((T[1] + T[3]) - (T[0] + T[2]));
      const tauPitch = L * ((T[2] + T[3]) - (T[0] + T[1]));
      const tauYaw = k * (-T[0] + T[1] + T[2] - T[3]);
      // 角阻尼
      const angDamp = vScale(this.angVel, -this.angDrag);
      const tauBody = v3(tauRoll + angDamp.x, tauPitch + angDamp.y, tauYaw + angDamp.z);

      // 角加速度 (body 系): alpha = I^-1 * tau
      const angAccel = v3(tauBody.x / this.I.x, tauBody.y / this.I.y, tauBody.z / this.I.z);

      // 3) 积分 (半隐式 Euler)
      this.vel = vAdd(this.vel, vScale(accel, dt));
      this.pos = vAdd(this.pos, vScale(this.vel, dt));
      // 地面碰撞
      if (this.pos.z < 0.02) {
        this.pos.z = 0.02;
        if (this.vel.z < 0) this.vel.z = -this.vel.z * 0.2; // 弹性耗散
        this.vel.x *= 0.7; this.vel.y *= 0.7;
      }
      // body rates 积分
      this.angVel = vAdd(this.angVel, vScale(angAccel, dt));
      // body rates -> 欧拉角变化率 (简化: 小角度近似, 直接加)
      // 严格做法涉及 R 转换, 教学场景小角度足够
      this.ang = vAdd(this.ang, vScale(this.angVel, dt));
      // 角度归一化 (-pi, pi]
      this.ang.x = this._wrap(this.ang.x);
      this.ang.y = this._wrap(this.ang.y);
      this.ang.z = this._wrap(this.ang.z);

      return this.state();
    }

    _wrap(a) {
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return a;
    }

    // 设置目标 (世界系)
    setTarget(opts) {
      if (opts.alt !== undefined) this.target.alt = opts.alt;
      if (opts.roll !== undefined) this.target.roll = opts.roll;
      if (opts.pitch !== undefined) this.target.pitch = opts.pitch;
      if (opts.yaw !== undefined) this.target.yaw = opts.yaw;
    }

    setWind(x, y, z) { this.wind = v3(x || 0, y || 0, z || 0); }

    // 状态快照 (供 UI/渲染读取)
    state() {
      return {
        pos: { x: this.pos.x, y: this.pos.y, z: this.pos.z },
        vel: { x: this.vel.x, y: this.vel.y, z: this.vel.z },
        ang: { x: this.ang.x, y: this.ang.y, z: this.ang.z },
        angVel: { x: this.angVel.x, y: this.angVel.y, z: this.angVel.z },
        rotorRPM: this.rotorRPM.slice(),
        wind: { x: this.wind.x, y: this.wind.y, z: this.wind.z },
        target: { ...this.target },
        // 调试: PID 累积项
        pidI: { alt: this.pidAlt._i, roll: this.pidRoll._i, pitch: this.pidPitch._i, yaw: this.pidYaw._i },
      };
    }

    // 设置 PID 参数 (UI 调参用)
    setPID(which, kp, ki, kd) {
      const map = { alt: this.pidAlt, roll: this.pidRoll, pitch: this.pidPitch, yaw: this.pidYaw };
      if (map[which]) map[which].set(kp, ki, kd);
    }
    getPID(which) {
      const map = { alt: this.pidAlt, roll: this.pidRoll, pitch: this.pidPitch, yaw: this.pidYaw };
      const p = map[which];
      return p ? { kp: p.kp, ki: p.ki, kd: p.kd } : null;
    }
  }

  // ---------- 航点轨迹生成器 (8 字 / 圆形) ----------
  const Trajectory = {
    hover(t) { return { x: 0, y: 0, z: 2.0 }; },
    circle(t) {
      const r = 2.5, w = 0.4;
      return { x: r * Math.cos(w * t), y: r * Math.sin(w * t), z: 2.0 };
    },
    figure8(t) {
      const a = 2.5, w = 0.5;
      return { x: a * Math.sin(w * t), y: a * Math.sin(w * t) * Math.cos(w * t), z: 2.0 };
    },
    landing(t) {
      // 从 2.5m 线性下降
      const z = Math.max(0.1, 2.5 - 0.15 * t);
      return { x: 0, y: 0, z };
    },
  };

  // ---------- 导出 ----------
  global.AeroEduPhysics = {
    Quadrotor,
    PID,
    Trajectory,
    _v3: v3,
  };
})(typeof window !== 'undefined' ? window : globalThis);
