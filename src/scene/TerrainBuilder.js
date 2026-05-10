/**
 * TerrainBuilder.js
 *
 * Builds a single continuous terrain mesh covering the ENTIRE simulation domain.
 * The floor tilts from low (left, x = boundsMin[0]) to high (right, x = boundsMax[0])
 * with simplex-noise height variation on top.
 *
 * Public API
 * ----------
 *   buildTerrain(cfg)
 *     cfg fields used:
 *       boundsMin, boundsMax         — domain corners
 *       slopeAngleDeg   (default 4)  — global tilt, left-low / right-high
 *       terrainNoiseSeed (default 1)
 *       terrainNoiseAmp  (default 0.8) — absolute height variation
 *       terrainNoiseFreq (default 0.06)
 *     Returns { mesh, terrainFn, wetGrid, wetTexture }
 *
 *   updateWetness(wetGrid, wetTexture, positions, numParticles, cfg, terrainFn, dryRate)
 *     Same signature as the old PeninsulaBuilder version; call once per frame.
 *
 * Shader
 * ------
 *   Vertices carry world-Y as a varying.  In the fragment shader:
 *     above waterline (y > 0) → sandy colour modulated by wetness texture
 *     below waterline          → dark seabed with a smooth transition band
 */

import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

// ─── Grid resolution ─────────────────────────────────────────────────────────

const MESH_COLS  = 120;
const MESH_ROWS  = 80;
const WET_GRID_W = 128;
const WET_GRID_H = 80;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNoise(seed) {
  const lcgSeed = Math.abs(Math.floor(seed)) || 1;
  let _s = lcgSeed * 9301 + 49297;
  return createNoise2D(() => {
    _s = (_s * 9301 + 49297) % 233280;
    return _s / 233280;
  });
}

// ─── buildTerrain ─────────────────────────────────────────────────────────────

export function buildTerrain(cfg) {
  const {
    boundsMin,
    boundsMax,
    slopeAngleDeg    = 4,
    terrainNoiseSeed  = 1,
    terrainNoiseAmp   = 0.3,
    terrainNoiseFreq  = 0.06,
  } = cfg;

  const noise2D  = makeNoise(terrainNoiseSeed);
  const slopeTan = Math.tan((slopeAngleDeg * Math.PI) / 180);

  // ── terrainFn ──────────────────────────────────────────────────────────────
  function terrainFn(x, z) {
    const baseH  = boundsMin[1] + slopeTan * (x - boundsMin[0]);
    const noiseH = noise2D(x * terrainNoiseFreq, z * terrainNoiseFreq) * terrainNoiseAmp;
    const h = baseH + noiseH;
    return h > boundsMax[1] ? boundsMax[1] : h;
  }

  // ── Wetness DataTexture ────────────────────────────────────────────────────
  const wetGrid   = new Float32Array(WET_GRID_W * WET_GRID_H);
  const wetPixels = new Uint8Array(WET_GRID_W * WET_GRID_H);
  const wetTexture = new THREE.DataTexture(
    wetPixels, WET_GRID_W, WET_GRID_H, THREE.RedFormat, THREE.UnsignedByteType,
  );
  wetTexture.magFilter = THREE.LinearFilter;
  wetTexture.minFilter = THREE.LinearFilter;
  wetTexture.needsUpdate = true;

  // ── Terrain mesh ──────────────────────────────────────────────────────────
  const xMin = boundsMin[0], xMax = boundsMax[0];
  const zMin = boundsMin[2], zMax = boundsMax[2];
  const xRange = xMax - xMin;
  const zRange = zMax - zMin;

  const numVerts  = MESH_COLS * MESH_ROWS;
  const positions = new Float32Array(numVerts * 3);
  const uvs       = new Float32Array(numVerts * 2);

  for (let row = 0; row < MESH_ROWS; row++) {
    for (let col = 0; col < MESH_COLS; col++) {
      const idx = row * MESH_COLS + col;
      const u   = col / (MESH_COLS - 1);
      const v   = row / (MESH_ROWS - 1);
      const wx  = xMin + u * xRange;
      const wz  = zMin + v * zRange;
      const wy  = terrainFn(wx, wz);

      positions[idx * 3    ] = wx;
      positions[idx * 3 + 1] = wy;
      positions[idx * 3 + 2] = wz;
      uvs[idx * 2    ] = u;
      uvs[idx * 2 + 1] = v;
    }
  }

  const numQuads = (MESH_COLS - 1) * (MESH_ROWS - 1);
  const indices  = new Uint32Array(numQuads * 6);
  let   ptr      = 0;
  for (let row = 0; row < MESH_ROWS - 1; row++) {
    for (let col = 0; col < MESH_COLS - 1; col++) {
      const tl = row * MESH_COLS + col;
      const tr = tl + 1;
      const bl = (row + 1) * MESH_COLS + col;
      const br = bl + 1;
      indices[ptr++] = tl; indices[ptr++] = tr; indices[ptr++] = bl;
      indices[ptr++] = tr; indices[ptr++] = br; indices[ptr++] = bl;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  // ── ShaderMaterial ────────────────────────────────────────────────────────
  // vWorldY carries vertex Y to the fragment shader.
  // smoothstep around y=0 blends seabed → sand across the coastline.
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uWetness:   { value: wetTexture },
      uWaterline: { value: 0.0 },
    },
    vertexShader: /* glsl */`
      varying vec2  vUv;
      varying float vWorldY;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldY = wp.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uWetness;
      uniform float     uWaterline;
      varying vec2  vUv;
      varying float vWorldY;
      void main() {
        float wet       = texture2D(uWetness, vUv).r;
        vec3  drySand   = vec3(0.82, 0.75, 0.51);
        vec3  wetSand   = vec3(0.45, 0.35, 0.22);
        vec3  seabed    = vec3(0.05, 0.12, 0.20);
        vec3  sandColor = mix(drySand, wetSand, wet);

        // Smooth 0.5-unit band around the waterline
        float above = smoothstep(uWaterline - 0.5, uWaterline + 0.5, vWorldY);
        gl_FragColor = vec4(mix(seabed, sandColor, above), 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'terrain';

  return { mesh, terrainFn, wetGrid, wetTexture };
}

// ─── updateWetness ────────────────────────────────────────────────────────────

export function updateWetness(
  wetGrid,
  wetTexture,
  positions,
  numParticles,
  cfg,
  terrainFn,
  dryRate = 0.002,
) {
  const { boundsMin, boundsMax } = cfg;
  const xMin = boundsMin[0], xMax = boundsMax[0];
  const zMin = boundsMin[2], zMax = boundsMax[2];
  const xRange = xMax - xMin;
  const zRange = zMax - zMin;

  // Global drying
  const dryFactor = 1 - dryRate;
  for (let k = 0; k < wetGrid.length; k++) wetGrid[k] *= dryFactor;

  // Mark cells wet where a particle is near/on the sand surface (floor > waterline)
  for (let p = 0; p < numParticles; p++) {
    const px = positions[p * 3    ];
    const py = positions[p * 3 + 1];
    const pz = positions[p * 3 + 2];

    const floorH = terrainFn(px, pz);
    if (floorH > -0.2 && py <= floorH + 0.5) {
      const i = Math.min(
        WET_GRID_W - 1,
        Math.max(0, Math.floor(((px - xMin) / xRange) * WET_GRID_W)),
      );
      const j = Math.min(
        WET_GRID_H - 1,
        Math.max(0, Math.floor(((pz - zMin) / zRange) * WET_GRID_H)),
      );
      const cellIdx = j * WET_GRID_W + i;
      const nv = wetGrid[cellIdx] + 0.15;
      wetGrid[cellIdx] = nv > 1.0 ? 1.0 : nv;
    }
  }

  // Upload to DataTexture
  const pixels = wetTexture.image.data;
  for (let k = 0; k < wetGrid.length; k++) {
    pixels[k] = (wetGrid[k] * 255) | 0;
  }
  wetTexture.needsUpdate = true;
}
