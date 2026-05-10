/**
 * PeninsulaBuilder.js — Stage 2.5A
 *
 * Procedurally generates a sand peninsula that juts from the RIGHT side of the
 * domain leftward into the ocean, with a live wetness texture updated each frame.
 *
 * Public API
 * ----------
 *   buildPeninsula(cfg)
 *     Returns { mesh, peninsulaFn, wetnessMesh, wetGrid, wetTexture }
 *
 *   updateWetness(wetGrid, wetTexture, positions, numParticles, cfg, dryRate)
 *     Call once per frame after the SPH step to paint wet-sand darkening.
 */

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

// ─── Constants ────────────────────────────────────────────────────────────────

const WET_GRID_W = 128; // cells along world-x (peninsula width)
const WET_GRID_H = 80;  // cells along world-z (domain depth)

// Slope tan is derived from cfg.slopeAngleDeg at build time (see buildPeninsula)

// Mesh resolution
const MESH_COLS = 80; // vertices along x
const MESH_ROWS = 60; // vertices along z

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a Float32Array cache of coastlineX values sampled at 1-unit z intervals.
 * Index 0 corresponds to z = boundsMin[2].
 *
 * @param {Function} noise2D  - createNoise2D() instance
 * @param {object}   cfg      - simulation config
 * @returns {Float32Array}
 */
function buildCoastlineCache(noise2D, cfg) {
  const { boundsMin, boundsMax, peninsulaExtent = 35 } = cfg;
  const zMin = boundsMin[2];
  const zMax = boundsMax[2];
  const zLen = Math.ceil(zMax - zMin) + 1;
  const cache = new Float32Array(zLen);

  for (let iz = 0; iz < zLen; iz++) {
    const z = zMin + iz;
    // Organic wavy coastline edge
    cache[iz] = boundsMax[0] - peninsulaExtent + noise2D(z * 0.05, 0) * 5;
  }
  return cache;
}

/**
 * Sample coastlineX at any z, using the pre-built cache with linear
 * interpolation for sub-unit precision.
 *
 * @param {Float32Array} cache
 * @param {number}       z
 * @param {number}       zMin
 * @returns {number}
 */
function sampleCoastline(cache, z, zMin) {
  const frac = z - zMin;
  const lo = Math.max(0, Math.min(cache.length - 2, Math.floor(frac)));
  const t = frac - lo;
  return cache[lo] * (1 - t) + cache[lo + 1] * t;
}

// ─── buildPeninsula ───────────────────────────────────────────────────────────

/**
 * @param {object} cfg
 *   Required fields:
 *     boundsMin          [x, y, z]
 *     boundsMax          [x, y, z]
 *   Optional:
 *     peninsulaExtent    number (default 35)
 *     peninsulaSeed      number (default 1.0) — noise seed offset
 *
 * @returns {{
 *   mesh:        THREE.Mesh,
 *   peninsulaFn: (x:number, z:number) => number,
 *   wetnessMesh: THREE.Mesh,
 *   wetGrid:     Float32Array,
 *   wetTexture:  THREE.DataTexture
 * }}
 */
export function buildPeninsula(cfg) {
  const {
    boundsMin,
    boundsMax,
    peninsulaExtent = 35,
    peninsulaSeed   = 1.0,
  } = cfg;

  // ── Noise + coastline cache ────────────────────────────────────────────────
  // Seeded LCG so different peninsulaSeed values produce genuinely different
  // permutation tables inside createNoise2D (requires a [0,1) random fn).
  const lcgSeed = Math.abs(Math.floor(peninsulaSeed)) || 1;
  let _s = lcgSeed * 9301 + 49297;
  const noise2D = createNoise2D(() => {
    _s = (_s * 9301 + 49297) % 233280;
    return _s / 233280;
  });

  // Slope tangent derived from cfg — respects the slopeAngleDeg GUI slider
  const slopeTan = Math.tan(((cfg.slopeAngleDeg || 7) * Math.PI) / 180);

  const coastCache = buildCoastlineCache(noise2D, { ...cfg, peninsulaExtent });

  const zMin = boundsMin[2];
  const zMax = boundsMax[2];
  const xMax = boundsMax[0];
  const yMin = boundsMin[1];
  const yMax = boundsMax[1];

  // Pre-compute coastlineX min for UV mapping and mesh extent
  let coastXMin = Infinity;
  for (let i = 0; i < coastCache.length; i++) {
    if (coastCache[i] < coastXMin) coastXMin = coastCache[i];
  }
  // Give a small margin so UVs don't clip at 0
  coastXMin -= 0.5;

  // ── peninsulaFn ───────────────────────────────────────────────────────────
  /**
   * Returns the floor height at world position (x, z).
   * Fast enough to be called ~3000 times per substep per frame because
   * coastlineX lookup is a two-element lerp on a pre-built Float32Array.
   *
   * @param {number} x
   * @param {number} z
   * @returns {number} floor y
   */
  function peninsulaFn(x, z) {
    const cx = sampleCoastline(coastCache, z, zMin);
    if (x > cx) {
      // On the peninsula sand — sloped surface rising rightward
      const h = yMin + slopeTan * (x - cx);
      return h > yMax ? yMax : h;
    }
    // In the ocean — flat floor
    return yMin;
  }

  // ── Wetness DataTexture ────────────────────────────────────────────────────
  const wetGrid = new Float32Array(WET_GRID_W * WET_GRID_H);

  const wetPixels = new Uint8Array(WET_GRID_W * WET_GRID_H);
  const wetTexture = new THREE.DataTexture(
    wetPixels,
    WET_GRID_W,
    WET_GRID_H,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  wetTexture.magFilter = THREE.LinearFilter;
  wetTexture.minFilter = THREE.LinearFilter;
  wetTexture.needsUpdate = true;

  // ── ShaderMaterial ────────────────────────────────────────────────────────
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uWetness: { value: wetTexture },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uWetness;
      varying vec2 vUv;
      void main() {
        float wet = texture2D(uWetness, vUv).r;
        vec3 drySand = vec3(0.82, 0.75, 0.51);
        vec3 wetSand = vec3(0.45, 0.35, 0.22);
        vec3 color = mix(drySand, wetSand, wet);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });

  // ── Build peninsula BufferGeometry ────────────────────────────────────────
  //
  // Grid of MESH_COLS x MESH_ROWS vertices covering the peninsula surface.
  // x: [coastXMin, boundsMax[0]]
  // z: [boundsMin[2], boundsMax[2]]

  const numVerts = MESH_COLS * MESH_ROWS;
  const positions = new Float32Array(numVerts * 3);
  const uvs       = new Float32Array(numVerts * 2);

  const xPenMin = coastXMin;
  const xPenMax = xMax;
  const xPenRange = xPenMax - xPenMin;
  const zRange    = zMax - zMin;

  for (let row = 0; row < MESH_ROWS; row++) {
    for (let col = 0; col < MESH_COLS; col++) {
      const idx = row * MESH_COLS + col;

      const u = col / (MESH_COLS - 1);
      const v = row / (MESH_ROWS - 1);

      const wx = xPenMin + u * xPenRange;
      const wz = zMin    + v * zRange;
      const wy = peninsulaFn(wx, wz);

      positions[idx * 3    ] = wx;
      positions[idx * 3 + 1] = wy;
      positions[idx * 3 + 2] = wz;

      uvs[idx * 2    ] = u;
      uvs[idx * 2 + 1] = v;
    }
  }

  // Indexed triangles (two triangles per quad cell)
  const numQuads   = (MESH_COLS - 1) * (MESH_ROWS - 1);
  const indices    = new Uint32Array(numQuads * 6);
  let   idxPtr     = 0;

  for (let row = 0; row < MESH_ROWS - 1; row++) {
    for (let col = 0; col < MESH_COLS - 1; col++) {
      const tl = row       * MESH_COLS + col;
      const tr = row       * MESH_COLS + col + 1;
      const bl = (row + 1) * MESH_COLS + col;
      const br = (row + 1) * MESH_COLS + col + 1;

      // Triangle 1: tl, tr, bl
      indices[idxPtr++] = tl;
      indices[idxPtr++] = tr;
      indices[idxPtr++] = bl;

      // Triangle 2: tr, br, bl
      indices[idxPtr++] = tr;
      indices[idxPtr++] = br;
      indices[idxPtr++] = bl;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'peninsula';

  // ── Invisible proxy for wetness grid coverage ────────────────────────────
  // wetnessMesh is the same mesh — external code may add it to the scene
  // separately if needed for layering / render order control.
  const wetnessMesh = mesh;

  return {
    mesh,
    peninsulaFn,
    wetnessMesh,
    wetGrid,
    wetTexture,
    // Expose internals used by updateWetness
    _coastCache: coastCache,
    _coastXMin:  xPenMin,
    _zMin:       zMin,
  };
}

// ─── updateWetness ────────────────────────────────────────────────────────────

/**
 * Update the wetness grid each frame and upload the result to the DataTexture.
 *
 * @param {Float32Array}     wetGrid      WET_GRID_W * WET_GRID_H float grid
 * @param {THREE.DataTexture} wetTexture   The texture bound to the ShaderMaterial
 * @param {Float32Array}     positions    Particle positions [x0,y0,z0, x1,y1,z1, …]
 * @param {number}           numParticles
 * @param {object}           cfg          Same cfg passed to buildPeninsula
 * @param {Function}         peninsulaFn  Returned by buildPeninsula
 * @param {number}           [dryRate=0.002] Fraction to dry per frame
 */
export function updateWetness(
  wetGrid,
  wetTexture,
  positions,
  numParticles,
  cfg,
  peninsulaFn,
  dryRate = 0.002,
) {
  const { boundsMin, boundsMax, peninsulaExtent = 35 } = cfg;

  const xMin = boundsMax[0] - peninsulaExtent - 2; // a little left of min coastline
  const xMax = boundsMax[0];
  const zMin = boundsMin[2];
  const zMax = boundsMax[2];

  const xRange = xMax - xMin;
  const zRange = zMax - zMin;

  // ── Global drying ─────────────────────────────────────────────────────────
  const dryFactor = 1 - dryRate;
  for (let k = 0; k < wetGrid.length; k++) {
    wetGrid[k] *= dryFactor;
  }

  // ── Mark particles near/on the sand surface as wet ────────────────────────
  const waterlineThreshold = boundsMin[1] + 0.5;

  for (let p = 0; p < numParticles; p++) {
    const px = positions[p * 3    ];
    const py = positions[p * 3 + 1];
    const pz = positions[p * 3 + 2];

    // Quick range check before the peninsulaFn call
    if (px < xMin || px > xMax || pz < zMin || pz > zMax) continue;

    const floorH = peninsulaFn(px, pz);

    // Only particles near or above ocean floor level count as wetting sand
    if (floorH > waterlineThreshold || py <= floorH + 0.3) {
      // Map world (px, pz) → grid cell (i, j)
      const i = Math.min(
        WET_GRID_W - 1,
        Math.max(0, Math.floor(((px - xMin) / xRange) * WET_GRID_W)),
      );
      const j = Math.min(
        WET_GRID_H - 1,
        Math.max(0, Math.floor(((pz - zMin) / zRange) * WET_GRID_H)),
      );

      const cellIdx = j * WET_GRID_W + i;
      const newVal = wetGrid[cellIdx] + 0.15;
      wetGrid[cellIdx] = newVal > 1.0 ? 1.0 : newVal;
    }
  }

  // ── Upload to DataTexture ─────────────────────────────────────────────────
  // wetTexture.image.data is the Uint8Array we created in buildPeninsula
  const pixels = wetTexture.image.data;
  for (let k = 0; k < wetGrid.length; k++) {
    pixels[k] = (wetGrid[k] * 255) | 0;
  }
  wetTexture.needsUpdate = true;
}
