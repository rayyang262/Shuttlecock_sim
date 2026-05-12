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
  // Slope runs along Z: floor deepest at boundsMax[2] (ocean bottom, screen bottom),
  // rising toward boundsMin[2] (beach top, screen top).
  function terrainFn(x, z) {
    const baseH  = boundsMin[1] + slopeTan * (boundsMax[2] - z);
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
      uWetness:      { value: wetTexture },
      uWaterline:    { value: 0.0 },
      uDrySandColor: { value: new THREE.Color(0xE6EFEA) }, // Gray Tint
      uWetSandColor: { value: new THREE.Color(0xB5C2BC) }, // Dark Gray Tint
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
      uniform vec3      uDrySandColor; // GUI-controlled: Gray Tint #E6EFEA
      uniform vec3      uWetSandColor; // GUI-controlled: Dark Gray Tint #B5C2BC
      varying vec2  vUv;
      varying float vWorldY;

      void main() {
        float wet = texture2D(uWetness, vUv).r;

        // ── Sand ripple variation ───────────────────────────────────────
        // Cheap UV-space sine ripples give sand texture without a lookup.
        float r1 = sin(vUv.x * 130.0 + vUv.y * 40.0) * 0.022;
        float r2 = sin(vUv.y * 90.0  + vUv.x * 55.0) * 0.015;
        float ripple = r1 + r2; // range ≈ ±0.037

        // Apply ripple variation to the uniform dry-sand base color
        vec3 drySand = clamp(uDrySandColor + vec3(ripple * 0.5, ripple * 0.45, ripple * 0.25), 0.0, 1.0);
        // Wet sand uses the uniform directly (no ripple — water flattens texture)
        vec3 wetSand = uWetSandColor;

        // Wet/dry blend
        vec3 sandColor = mix(drySand, wetSand, wet * wet);

        // ── Seabed colour — visible dark teal instead of near-black ────
        // Add a subtle depth gradient so the seabed looks deeper at the ocean bottom.
        // vUv.y = 1 maps to worldZ = boundsMax[2] (ocean bottom, screen bottom) = deepest.
        float seabedDepth = vUv.y; // deeper = high vUv.y = darker
        vec3 shallowBed = vec3(0.10, 0.22, 0.38);
        vec3 deepBed    = vec3(0.04, 0.10, 0.20);
        vec3 seabed     = mix(shallowBed, deepBed, seabedDepth * seabedDepth);

        // ── Waterline blend ─────────────────────────────────────────────
        float above = smoothstep(uWaterline - 0.6, uWaterline + 0.6, vWorldY);
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
//
// GPU-readback version: samples the post-blur, post-mask fluid density buffer
// instead of iterating particle positions. Only cells where the RENDERED water
// surface actually exists (density > densityThreshold) become wet, eliminating
// the thin streaky trails left by isolated fast-moving particles.
//
// densityPixels  — Uint8Array(128×80×4) from FluidRenderer.readWetnessPixels()
//                  R channel: density × 255. GL convention: row 0 = GL bottom
//                  = UV.y = 0 = worldZ = boundsMax[2].  Y-flip applied below.
// densityThreshold — should match the fluid surface threshold used in rendering

export function updateWetness(
  wetGrid,
  wetTexture,
  densityPixels,
  cfg,
  terrainFn,
  dryRate           = 0.002,
  densityThreshold  = 0.55,
) {
  const { boundsMin, boundsMax } = cfg;
  const xMin = boundsMin[0], xMax = boundsMax[0];
  const zMin = boundsMin[2], zMax = boundsMax[2];
  const xRange = xMax - xMin;
  const zRange = zMax - zMin;

  // Global drying — unchanged
  const dryFactor = 1 - dryRate;
  for (let k = 0; k < wetGrid.length; k++) wetGrid[k] *= dryFactor;

  // Threshold in 0-255 space to avoid per-cell division
  const threshByte = (densityThreshold * 255) | 0;

  // Walk every wetness cell, sample the density readback buffer
  for (let j = 0; j < WET_GRID_H; j++) {
    for (let i = 0; i < WET_GRID_W; i++) {
      // Centre of this wetness cell in world space
      const wx = xMin + (i + 0.5) / WET_GRID_W * xRange;
      const wz = zMin + (j + 0.5) / WET_GRID_H * zRange;

      // Skip deep-ocean cells — no sand there to wet, and skipping saves ~40%
      // of the inner loop on typical terrain configs
      if (terrainFn(wx, wz) < -0.5) continue;

      // Map wetness cell (i, j) → readback pixel.
      // GL row 0 = bottom of texture = UV.y = 0 = worldZ = boundsMax[2].
      // Wetness j = 0 → worldZ = boundsMin[2] → UV.y = 1 → GL row = H - 1.
      const glRow   = WET_GRID_H - 1 - j;
      const pixBase = (glRow * WET_GRID_W + i) * 4; // RGBA stride
      const densR   = densityPixels[pixBase];        // R channel, 0-255

      if (densR > threshByte) {
        const cellIdx = j * WET_GRID_W + i;
        const nv = wetGrid[cellIdx] + 0.15;
        wetGrid[cellIdx] = nv > 1.0 ? 1.0 : nv;
      }
    }
  }

  // Upload to DataTexture — unchanged
  const pixels = wetTexture.image.data;
  for (let k = 0; k < wetGrid.length; k++) {
    pixels[k] = (wetGrid[k] * 255) | 0;
  }
  wetTexture.needsUpdate = true;
}
