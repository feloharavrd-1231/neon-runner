import * as THREE from '/vendor/three.module.js';

const LANES = [-2.7, 0, 2.7];
const SPAWN_Z = -120, DESPAWN_Z = 14;
const BASE_SPEED = 20, MAX_SPEED = 40, SPEED_RAMP = 0.5;
const GRAVITY = -34, JUMP_V = 12.5, PLAYER_Y = 0.72, FEET_OFF = 0.67;
const FOG = 0x070a1e, TILE = 5;
const INVULN_MS = 2200;

export class NeonRunner {
  constructor(canvas, hooks = {}) {
    this.hooks = hooks;
    this.state = 'idle';            // idle | playing | dead | paused
    this.gems = 0; this.score = 0; this.distance = 0;
    this.elapsed = 0; this.speed = BASE_SPEED; this.playMs = 0;
    this.lane = 1; this.playerX = 0; this.jumpY = 0; this.vy = 0;
    this.grounded = true; this.airJumps = 1;
    this.nextRow = 0; this.nextExtra = 0;
    this.camShake = 0; this.runPhase = 0; this.invulnUntil = 0;
    this.soundOn = true; this.active = [];

    this._initGL(canvas);
    this._initWorld();
    this._initPlayer();
    this._initPools();
    this._initInput();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ═════ GL ═════ */
  _initGL(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOG);
    this.scene.fog = new THREE.Fog(FOG, 55, 135);

    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 300);
    this.camera.position.set(0, 5, 9.5);
    this.camLook = new THREE.Vector3();
  }

  _initWorld() {
    this.scene.add(new THREE.HemisphereLight(0x9ecbff, 0x1a1440, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2d0, 2.4);
    sun.position.set(14, 26, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 28, bottom: -28, near: 1, far: 120 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);
    sun.target.position.set(0, 0, -22);

    /* الأرضية */
    const tex = this._gridTexture();
    tex.repeat.set(44 / TILE, 300 / TILE);
    this.groundTex = tex;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 300),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.12 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -110);
    ground.receiveShadow = true;
    this.scene.add(ground);

    /* الأعمدة */
    this.pillarBody = new THREE.MeshStandardMaterial({ color: 0x161d47, roughness: 0.55, metalness: 0.6, emissive: 0x120a35, emissiveIntensity: 0.9 });
    this.pillarCyan = new THREE.MeshBasicMaterial({ color: 0x53e8ff });
    this.pillarViolet = new THREE.MeshBasicMaterial({ color: 0xb45cff });
    this.pillarGeo = new THREE.BoxGeometry(1, 1, 1);

    this.PILLAR_PAIRS = 13; this.PILLAR_GAP = 14;
    this.pillars = [];
    for (let i = 0; i < this.PILLAR_PAIRS; i++) {
      for (const side of [-1, 1]) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(this.pillarGeo, this.pillarBody);
        const cap = new THREE.Mesh(this.pillarGeo, this.pillarCyan);
        g.add(body, cap);
        g.style = (h) => { body.scale.set(1.2, h, 1.2); body.position.y = h / 2; cap.scale.set(1.45, .14, 1.45); cap.position.y = h; };
        g.cap = cap; g.side = side;
        g.position.set(side * (8.5 + Math.random() * 2.5), 0, DESPAWN_Z - i * this.PILLAR_GAP);
        g.style(4 + Math.random() * 9);
        this.scene.add(g); this.pillars.push(g);
      }
    }

    /* الجسيمات */
    this.PART_MAX = 240;
    this.partMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.09, 6, 5),
      new THREE.MeshBasicMaterial({ toneMapped: false }), this.PART_MAX
    );
    this.partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.partMesh.frustumCulled = false;
    this.scene.add(this.partMesh);
    this.parts = Array.from({ length: this.PART_MAX }, () => ({
      life: 0, maxLife: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), scale: 1
    }));
    this.dummy = new THREE.Object3D();
    this.tmpColor = new THREE.Color();
    this.partCursor = 0;
  }

  _gridTexture() {
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#0d1130'; g.fillRect(0, 0, S, S);
    g.strokeStyle = '#25317a'; g.lineWidth = 5; g.strokeRect(2, 2, S - 4, S - 4);
    g.strokeStyle = '#182058'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.stroke();
    g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return t;
  }

  /* ═════ اللاعب ═════ */
  _initPlayer() {
    this.player = new THREE.Group();
    const matBody = new THREE.MeshStandardMaterial({ color: 0x2ee6c5, emissive: 0x0d8f7a, emissiveIntensity: .65, roughness: .3, metalness: .5 });
    const matGlow = new THREE.MeshBasicMaterial({ color: 0xfff2a0 });
    const matCore = new THREE.MeshStandardMaterial({ color: 0xff5a9e, emissive: 0xff2d63, emissiveIntensity: 1.8, roughness: .25, metalness: .4 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.5, 8, 20), matBody);
    torso.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 16), matBody);
    head.position.y = 0.85; head.castShadow = true;
    const eyeGeo = new THREE.SphereGeometry(0.07, 10, 8);
    const eL = new THREE.Mesh(eyeGeo, matGlow); eL.position.set(-0.13, 0.88, -0.29);
    const eR = new THREE.Mesh(eyeGeo, matGlow); eR.position.set(0.13, 0.88, -0.29);
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12), matCore);
    this.core.position.set(0, 0.12, 0.34);

    this.playerLight = new THREE.PointLight(0x4df3d0, 6, 9, 2);
    this.playerLight.position.set(0, 0.6, 0);

    /* هالة الحماية */
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0x4df3d0, transparent: true, opacity: .2, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.shield.visible = false;

    this.player.add(torso, head, eL, eR, this.core, this.playerLight, this.shield);
    this.player.position.set(0, PLAYER_Y, 0);
    this.scene.add(this.player);
  }

  /* ═════ بركات ═════ */
  _initPools() {
    const GEO = {
      tall: new THREE.BoxGeometry(2.0, 2.2, 1.1),
      low: new THREE.BoxGeometry(2.2, 0.7, 0.8),
      gem: new THREE.OctahedronGeometry(0.38),
      halo: new THREE.SphereGeometry(0.85, 12, 10)
    };
    GEO.tall.translate(0, 1.1, 0);
    GEO.low.translate(0, 0.35, 0);

    this.MAT = {
      tall: new THREE.MeshStandardMaterial({ color: 0xff2d63, emissive: 0x8f0026, emissiveIntensity: 1.5, roughness: .35, metalness: .35 }),
      low: new THREE.MeshStandardMaterial({ color: 0xff9a1f, emissive: 0x8a4400, emissiveIntensity: 1.5, roughness: .4, metalness: .3 }),
      gem: new THREE.MeshStandardMaterial({ color: 0xffd84a, emissive: 0xffa000, emissiveIntensity: 1.4, metalness: .85, roughness: .15 }),
      halo: new THREE.MeshBasicMaterial({ color: 0xffc233, transparent: true, opacity: .16, blending: THREE.AdditiveBlending, depthWrite: false })
    };

    this.free = { tall: [], low: [], gem: [] };
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(GEO.tall, this.MAT.tall);
      m.castShadow = m.receiveShadow = true; m.visible = false;
      this.scene.add(m); this.free.tall.push(m);
    }
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(GEO.low, this.MAT.low);
      m.castShadow = m.receiveShadow = true; m.visible = false;
      this.scene.add(m); this.free.low.push(m);
    }
    for (let i = 0; i < 45; i++) {
      const g = new THREE.Group();
      const c = new THREE.Mesh(GEO.gem, this.MAT.gem); c.castShadow = true;
      g.add(c, new THREE.Mesh(GEO.halo, this.MAT.halo));
      g.visible = false; this.scene.add(g);
      this.free.gem.push({ obj: g, core: c });
    }
  }

  /* ═════ المدخلات ═════ */
  _initInput() {
    this._onKey = (e) => {
      if (e.repeat) return;
      if (this.state !== 'playing') return;
      switch (e.code) {
        case 'ArrowLeft': case 'KeyA': this.moveLane(-1); break;
        case 'ArrowRight': case 'KeyD': this.moveLane(1); break;
        case 'Space': case 'ArrowUp': case 'KeyW': case 'KeyZ': e.preventDefault(); this.jump(); break;
      }
    };
    this._onTS = (e) => { const t = e.changedTouches[0]; this._tx = t.clientX; this._ty = t.clientY; };
    this._onTE = (e) => {
      if (this.state !== 'playing') return;
      const t = e.changedTouches[0]; if (!t) return;
      const dx = t.clientX - this._tx, dy = t.clientY - this._ty;
      if (Math.hypot(dx, dy) < 30) { this.jump(); return; }
      if (Math.abs(dx) > Math.abs(dy)) this.moveLane(dx > 0 ? 1 : -1);
      else if (dy < 0) this.jump();
    };
    addEventListener('keydown', this._onKey, { passive: false });
    addEventListener('touchstart', this._onTS, { passive: true });
    addEventListener('touchend', this._onTE, { passive: true });
    this._onResize = () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    };
    addEventListener('resize', this._onResize);
  }

  /* ═════ صوت ═════ */
  _audio() {
    if (!this.actx) { try { this.actx = new (AudioContext || webkitAudioContext)(); } catch { } }
    if (this.actx?.state === 'suspended') this.actx.resume();
    return this.actx;
  }
  blip(freq, dur = .09, type = 'triangle', vol = .05) {
    if (!this.soundOn) return;
    const a = this._audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(freq * 1.35, a.currentTime + dur);
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(a.destination);
    o.start(); o.stop(a.currentTime + dur);
  }

  /* ═════ تحكم ═════ */
  moveLane(dir) {
    if (this.state !== 'playing') return;
    const n = Math.min(2, Math.max(0, this.lane + dir));
    if (n !== this.lane) { this.lane = n; this.blip(520, .06, 'sine', .035); }
  }
  jump() {
    if (this.state !== 'playing') return;
    if (this.grounded) { this.vy = JUMP_V; this.grounded = false; this.blip(660, .1); }
    else if (this.airJumps > 0) {
      this.vy = JUMP_V * .88; this.airJumps--;
      this.blip(880, .1);
      this._burst(this.player.position.clone().setY(this.player.position.y + .1), 0x4df3d0, 8, 4);
    }
  }
  setSound(on) { this.soundOn = on; }

  /* ═════ دورة الحياة ═════ */
  start() {
    this._audio();
    this._clearActive();
    this.parts.forEach(p => p.life = 0);
    Object.assign(this, {
      distance: 0, elapsed: 0, speed: BASE_SPEED, playMs: 0,
      gems: 0, score: 0, lane: 1, playerX: 0, jumpY: 0, vy: 0, grounded: true,
      airJumps: 1, nextRow: 0, nextExtra: 0, camShake: 0, runPhase: 0,
      invulnUntil: 0, lastSpawnAt: 0
    });
    this.pillars.forEach((p, i) => {
      p.position.z = DESPAWN_Z - Math.floor(i / 2) * this.PILLAR_GAP;
      p.position.x = p.side * (8.5 + Math.random() * 2.5);
      p.style(4 + Math.random() * 9);
    });
    this.camera.position.set(0, 5, 9.5);
    this.player.position.set(0, PLAYER_Y, 0);
    this.state = 'playing';
    this.blip(440, .14, 'sine');
    this.hooks.onStart?.();
  }

  /** يُستدعى بعد نجاح التحقق من الإعلان */
  revive() {
    if (this.state !== 'dead') return false;
    // نظّف كل العوائق القريبة حتى لا يصطدم فوراً
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      if (a.obj.position.z > -30) { this._recycle(a); this.active.splice(i, 1); }
    }
    this.nextRow = Math.max(this.nextRow, this.distance + 24);
    this.lane = 1; this.playerX = LANES[1];
    this.jumpY = 0; this.vy = 0; this.grounded = true; this.airJumps = 1;
    this.speed = Math.min(this.speed, BASE_SPEED * 0.85);
    this.invulnUntil = performance.now() + INVULN_MS;
    this.shield.visible = true;
    this.state = 'playing';
    this._burst(this.player.position.clone(), 0x4df3d0, 26, 10);
    this.blip(700, .18, 'sine', .06);
    return true;
  }

  pause() { if (this.state === 'playing') { this._prev = this.state; this.state = 'paused'; } }
  resume() { if (this.state === 'paused') this.state = this._prev || 'playing'; }
  get isPlaying() { return this.state === 'playing'; }
  get isDead() { return this.state === 'dead'; }

  /* ═════ توليد ═════ */
  _spawn(kind, lane, y) {
    if (kind === 'gem') {
      const g = this.free.gem.pop(); if (!g) return;
      g.obj.visible = true;
      g.obj.position.set(LANES[lane], y, SPAWN_Z);
      this.active.push({ kind: 'gem', obj: g.obj, core: g.core, baseY: y });
    } else {
      const m = this.free[kind].pop(); if (!m) return;
      m.visible = true; m.position.set(LANES[lane], 0, SPAWN_Z);
      this.active.push({ kind, obj: m });
    }
  }

  _recycle(a) {
    a.obj.visible = false;
    if (a.kind === 'tall') this.free.tall.push(a.obj);
    else if (a.kind === 'low') this.free.low.push(a.obj);
    else this.free.gem.push({ obj: a.obj, core: a.core });
  }

  _clearActive() { this.active.forEach(a => this._recycle(a)); this.active.length = 0; }

  _spawnRow() {
    const r = Math.random();
    this.nextExtra = 0;
    if (r < 0.24) {                       // حاجز منخفض في كل المسارات
      for (let l = 0; l < 3; l++) this._spawn('low', l);
      this._spawn('gem', 1, 2.6);
      if (Math.random() < .55) { this._spawn('gem', 0, 2.6); this._spawn('gem', 2, 2.6); }
      this.nextExtra = 9;
    } else if (r < 0.58) {                // كتلة عالية واحدة
      const b = (Math.random() * 3) | 0;
      this._spawn('tall', b);
      for (let l = 0; l < 3; l++) if (l !== b && Math.random() < .65) this._spawn('gem', l, 1.5);
    } else if (r < 0.82) {                // كتلتان + مسار مفتوح
      const f = (Math.random() * 3) | 0;
      for (let l = 0; l < 3; l++) if (l !== f) this._spawn('tall', l);
      this._spawn('gem', f, 1.5);
      this.nextExtra = 4;
    } else {                              // صف جواهر
      for (let l = 0; l < 3; l++) this._spawn('gem', l, 1.5);
    }
  }

  _spawnGap() {
    // فجوة تتوسّع مع السرعة حتى تبقى اللعبة عادلة
    const base = 11 + Math.random() * 7;
    return base * (0.6 + 0.4 * (this.speed / BASE_SPEED)) + this.nextExtra;
  }

  /* ═════ جسيمات ═════ */
  _burst(pos, color, count, power) {
    for (let i = 0; i < count; i++) {
      const idx = this.partCursor, p = this.parts[idx];
      p.maxLife = p.life = .5 + Math.random() * .4;
      p.pos.copy(pos);
      p.vel.set((Math.random() - .5) * power, Math.random() * power * 1.1, (Math.random() - .5) * power);
      p.scale = .6 + Math.random();
      this.partMesh.setColorAt(idx, this.tmpColor.set(color));
      this.partCursor = (idx + 1) % this.PART_MAX;
    }
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;
  }

  _updateParticles(dt, scroll) {
    for (let i = 0; i < this.PART_MAX; i++) {
      const p = this.parts[i];
      if (p.life > 0) {
        p.life -= dt;
        p.vel.y += GRAVITY * .55 * dt;
        p.pos.addScaledVector(p.vel, dt);
        p.pos.z += scroll;
        const k = Math.max(p.life / p.maxLife, 0);
        this.dummy.position.copy(p.pos);
        this.dummy.scale.setScalar(p.scale * k);
      } else {
        this.dummy.position.set(0, -999, 0);
        this.dummy.scale.setScalar(.0001);
      }
      this.dummy.updateMatrix();
      this.partMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.partMesh.instanceMatrix.needsUpdate = true;
  }

  /* ═════ التحديث ═════ */
  _update(dt, nowMs) {
    this.elapsed += dt; this.playMs += dt * 1000;
    this.speed = Math.min(MAX_SPEED, BASE_SPEED + this.elapsed * SPEED_RAMP);
    const move = this.speed * dt;
    this.distance += move;

    this.groundTex.offset.y -= move / TILE;

    for (const p of this.pillars) {
      p.position.z += move;
      if (p.position.z > DESPAWN_Z) {
        p.position.z -= this.PILLAR_PAIRS * this.PILLAR_GAP;
        p.position.x = p.side * (8.5 + Math.random() * 2.5);
        p.style(4 + Math.random() * 9);
        p.cap.material = Math.random() < .5 ? this.pillarCyan : this.pillarViolet;
      }
    }

    /* حركة أفقية ناعمة */
    const tx = LANES[this.lane];
    this.playerX += (tx - this.playerX) * Math.min(1, dt * 13);
    if (Math.abs(tx - this.playerX) < .005) this.playerX = tx;

    /* فيزياء رأسية */
    this.vy += GRAVITY * dt;
    this.jumpY += this.vy * dt;
    if (this.jumpY <= 0) { this.jumpY = 0; this.vy = 0; this.grounded = true; this.airJumps = 1; }

    /* الشكل */
    this.runPhase += dt * 16;
    const bob = this.grounded ? Math.sin(this.runPhase) * .055 : 0;
    this.player.position.set(this.playerX, PLAYER_Y + this.jumpY + bob, 0);
    this.player.rotation.z = -(tx - this.playerX) * .22;
    this.player.rotation.x = -.06 + Math.min(this.vy * .012, .22);
    this.player.rotation.y = (tx - this.playerX) * .12;
    this.core.scale.setScalar(1 + Math.sin(this.elapsed * 9) * .12);
    this.playerLight.intensity = 5 + Math.sin(this.elapsed * 9) * 1.6;

    /* هالة الحماية */
    const inv = nowMs < this.invulnUntil;
    this.shield.visible = inv;
    if (inv) {
      this.shield.material.opacity = .12 + Math.abs(Math.sin(nowMs * .008)) * .18;
      this.shield.rotation.y += dt * 2;
    }

    /* العوائق */
    const feetY = PLAYER_Y + this.jumpY - FEET_OFF;
    const centerY = PLAYER_Y + this.jumpY + .35;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.obj.position.z += move;

      if (a.kind === 'gem') {
        a.core.rotation.y += dt * 3;
        a.core.rotation.x += dt * 1.3;
        a.obj.position.y = a.baseY + Math.sin(this.elapsed * 3 + a.obj.position.x) * .13;
      }

      if (a.obj.position.z > DESPAWN_Z) { this._recycle(a); this.active.splice(i, 1); continue; }

      const dx = Math.abs(a.obj.position.x - this.playerX);
      const dz = Math.abs(a.obj.position.z);

      if (a.kind === 'gem') {
        const dy = Math.abs(a.obj.position.y - centerY);
        if (dx < 1.15 && dz < 1.3 && dy < 1.15) {
          this._burst(a.obj.position.clone(), 0xffd84a, 9, 5.5);
          this._burst(a.obj.position.clone(), 0xffffff, 4, 3);
          this._recycle(a); this.active.splice(i, 1);
          this.gems++; this.score += 10;
          this.blip(1040 + Math.random() * 260, .08, 'sine', .045);
        }
      } else if (!inv) {
        if (dx < 1.45 && dz < 1.15) {
          const top = a.kind === 'tall' ? 2.2 : 0.7;
          if (feetY < top) { this._die(); return; }
        }
      }
    }

    while (this.distance >= this.nextRow) {
      this._spawnRow();
      this.nextRow += this._spawnGap();
    }

    this.score = Math.floor(this.distance) + this.gems * 10;
  }

  _die() {
    this.state = 'dead';
    this.camShake = 1.1;
    const p = this.player.position.clone().setY(this.player.position.y + .4);
    this._burst(p, 0xff2d63, 34, 13);
    this._burst(p, 0xffb03a, 22, 9);
    this.blip(160, .42, 'sawtooth', .09);
    this.hooks.onGameOver?.({
      score: this.score, gems: this.gems,
      distance: Math.floor(this.distance), durationMs: Math.round(this.playMs)
    });
  }

  /* ═════ كاميرا ═════ */
  _updateCamera(dt) {
    const playing = this.state === 'playing' || this.state === 'dead';
    const px = playing ? this.playerX : 0;
    const jy = playing ? this.jumpY : 0;

    this.camera.position.x += (px * .55 - this.camera.position.x) * Math.min(1, dt * 4);
    const targetY = 5 + jy * .45 + (this.state === 'dead' ? .8 : 0);
    this.camera.position.y += (targetY - this.camera.position.y) * Math.min(1, dt * 4);
    this.camera.position.z = 9.5;

    if (this.camShake > 0) {
      this.camShake = Math.max(0, this.camShake - dt * 2);
      this.camera.position.x += (Math.random() - .5) * this.camShake * .9;
      this.camera.position.y += (Math.random() - .5) * this.camShake * .9;
    }
    this.camLook.set(px * .35, 1.6 + jy * .5, -10);
    this.camera.lookAt(this.camLook);
  }

  /* ═════ الحلقة ═════ */
  _loop(now) {
    requestAnimationFrame(this._loop);
    let dt = (now - (this._last || now)) / 1000;
    this._last = now;
    dt = Math.min(dt, 1 / 30);

    if (this.state === 'playing') this._update(dt, now);
    this._updateParticles(dt, this.state === 'playing' ? this.speed * dt : 0);
    this._updateCamera(dt);

    if (this.state === 'playing' || this.state === 'dead') {
      this.hooks.onHud?.({
        score: this.score, gems: this.gems,
        speedPct: (this.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED) * 100
      });
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    removeEventListener('keydown', this._onKey);
    removeEventListener('touchstart', this._onTS);
    removeEventListener('touchend', this._onTE);
    removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
