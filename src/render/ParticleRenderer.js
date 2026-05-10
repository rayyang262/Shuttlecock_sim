/**
 * ParticleRenderer — draws N fluid particles using a single InstancedMesh.
 *
 * Why InstancedMesh?
 * One GPU draw call regardless of particle count.  1500 separate Mesh objects
 * would issue 1500 draw calls at 60 fps — far too expensive.  InstancedMesh
 * batches them into one call and lets us push a transform matrix + colour
 * per instance.
 *
 * Phase 2 colour scheme — two-factor blend:
 *   DEPTH:  y near boundsMin → deep dark navy; y near 0 → ocean blue.
 *   SPEED:  fast particles (wave crests, splashing) shift toward cyan/white.
 *
 * The combination means:
 *   Still, deep water   = dark navy blue
 *   Still, surface      = ocean blue
 *   Moving wave crest   = bright cyan
 *   Splashing runup     = near-white
 */

import * as THREE from 'three';

export class ParticleRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {number}      numParticles
   * @param {number}      radius       Visual sphere radius
   * @param {number}      detail       IcosahedronGeometry detail (0–2)
   * @param {object}      cfg          Optional: { boundsMin, boundsMax }
   */
  constructor(scene, numParticles, radius = 0.055, detail = 1, cfg = {}) {
    this._N = numParticles;

    // Depth normalisation: maps particle y to [0, 1] where
    //   0 = at seabed (boundsMin[1])
    //   1 = at rest water surface (y = 0)
    const yMin = cfg.boundsMin ? cfg.boundsMin[1] : -1.5;
    this._yMin   = yMin;
    this._yRange = 0.0 - yMin; // distance from seabed to water surface

    const geometry = new THREE.IcosahedronGeometry(radius, detail);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.08,
      metalness: 0.0,
    });

    this._mesh = new THREE.InstancedMesh(geometry, material, numParticles);
    this._mesh.castShadow    = false;
    this._mesh.receiveShadow = false;
    this._mesh.frustumCulled = false;

    // Initialise instanceColor buffer (required before setColorAt in the loop)
    this._color = new THREE.Color();
    this._mesh.setColorAt(0, this._color);

    scene.add(this._mesh);
    this._dummy = new THREE.Object3D();
  }

  /**
   * Sync instance transforms and colours each frame.
   *
   * @param {Float32Array} positions   Flat [x0,y0,z0, x1,y1,z1, …]
   * @param {Float32Array} velocities  Flat velocity array, same layout
   */
  update(positions, velocities) {
    const N     = this._N;
    const dummy = this._dummy;
    const color = this._color;
    const mesh  = this._mesh;
    const yMin   = this._yMin;
    const yRange = this._yRange;

    for (let i = 0; i < N; i++) {
      // ── Position ─────────────────────────────────────────────────────────
      dummy.position.set(positions[3*i], positions[3*i+1], positions[3*i+2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // ── Colour: depth × velocity ──────────────────────────────────────────
      //
      // depthT:  0 = at seabed (darkest)   →  1 = at water surface (lighter)
      // speedT:  0 = still                 →  1 = fast (~8 units/s)
      //
      // Hue gradient:  0.67 (deep blue) → 0.52 (cyan) as speed increases
      // Lightness:     0.10 (deep/still) → 0.85 (surface/fast)
      //
      // The dual weighting means a slow deep particle = very dark navy, while
      // a fast cresting particle = bright cyan-white regardless of depth.
      const y = positions[3*i + 1];
      const vx = velocities[3*i], vy = velocities[3*i+1], vz = velocities[3*i+2];
      const speed  = Math.sqrt(vx*vx + vy*vy + vz*vz);

      const depthT = Math.min(Math.max((y - yMin) / yRange, 0.0), 1.0);
      const speedT = Math.min(speed / 7.0, 1.0);

      color.setHSL(
        0.67 - speedT * 0.15,           // blue → cyan
        0.90 - speedT * 0.25,           // desaturate near white when very fast
        0.10 + depthT * 0.22 + speedT * 0.50,  // dark-deep → bright-fast
      );
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Call after a rebuild changes boundsMin/Max so depth colouring stays calibrated. */
  updateBounds(boundsMin, boundsMax) {
    this._yMin   = boundsMin[1];
    this._yRange = 0.0 - boundsMin[1];
  }

  get mesh() { return this._mesh; }
}
