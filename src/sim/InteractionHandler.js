/**
 * InteractionHandler.js — Mouse/touch drag-force interaction with the SPH fluid
 *
 * Orthographic raycasting
 * ───────────────────────
 * Unlike perspective cameras (rays diverge from one point), an orthographic
 * camera shoots PARALLEL rays — all with the same direction (the camera's look
 * vector, (0,−1,0) for top-down), but different origins determined by the
 * cursor's NDC position mapped through the frustum extents.
 *
 * THREE.Raycaster.setFromCamera(ndcMouse, orthoCamera) handles this correctly:
 *   origin    = point on camera near-plane at (ndcX, ndcY)
 *   direction = camera forward = (0, −1, 0)
 *
 * Then ray.intersectPlane(waterPlane, target) gives the world-space hit at Y=0.
 *
 * Force application
 * ─────────────────
 * Each frame when the mouse is held down:
 *   1. Compute drag velocity = (curWorldXZ − prevWorldXZ) / dt
 *   2. Query the SPH spatial hash at the cursor world position
 *   3. For each particle within forceRadius:
 *        falloff = (1 − dist²/R²)^falloffExp   (smooth, 1 at centre → 0 at edge)
 *        Δvel    = dragVelocity × strength × falloff × timeStep
 *   4. Clamp Δvel magnitude to prevent instability
 *
 * Visual cursor
 * ─────────────
 * A flat ring (RingGeometry rotated into the XZ plane) is placed at the cursor
 * world position and rendered last (depthTest=false) so it's always on top.
 * Ring radius = forceRadius so the affected area is visually indicated.
 * An inner fill disc appears while pressing to confirm drag mode.
 */

import * as THREE from 'three';

// ─── Tuning defaults ──────────────────────────────────────────────────────────

const MIN_DRAG_SPEED = 0.3;  // world units/s below which no force is applied
const MAX_DRAG_SPEED = 40;   // cap drag speed to prevent impulse spikes
const MAX_DVEL       = 6.0;  // max velocity delta per particle per frame (wu/s)
const FORCE_SCALE    = 0.012; // converts (drag_speed × strength × falloff) → Δvel

// ─── InteractionHandler ───────────────────────────────────────────────────────

export class InteractionHandler {
  /**
   * @param {THREE.WebGLRenderer}      renderer
   * @param {THREE.OrthographicCamera} camera   top-down scene camera
   */
  constructor(renderer, camera) {
    this._renderer = renderer;
    this._camera   = camera;

    // ── Mouse state ────────────────────────────────────────────────────────
    this._ndc      = new THREE.Vector2(0, 0);  // normalised device coordinates
    this._isDown   = false;
    this._isOver   = false;
    this._prevTime = performance.now();

    // ── World-space cursor positions ───────────────────────────────────────
    this._curWorld  = new THREE.Vector3();
    this._prevWorld = new THREE.Vector3();
    this._hasPrev   = false;   // skip delta on first frame after press

    // ── Raycasting ────────────────────────────────────────────────────────
    this._raycaster  = new THREE.Raycaster();
    this._waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // Y = 0

    // ── Interaction params (GUI-controlled) ───────────────────────────────
    this.forceRadius   = 6.0;
    this.forceStrength = 2.0;
    this.falloffExp    = 2;     // 2 = quadratic, 4 = quartic (sharper centre)
    this.enabled       = true;

    // (direct linear scan used — no hash buffer needed)

    // ── Cursor visual ─────────────────────────────────────────────────────
    this._cursorScene = new THREE.Scene();
    this._buildCursor();

    // ── Event listeners ───────────────────────────────────────────────────
    this._bind(renderer.domElement);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Update cursor world position, apply drag force, upload cursor mesh.
   * Call once per animation frame, BEFORE the render calls.
   *
   * @param {SPHSolver} solver
   * @param {number}    timestamp  performance.now() from requestAnimationFrame
   */
  update(solver, timestamp) {
    const dt = Math.min((timestamp - this._prevTime) * 0.001, 0.05); // s, capped
    this._prevTime = timestamp;

    // ── Resolve cursor world XZ via ortho raycast ──────────────────────────
    if (!this._isOver) {
      this._ringMesh.visible = false;
      this._fillMesh.visible = false;
      this._hasPrev = false;
      return;
    }

    this._raycaster.setFromCamera(this._ndc, this._camera);
    const hit = this._raycaster.ray.intersectPlane(this._waterPlane, this._curWorld);
    if (!hit) {
      this._ringMesh.visible = false;
      this._fillMesh.visible = false;
      this._hasPrev = false;
      return;
    }

    // ── Update cursor visual ───────────────────────────────────────────────
    const cursorY = 0.4;   // sit just above water plane
    this._ringMesh.position.set(this._curWorld.x, cursorY, this._curWorld.z);
    this._fillMesh.position.set(this._curWorld.x, cursorY, this._curWorld.z);

    // Scale ring to match forceRadius so it shows affected area
    this._ringMesh.scale.setScalar(this.forceRadius);
    this._fillMesh.scale.setScalar(this.forceRadius);

    this._ringMesh.visible = true;
    this._fillMesh.visible = this._isDown;

    // Brighter ring while dragging
    this._ringMat.opacity = this._isDown ? 0.85 : 0.45;

    // ── Apply force on drag ────────────────────────────────────────────────
    if (this._isDown && this._hasPrev && this.enabled && dt > 0) {
      const rawDX  = (this._curWorld.x - this._prevWorld.x) / dt;
      const rawDZ  = (this._curWorld.z - this._prevWorld.z) / dt;
      const rawSpd = Math.sqrt(rawDX * rawDX + rawDZ * rawDZ);

      if (rawSpd > MIN_DRAG_SPEED) {
        // Cap speed to prevent impulse spikes from fast jerks
        const capSpd = Math.min(rawSpd, MAX_DRAG_SPEED);
        const scale  = capSpd / rawSpd;
        this._applyForce(solver, rawDX * scale, rawDZ * scale);
      }
    }

    // ── Store previous position ────────────────────────────────────────────
    this._prevWorld.copy(this._curWorld);
    this._hasPrev = true;
  }

  /**
   * Render the cursor ring on top of everything.
   * Call LAST in the render sequence (after water composite + any overlays).
   * Uses depthTest=false so it's always visible above water and terrain.
   */
  renderCursor(camera) {
    if (!this._isOver) return;
    this._renderer.render(this._cursorScene, camera);
  }

  dispose() {
    const el = this._renderer.domElement;
    el.removeEventListener('mousemove',  this._onMouseMove);
    el.removeEventListener('mousedown',  this._onMouseDown);
    el.removeEventListener('mouseup',    this._onMouseUp);
    el.removeEventListener('mouseleave', this._onMouseLeave);
    el.removeEventListener('touchstart', this._onTouchStart);
    el.removeEventListener('touchmove',  this._onTouchMove);
    el.removeEventListener('touchend',   this._onTouchEnd);
    this._ringGeo.dispose();
    this._fillGeo.dispose();
    this._ringMat.dispose();
    this._fillMat.dispose();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _applyForce(solver, dragVX, dragVZ) {
    const pos = solver.positions;
    const vel = solver.velocities;
    const N   = solver.cfg.numParticles;
    const R   = this.forceRadius;
    const R2  = R * R;
    const str = this.forceStrength;
    const exp = this.falloffExp;
    const cx  = this._curWorld.x;
    const cz  = this._curWorld.z;

    // Linear scan over all particles. The SPH hash covers only ±h = ±1.5 wu
    // per cell ring, so querying it would miss particles when forceRadius (6 wu)
    // is larger than the hash neighborhood. O(N) once per frame is fine.
    for (let pid = 0; pid < N; pid++) {
      const dx = pos[pid * 3    ] - cx;
      const dz = pos[pid * 3 + 2] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R2) continue;

      // Smooth falloff: 1 at centre, 0 at edge
      const t       = 1 - d2 / R2;
      const falloff = exp === 2 ? t * t : t * t * t * t;

      let dvX = dragVX * str * falloff * FORCE_SCALE;
      let dvZ = dragVZ * str * falloff * FORCE_SCALE;

      // Clamp per-particle delta
      const dvMag = Math.sqrt(dvX * dvX + dvZ * dvZ);
      if (dvMag > MAX_DVEL) {
        const sc = MAX_DVEL / dvMag;
        dvX *= sc;
        dvZ *= sc;
      }

      vel[pid * 3    ] += dvX;
      vel[pid * 3 + 2] += dvZ;
    }
  }

  _buildCursor() {
    // ── Outer ring — shows force radius ───────────────────────────────────
    // Base geometry at radius 1; scaled by forceRadius each frame.
    // Rotated -90° around X so it lies flat in the XZ plane (top-down visible).
    this._ringGeo = new THREE.RingGeometry(0.82, 1.0, 64);
    this._ringGeo.rotateX(-Math.PI / 2);
    this._ringMat = new THREE.MeshBasicMaterial({
      color:       0x8AE7D4,   // Seychelles Blue — matches palette
      transparent: true,
      opacity:     0.45,
      side:        THREE.DoubleSide,
      depthTest:   false,
      depthWrite:  false,
    });
    this._ringMesh = new THREE.Mesh(this._ringGeo, this._ringMat);
    this._ringMesh.visible = false;
    this._cursorScene.add(this._ringMesh);

    // ── Inner fill disc — visible while pressing ───────────────────────────
    this._fillGeo = new THREE.CircleGeometry(0.82, 64);
    this._fillGeo.rotateX(-Math.PI / 2);
    this._fillMat = new THREE.MeshBasicMaterial({
      color:       0x00C0D1,   // Sea Serpent — slightly different tone
      transparent: true,
      opacity:     0.18,
      side:        THREE.DoubleSide,
      depthTest:   false,
      depthWrite:  false,
    });
    this._fillMesh = new THREE.Mesh(this._fillGeo, this._fillMat);
    this._fillMesh.visible = false;
    this._cursorScene.add(this._fillMesh);
  }

  _setNDC(clientX, clientY) {
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._ndc.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    this._ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
  }

  _bind(el) {
    this._onMouseMove  = e => { this._setNDC(e.clientX, e.clientY); this._isOver = true; };
    this._onMouseDown  = () => { this._isDown = true; this._hasPrev = false; };
    this._onMouseUp    = () => { this._isDown = false; };
    this._onMouseLeave = () => { this._isOver = false; this._isDown = false; };

    this._onTouchStart = e => {
      e.preventDefault();
      this._isDown = true; this._hasPrev = false; this._isOver = true;
      this._setNDC(e.touches[0].clientX, e.touches[0].clientY);
    };
    this._onTouchMove = e => {
      e.preventDefault();
      this._isOver = true;
      this._setNDC(e.touches[0].clientX, e.touches[0].clientY);
    };
    this._onTouchEnd = () => { this._isDown = false; this._isOver = false; };

    el.addEventListener('mousemove',  this._onMouseMove);
    el.addEventListener('mousedown',  this._onMouseDown);
    el.addEventListener('mouseup',    this._onMouseUp);
    el.addEventListener('mouseleave', this._onMouseLeave);
    el.addEventListener('touchstart', this._onTouchStart, { passive: false });
    el.addEventListener('touchmove',  this._onTouchMove,  { passive: false });
    el.addEventListener('touchend',   this._onTouchEnd);
  }
}
