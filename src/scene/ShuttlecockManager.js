/**
 * ShuttlecockManager.js — Waterline-tracking shuttlecock debris
 *
 * Behaviour
 * ─────────
 * Each shuttlecock owns a fixed Z "lane" along the coastline.  Every frame it
 * scans the 128×80 density readback buffer to find the rightmost water pixel
 * in its lane — that column is the local waterline X.  The shuttlecock lerps
 * its X toward that target, producing the visual of debris riding the tide edge.
 *
 * Y is always terrain height + a small float offset — no free-fall, no buoyancy
 * spring.  Rotation is driven by the frame-to-frame X displacement, so fast
 * incoming waves produce vigorous tumbling and calm periods produce gentle drift.
 *
 * Density buffer convention (128 × 80 Uint8Array, RGBA stride 4)
 * ──────────────────────────────────────────────────────────────
 *   col 0   → worldX = xMin (ocean left)
 *   col 127 → worldX = xMax (beach right)
 *   GL row 0 = bottom of RT = worldZ = zMax  (far side)
 *   GL row 79 = top of RT   = worldZ = zMin  (near side)
 *
 * So for a shuttlecock at worldZ:
 *   pixRow = round((zMax − worldZ) / (zMax − zMin) × (H−1))
 * Scan from col 127 → 0; first col with R > DENSITY_THRESHOLD = waterline.
 */

import * as THREE from 'three';
import { GLTFLoader }      from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ─── Buffer dimensions — must match TerrainBuilder WET_GRID_W / WET_GRID_H ───
const WET_W = 128;
const WET_H = 80;

// ─── Tuning constants ─────────────────────────────────────────────────────────
export const MAX_COUNT     = 100;
export const DEFAULT_COUNT =  50;

const TARGET_SIZE        = 2.0;   // world units — GLB auto-scale target
const DENSITY_THRESHOLD  = 90;    // 0-255; R value above this = water pixel
const Y_OFFSET           = 0.25;  // how high above terrain surface to float
const DEFAULT_LERP       = 0.20;  // default X-tracking lerp factor per frame
const Z_VARIATION        = 1.2;   // max random Z jitter from assigned lane (wu)

// ── Tumble constants ──────────────────────────────────────────────────────────
const ANG_DAMP       = 0.88;   // angular velocity decay per frame
const ANG_VEL_SCALE  = 3.5;    // rad/s per world-unit/frame of X movement
const ANG_RAND       = 0.03;   // random angular noise per frame (rad/s)
const ANG_MAX        = 8.0;    // clamp (rad/s)

// ─── ShuttlecockManager ───────────────────────────────────────────────────────

export class ShuttlecockManager {
  /**
   * @param {THREE.Scene} shuttlecockScene  Rendered AFTER water composite.
   */
  constructor(shuttlecockScene) {
    this._scene     = shuttlecockScene;
    this.mesh       = null;
    this._geo       = null;
    this._mat       = null;
    this.loaded     = false;

    this.count      = DEFAULT_COUNT;
    this.scale      = 1.0;
    this._autoScale = 1.0;

    // Per-instance state
    this._fixedZ   = new Float32Array(MAX_COUNT); // assigned Z lane
    this._posX     = new Float32Array(MAX_COUNT); // current X (lerped)
    this._posY     = new Float32Array(MAX_COUNT); // terrain Y + offset
    this._posZ     = new Float32Array(MAX_COUNT); // fixedZ + small jitter
    this._prevX    = new Float32Array(MAX_COUNT); // X last frame (velocity)
    this._rotX     = new Float32Array(MAX_COUNT);
    this._rotY     = new Float32Array(MAX_COUNT);
    this._rotZ     = new Float32Array(MAX_COUNT);
    this._angVX    = new Float32Array(MAX_COUNT);
    this._angVY    = new Float32Array(MAX_COUNT);
    this._angVZ    = new Float32Array(MAX_COUNT);
    this._scaleVar = new Float32Array(MAX_COUNT);

    this._dummy = new THREE.Object3D();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async load() {
    const loader = new GLTFLoader();
    const gltf   = await new Promise((resolve, reject) =>
      loader.load('/models/shuttlecock.glb', resolve, undefined, reject),
    );

    const meshes = [];
    gltf.scene.traverse(c => { if (c.isMesh) meshes.push(c); });
    if (!meshes.length) throw new Error('ShuttlecockManager: no meshes in GLB');

    let geometry;
    if (meshes.length === 1) {
      geometry = meshes[0].geometry.clone();
      meshes[0].updateWorldMatrix(true, false);
      geometry.applyMatrix4(meshes[0].matrixWorld);
    } else {
      const geos = meshes.map(m => {
        const g = m.geometry.clone();
        m.updateWorldMatrix(true, false);
        g.applyMatrix4(m.matrixWorld);
        return g;
      });
      geometry = mergeGeometries(geos, false);
      geos.forEach(g => g.dispose());
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    // Auto-scale: bake longest axis → TARGET_SIZE world units
    geometry.computeBoundingBox();
    const sz = new THREE.Vector3();
    geometry.boundingBox.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    this._autoScale = maxDim > 0.0001 ? TARGET_SIZE / maxDim : 1.0;
    console.log(
      `[ShuttlecockManager] bbox ${sz.x.toFixed(3)}×${sz.y.toFixed(3)}×${sz.z.toFixed(3)}` +
      `  autoScale ×${this._autoScale.toFixed(3)}`,
    );

    const srcMat  = meshes[0].material;
    this._mat = srcMat
      ? srcMat.clone()
      : new THREE.MeshStandardMaterial({ color: 0xf0e8c0, roughness: 0.6, metalness: 0.1 });
    this._geo = geometry;

    this.mesh               = new THREE.InstancedMesh(geometry, this._mat, MAX_COUNT);
    this.mesh.count         = this.count;
    this.mesh.castShadow    = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible       = false;
    this._scene.add(this.mesh);

    this.loaded = true;
    return this;
  }

  /**
   * Distribute shuttlecocks along the Z axis and place each one at its local
   * static waterline (terrain height = 0 crossing at that Z).
   */
  spawn(count, boundsMin, boundsMax, terrainFn) {
    if (!this.loaded) return;
    this.count      = Math.min(count, MAX_COUNT);
    this.mesh.count = this.count;

    const xMin = boundsMin[0], xMax = boundsMax[0];
    const zMin = boundsMin[2], zMax = boundsMax[2];
    const zRange = zMax - zMin;

    for (let i = 0; i < this.count; i++) {
      // Evenly distributed Z lane with small random jitter
      const t      = this.count > 1 ? i / (this.count - 1) : 0.5;
      const baseZ  = zMin + 2 + t * (zRange - 4);   // 2-unit margin each end
      const jitter = (Math.random() - 0.5) * 2 * Z_VARIATION;
      const fixedZ = Math.max(zMin + 1, Math.min(zMax - 1, baseZ + jitter));

      // Find static waterline X (terrain Y ≈ 0) via binary search
      const startX = this._findTerrainWaterlineX(fixedZ, xMin, xMax, terrainFn);

      this._fixedZ[i]   = fixedZ;
      this._posX[i]     = startX;
      this._prevX[i]    = startX;
      this._posZ[i]     = fixedZ;
      this._posY[i]     = terrainFn(startX, fixedZ) + Y_OFFSET;
      this._rotX[i]     = Math.random() * Math.PI * 2;
      this._rotY[i]     = Math.random() * Math.PI * 2;
      this._rotZ[i]     = Math.random() * Math.PI * 2;
      // Seed with a small random spin so instances look varied at start
      this._angVX[i]    = (Math.random() - 0.5) * 1.0;
      this._angVY[i]    = (Math.random() - 0.5) * 0.5;
      this._angVZ[i]    = (Math.random() - 0.5) * 1.0;
      this._scaleVar[i] = 0.88 + Math.random() * 0.24;

      this._writeMatrix(i);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = true;
  }

  /**
   * Track the dynamic waterline each frame using the density readback buffer.
   *
   * @param {Uint8Array} densityPixels  128×80×4 RGBA from readWetnessPixels()
   * @param {number[]}   boundsMin      [xMin, yMin, zMin]
   * @param {number[]}   boundsMax      [xMax, yMax, zMax]
   * @param {Function}   terrainFn      (x,z) → terrainY
   * @param {number}     tumbleIntensity  GUI multiplier (default 1)
   * @param {number}     trackingLerp    X lerp factor per frame (default 0.20)
   */
  update(densityPixels, boundsMin, boundsMax, terrainFn,
         tumbleIntensity = 1.0, trackingLerp = DEFAULT_LERP) {
    if (!this.loaded || !this.mesh.visible) return;

    const xMin = boundsMin[0], xMax = boundsMax[0];
    const zMin = boundsMin[2], zMax = boundsMax[2];
    const xRange = xMax - xMin;
    const zRange = zMax - zMin;

    for (let i = 0; i < this.count; i++) {
      // ── Find waterline X from density buffer ────────────────────────────
      // Map this shuttlecock's Z to the nearest pixel row.
      // GL row 0 = zMax (bottom of screen), row H-1 = zMin (top).
      const wz     = this._fixedZ[i];
      const pixRow = Math.round(((zMax - wz) / zRange) * (WET_H - 1));
      const row    = Math.max(0, Math.min(WET_H - 1, pixRow));

      // Scan from right (beach) to left (ocean) for first water pixel
      let waterlineX = null;
      for (let col = WET_W - 1; col >= 0; col--) {
        const base = (row * WET_W + col) * 4;
        if (densityPixels[base] > DENSITY_THRESHOLD) {
          // Convert column → world X
          waterlineX = xMin + (col / (WET_W - 1)) * xRange;
          break;
        }
      }

      // If no water found in this row (wave fully receded), hold position
      const targetX = waterlineX ?? this._posX[i];

      // ── Lerp X toward waterline ─────────────────────────────────────────
      const prevX   = this._posX[i];
      this._posX[i] = prevX + (targetX - prevX) * trackingLerp;

      // ── Y = terrain height at current XZ + float offset ─────────────────
      this._posY[i] = terrainFn(this._posX[i], this._fixedZ[i]) + Y_OFFSET;

      // ── Velocity from frame-to-frame X displacement ──────────────────────
      const dX    = this._posX[i] - this._prevX[i];
      this._prevX[i] = this._posX[i];

      // ── Tumbling: roll axis perpendicular to motion (Z-axis cross) ───────
      // Motion is mostly in X, so roll axis is Z.  Also add Y yaw wobble.
      const speed = Math.abs(dX);
      if (speed > 0.0001) {
        const dir = dX > 0 ? 1 : -1;
        const spin = speed * ANG_VEL_SCALE * tumbleIntensity;
        this._angVZ[i] += dir * spin;          // forward roll
        this._angVY[i] += dir * spin * 0.25;   // slight yaw
      }

      // Random micro-impulses — prevents lockstep spin
      this._angVX[i] += (Math.random() - 0.5) * ANG_RAND * tumbleIntensity;
      this._angVY[i] += (Math.random() - 0.5) * ANG_RAND * tumbleIntensity;
      this._angVZ[i] += (Math.random() - 0.5) * ANG_RAND * tumbleIntensity;

      // Damp + clamp
      this._angVX[i] *= ANG_DAMP;
      this._angVY[i] *= ANG_DAMP;
      this._angVZ[i] *= ANG_DAMP;
      const angSpd = Math.sqrt(this._angVX[i] ** 2 + this._angVY[i] ** 2 + this._angVZ[i] ** 2);
      if (angSpd > ANG_MAX) {
        const sc = ANG_MAX / angSpd;
        this._angVX[i] *= sc; this._angVY[i] *= sc; this._angVZ[i] *= sc;
      }

      // Integrate Euler angles (dt ≈ 1 frame — already baked into spin above)
      this._rotX[i] += this._angVX[i] * 0.016;
      this._rotY[i] += this._angVY[i] * 0.016;
      this._rotZ[i] += this._angVZ[i] * 0.016;

      this._writeMatrix(i);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setVisible(v) { if (this.mesh) this.mesh.visible = v; }
  setScale(s)   { this.scale = s; }

  dispose() {
    if (this.mesh) {
      this._scene.remove(this.mesh);
      this._geo?.dispose();
      this.mesh.dispose();
      this.mesh = null;
    }
    this.loaded = false;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Binary-search terrain for X where terrainFn(x, z) = 0 (waterline).
   * Terrain increases monotonically left→right so bisection converges in 20 steps.
   */
  _findTerrainWaterlineX(z, xMin, xMax, terrainFn) {
    let lo = xMin, hi = xMax;
    for (let iter = 0; iter < 20; iter++) {
      const mid = (lo + hi) * 0.5;
      if (terrainFn(mid, z) < 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  _writeMatrix(i) {
    this._dummy.position.set(this._posX[i], this._posY[i], this._fixedZ[i]);
    this._dummy.rotation.set(this._rotX[i], this._rotY[i], this._rotZ[i]);
    this._dummy.scale.setScalar(this._autoScale * this.scale * this._scaleVar[i]);
    this._dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this._dummy.matrix);
  }
}
