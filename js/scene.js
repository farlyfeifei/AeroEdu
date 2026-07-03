/* =======================================================================
 * AeroEdu scene.js — Three.js 3D 渲染层
 * -----------------------------------------------------------------------
 * 职责:
 *   - 场景 / 相机 / 渲染器 / 灯光 / 地面
 *   - 自建四旋翼模型 (机身 + 4 机臂 + 4 旋翼)
 *   - 轨迹拖尾 / 推力尾流 / 网格地面 / 坐标轴
 *   - 把 physics 状态同步到 3D (ENU-z上 -> Three.js Y-up)
 *   - 相机轨道控制
 *
 * 依赖: THREE (全局, 由 index.html 通过 CDN 引入)
 * ======================================================================= */

(function (global) {
  'use strict';

  class AeroScene {
    constructor(container) {
      this.container = container;
      this.clock = new THREE.Clock();

      // ---- 渲染器 ----
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      container.appendChild(this.renderer.domElement);

      // ---- 场景 ----
      this.scene = new THREE.Scene();
      this._buildSky();
      this._buildLights();
      this._buildGround();
      this._buildAxes();

      // ---- 相机 ----
      this.camera = new THREE.PerspectiveCamera(
        55,
        container.clientWidth / container.clientHeight,
        0.1, 200
      );
      this.camera.position.set(5, 4, 6);

      // 轨道控制 (CDN examples/jsm/controls/OrbitControls.js)
      if (global.OrbitControls) {
        this.controls = new global.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.target.set(0, 1.5, 0);
        this.controls.maxDistance = 30;
        this.controls.minDistance = 1.5;
        this.controls.maxPolarAngle = Math.PI * 0.49;
      }

      // ---- 无人机模型 ----
      this.drone = this._buildDrone();
      this.scene.add(this.drone.group);

      // ---- 轨迹拖尾 ----
      this.trailMax = 400;
      this.trailPositions = new Float32Array(this.trailMax * 3);
      this.trailIndex = 0;
      const trailGeom = new THREE.BufferGeometry();
      trailGeom.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
      trailGeom.setDrawRange(0, 0);
      const trailMat = new THREE.LineBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.8 });
      this.trail = new THREE.Line(trailGeom, trailMat);
      this.scene.add(this.trail);

      // ---- 目标点标记 (虚线球) ----
      this.targetMarker = this._buildTargetMarker();
      this.scene.add(this.targetMarker);

      // ---- 风扰可视化 (箭头) ----
      this.windArrow = this._buildWindArrow();
      this.scene.add(this.windArrow);

      // ---- 自适应 ----
      window.addEventListener('resize', () => this._onResize());

      // 用于外部读时间
      this.elapsed = 0;
    }

    // ---------------- 场景元素 ----------------
    _buildSky() {
      // 渐变天空: 大球内表面
      const geom = new THREE.SphereGeometry(80, 32, 16);
      const mat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          top: { value: new THREE.Color(0x1a3a5c) },
          bottom: { value: new THREE.Color(0xb8d8f0) },
        },
        vertexShader: `
          varying vec3 vPos;
          void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
        `,
        fragmentShader: `
          uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
          void main(){
            float h = normalize(vPos).y * 0.5 + 0.5;
            gl_FragColor = vec4(mix(bottom, top, h), 1.0);
          }
        `,
      });
      this.scene.add(new THREE.Mesh(geom, mat));
    }

    _buildLights() {
      const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x4a5a4a, 0.7);
      this.scene.add(hemi);
      const dir = new THREE.DirectionalLight(0xffffff, 1.0);
      dir.position.set(8, 12, 6);
      dir.castShadow = true;
      dir.shadow.mapSize.set(2048, 2048);
      dir.shadow.camera.left = -10;
      dir.shadow.camera.right = 10;
      dir.shadow.camera.top = 10;
      dir.shadow.camera.bottom = -10;
      dir.shadow.camera.near = 0.5;
      dir.shadow.camera.far = 40;
      this.scene.add(dir);
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    }

    _buildGround() {
      // 网格地面
      const grid = new THREE.GridHelper(40, 40, 0x4a6a8a, 0x2a3a4a);
      grid.position.y = 0;
      this.scene.add(grid);
      // 实心地面 (接收阴影)
      const groundGeom = new THREE.PlaneGeometry(40, 40);
      const groundMat = new THREE.MeshStandardMaterial({
        color: 0x162028, roughness: 0.95, metalness: 0.0,
      });
      const ground = new THREE.Mesh(groundGeom, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.001;
      ground.receiveShadow = true;
      this.scene.add(ground);
    }

    _buildAxes() {
      // 原点坐标轴 (ENU: x 东红, z 北绿... 这里映射后: x红 y绿 z蓝)
      const axes = new THREE.AxesHelper(1.2);
      axes.position.set(0, 0.01, 0);
      this.scene.add(axes);
    }

    // ---------------- 无人机模型 ----------------
    _buildDrone() {
      const group = new THREE.Group();

      // 机身 (中心仓)
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.5, metalness: 0.6 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.07, 0.18), bodyMat);
      body.castShadow = true;
      group.add(body);

      // 顶部传感器仓 (IMU/雷达模块造型)
      const topMat = new THREE.MeshStandardMaterial({ color: 0x4fd1ff, roughness: 0.3, metalness: 0.2, emissive: 0x113344, emissiveIntensity: 0.5 });
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.03, 16), topMat);
      top.position.y = 0.05;
      top.castShadow = true;
      group.add(top);

      // 4 机臂 + 电机 + 旋翼 (X 型)
      // 电机位置 (俯视, x前 y右 ... 注意 Three.js: x右 y上 z前/后)
      // 我们把无人机面朝 -z 方向飞行, 机臂在 xz 平面
      const armLen = 0.16;
      const armAngles = [
        -Math.PI / 4,  // 前右
        Math.PI / 4,   // 前左
        Math.PI + Math.PI / 4, // 后左 -- 调整布局
        Math.PI - Math.PI / 4, // 后右
      ];
      // 重新定义 4 个电机位置 (X 型, 俯视):
      // FR: (+x, -z)  FL: (-x, -z)  BR: (+x, +z)  BL: (-x, +z)
      const motorPos = [
        [armLen * 0.707, 0, -armLen * 0.707],  // FR
        [-armLen * 0.707, 0, -armLen * 0.707], // FL
        [armLen * 0.707, 0, armLen * 0.707],   // BR
        [-armLen * 0.707, 0, armLen * 0.707],  // BL
      ];
      const armMat = new THREE.MeshStandardMaterial({ color: 0x333a45, roughness: 0.6, metalness: 0.5 });
      const motorMat = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.4, metalness: 0.8 });
      const rotorMat = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.8, transparent: true, opacity: 0.55, side: THREE.DoubleSide });

      this.rotors = [];
      motorPos.forEach((p, i) => {
        // 机臂
        const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen * 1.0, 0.012, 0.02), armMat);
        arm.position.set(p[0] * 0.5, 0, p[2] * 0.5);
        arm.lookAt(new THREE.Vector3(p[0], 0, p[2]));
        arm.castShadow = true;
        group.add(arm);
        // 电机
        const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.04, 16), motorMat);
        motor.position.set(p[0], 0.02, p[2]);
        motor.castShadow = true;
        group.add(motor);
        // 旋翼 (两片桨叶)
        const rotorGroup = new THREE.Group();
        rotorGroup.position.set(p[0], 0.045, p[2]);
        const blade = new THREE.Mesh(new THREE.BoxGeometry(armLen * 1.6, 0.004, 0.02), rotorMat);
        rotorGroup.add(blade);
        const blade2 = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.004, armLen * 1.6), rotorMat);
        rotorGroup.add(blade2);
        group.add(rotorGroup);
        this.rotors.push(rotorGroup);
      });

      // 起落架 (4 个小柱)
      const legMat = new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.7 });
      [[0.07, 0.07], [-0.07, 0.07], [0.07, -0.07], [-0.07, -0.07]].forEach(([x, z]) => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.06, 8), legMat);
        leg.position.set(x, -0.05, z);
        group.add(leg);
      });

      // LED 指示灯 (前红后绿, 标识朝向)
      const ledFront = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xff3333, emissive: 0xff0000, emissiveIntensity: 1 }));
      ledFront.position.set(0, 0.02, -0.09);
      group.add(ledFront);
      const ledBack = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0x33ff66, emissive: 0x00ff00, emissiveIntensity: 1 }));
      ledBack.position.set(0, 0.02, 0.09);
      group.add(ledBack);

      return { group, body, rotors: this.rotors };
    }

    _buildTargetMarker() {
      const group = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.15, 0.012, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.9 })
      );
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffcc44 })
      );
      group.add(ball);
      group.visible = false;
      this.targetRing = ring;
      return group;
    }

    _buildWindArrow() {
      const dir = new THREE.Vector3(1, 0, 0);
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 3, 0), 1.2, 0x88ccff, 0.3, 0.15);
      arrow.visible = false;
      return arrow;
    }

    // ---------------- 同步状态 ----------------
    // physics 用 ENU(z 上), Three.js 用 Y-up. 映射: physics(x,y,z) -> three(x, z, -y)
    // 即: physics 东=x, 北=y, 上=z  ->  three x=东, y=上, z=-北(南)
    _p2t(p) { return new THREE.Vector3(p.x, p.z, -p.y); }

    sync(physicsState, opts) {
      opts = opts || {};
      const s = physicsState;
      const pos = this._p2t(s.pos);
      this.drone.group.position.copy(pos);

      // 姿态: physics roll(x) pitch(y) yaw(z)
      // Three.js Euler 默认 XYZ 顺序, 这里直接用 (roll, -pitch? ... )
      // 简化: 取 physics 的 roll->x, pitch->z? 实际飞行器 pitch 抬头绕 body y 轴
      // 为教学直观, 我们让 roll 绕 Three.x, pitch 绕 Three.z (因为映射后 body 前向 = -z)
      // 设置欧拉 (ZYX 顺序以匹配物理)
      const e = new THREE.Euler(s.ang.x, s.ang.z, -s.ang.y, 'ZYX');
      this.drone.group.quaternion.setFromEuler(e);

      // 旋翼旋转 (速度正比于 RPM)
      const rpm0 = 1681; // 悬停基准
      for (let i = 0; i < 4; i++) {
        const speed = (s.rotorRPM[i] / rpm0) * 60; // rad/s 近似
        this.rotors[i].rotation.y += speed * (this.lastDt || 0.016) * (i % 2 === 0 ? 1 : -1);
      }

      // 轨迹拖尾
      if (!opts.noTrail) {
        this._pushTrail(pos);
      }

      // 目标点
      const tg = s.target;
      const targetPos = new THREE.Vector3(0, tg.alt, 0); // 悬停目标在原点上方
      // 若有航点模式, 由 main.js 设置 targetMarker 位置
      if (this._customTarget) {
        this.targetMarker.position.copy(this._customTarget);
      } else {
        this.targetMarker.position.set(0, tg.alt, 0);
      }
      this.targetMarker.visible = !!opts.showTarget;
      // 环旋转动画
      if (this.targetRing) this.targetRing.rotation.z += 0.02;

      // 风扰箭头
      const w = s.wind;
      const wlen = Math.hypot(w.x, w.y, w.z);
      if (wlen > 0.05) {
        this.windArrow.visible = true;
        this.windArrow.position.set(pos.x, pos.y + 0.6, pos.z);
        const dir = new THREE.Vector3(w.x, 0, -w.y).normalize();
        this.windArrow.setDirection(dir);
        this.windArrow.setLength(Math.min(2.0, 0.4 + wlen * 0.5), 0.3, 0.15);
      } else {
        this.windArrow.visible = false;
      }
    }

    setTargetMarker(pos3) { this._customTarget = pos3 ? new THREE.Vector3(pos3.x, pos3.y, pos3.z) : null; }

    _pushTrail(pos) {
      const i = this.trailIndex;
      this.trailPositions[i * 3] = pos.x;
      this.trailPositions[i * 3 + 1] = pos.y;
      this.trailPositions[i * 3 + 2] = pos.z;
      this.trailIndex = (i + 1) % this.trailMax;
      const filled = Math.min(this.trailIndex + (this._trailFilled ? this.trailMax : 0), this.trailMax);
      this._trailFilled = this._trailFilled || this.trailIndex === 0;
      // 简化: 顺序写入, 用 drawRange 控制可见长度
      const geom = this.trail.geometry;
      geom.attributes.position.needsUpdate = true;
      geom.setDrawRange(0, Math.min(this.trailIndex + (this._trailFilled ? this.trailMax : 0), this.trailMax));
      // 实际更好的做法是环形 buffer, 这里教学够用
    }

    clearTrail() {
      this.trailIndex = 0;
      this._trailFilled = false;
      this.trail.geometry.setDrawRange(0, 0);
    }

    // ---------------- 渲染循环 ----------------
    render(dt) {
      this.lastDt = dt;
      this.elapsed += dt;
      if (this.controls) this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }

    _onResize() {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    }

    // 相机跟随模式
    follow(targetPos3, distance) {
      if (!this.controls) return;
      this.controls.target.lerp(targetPos3, 0.1);
    }
  }

  global.AeroScene = AeroScene;
})(typeof window !== 'undefined' ? window : globalThis);
