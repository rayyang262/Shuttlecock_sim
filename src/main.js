/**
 * main.js — SPH Ocean Simulator
 */

import * as THREE from 'three';
import Stats from 'stats.js';

import { SPHSolver, DEFAULT_PARAMS } from './sim/SPHSolver.js';
import { ParticleRenderer } from './render/ParticleRenderer.js';
import { buildTerrain, updateWetness } from './scene/TerrainBuilder.js';
import { buildCamera, handleResize, attachZoom } from './scene/CameraSetup.js';
import { FluidRenderer } from './render/FluidRenderer.js';
import { InteractionHandler } from './sim/InteractionHandler.js';

// ─── Renderer ────────────────────────────────────────────────────────────────

const isMobile = window.innerWidth < 768 || /Mobi|Android/i.test(navigator.userAgent);

const renderer = new THREE.WebGLRenderer({ antialias: !isMobile });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);

// ─── Scene ───────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();

scene.add(new THREE.AmbientLight(0xffd090, 0.55));
const sunLight = new THREE.DirectionalLight(0xffffff, 2.5);
sunLight.position.set(0, 100, 0);
scene.add(sunLight);

// ─── Camera ──────────────────────────────────────────────────────────────────

const camera = buildCamera(60, 100);
const detachZoom = attachZoom(camera, renderer.domElement);

// ─── Background gradient ─────────────────────────────────────────────────────
// Full-screen navy gradient rendered before the main scene so background areas
// (the X-axis margins that extend beyond the 60-unit domain in landscape mode)
// look like deep ocean rather than a hard black void.

const bgScene  = new THREE.Scene();
const bgOrtho  = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const bgMat    = new THREE.ShaderMaterial({
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      // #0a1428 at top (beach side) → #162940 at bottom (open ocean)
      vec3 topColor    = vec3(0.039, 0.082, 0.157);
      vec3 bottomColor = vec3(0.086, 0.161, 0.251);
      gl_FragColor = vec4(mix(bottomColor, topColor, vUv.y), 1.0);
    }
  `,
  depthTest:  false,
  depthWrite: false,
});
bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));

// ─── Stats ───────────────────────────────────────────────────────────────────

const stats = new Stats();
stats.showPanel(0);
document.body.appendChild(stats.dom);

// ─── Simulation config ────────────────────────────────────────────────────────

const CFG = {
  // Wave field
  wave1Amp:                 10,
  wave1Period:              4.5,
  waveVariation:            1,
  waveSpread:               0,
  waveNoiseMod:             0.3,
  waveIntensity:            1,
  surfaceNeighborThreshold: 3,

  // Simulation
  numParticles:  isMobile ? 2500 : DEFAULT_PARAMS.numParticles,
  substeps:      DEFAULT_PARAMS.substeps,

  // Terrain
  slopeAngleDeg:    4,
  terrainNoiseSeed: 1,
  terrainNoiseAmp:  0.3,
  terrainNoiseFreq: 0.06,
  wetnessRate:      0.005,

  // Fluid rendering
  splatRadius:    2,
  blurRadius:     8,
  fluidThreshold: 0.55,
  fluidSoftness:  0.015,
  specPower:      80,
  crestBrightness: 0.95,
  crestThreshold:  0.5,
  oceanDensityMin: 0.8,
  oceanDensityMax: 0.55,
  densityScale:    2,

  // Water colours
  waterDeep:    '#0082E0',
  waterMid:     '#00C0D1',
  waterShallow: '#8AE7D4',
  waterFoam:    '#deeeff',
  waterPosBlend: 0.35,

  // Interaction
  forceRadius:   2,
  forceStrength: 5,
  falloffExp:    2,

  // Physics
  gasConstant:    DEFAULT_PARAMS.gasConstant,
  viscosityCoeff: DEFAULT_PARAMS.viscosityCoeff,
  gravity:        DEFAULT_PARAMS.gravity,
  beachFriction:  DEFAULT_PARAMS.beachFriction,
  driftForce:     DEFAULT_PARAMS.driftForce,
  currentX:       DEFAULT_PARAMS.currentX,
  currentZ:       1,
  windX:          DEFAULT_PARAMS.windX,
};

// ─── Mutable simulation objects ───────────────────────────────────────────────

let solver, pRenderer, terrainData, fluidRenderer, interaction;

// ─── Build ────────────────────────────────────────────────────────────────────

function rebuild() {
  if (terrainData) {
    scene.remove(terrainData.mesh);
    terrainData.mesh.geometry.dispose();
    terrainData.mesh.material.dispose();
  }
  if (pRenderer) {
    scene.remove(pRenderer.mesh);
    pRenderer.mesh.geometry.dispose();
    pRenderer.mesh.material.dispose();
  }
  if (fluidRenderer) { fluidRenderer.dispose(); fluidRenderer = null; }
  if (interaction)   { interaction.dispose();   interaction   = null; }

  terrainData = buildTerrain({
    ...DEFAULT_PARAMS,
    slopeAngleDeg:    CFG.slopeAngleDeg,
    terrainNoiseSeed: CFG.terrainNoiseSeed,
    terrainNoiseAmp:  CFG.terrainNoiseAmp,
    terrainNoiseFreq: CFG.terrainNoiseFreq,
  });
  terrainData.mesh.visible = true;
  scene.add(terrainData.mesh);

  solver = new SPHSolver({
    numParticles:             CFG.numParticles,
    wave1Amp:                 CFG.wave1Amp,
    wave1Period:              CFG.wave1Period,
    waveVariation:            CFG.waveVariation,
    waveSpread:               CFG.waveSpread,
    waveNoiseMod:             CFG.waveNoiseMod,
    waveIntensity:            CFG.waveIntensity,
    surfaceNeighborThreshold: CFG.surfaceNeighborThreshold,
    beachFriction:            CFG.beachFriction,
    gasConstant:              CFG.gasConstant,
    viscosityCoeff:           CFG.viscosityCoeff,
    gravity:                  CFG.gravity,
    substeps:                 CFG.substeps,
    slopeAngleDeg:            CFG.slopeAngleDeg,
    terrainFn:                terrainData.terrainFn,
    driftForce:               CFG.driftForce,
    currentX:                 CFG.currentX,
    currentZ:                 CFG.currentZ,
    windX:                    CFG.windX,
  });

  const fcfg = solver.cfg;
  pRenderer = new ParticleRenderer(
    scene, fcfg.numParticles, fcfg.smoothingRadius * 0.4, 0,
    { boundsMin: fcfg.boundsMin, boundsMax: fcfg.boundsMax },
  );
  pRenderer.mesh.visible = false;

  fluidRenderer = new FluidRenderer(renderer, camera, solver.cfg.numParticles, {
    splatRadius:     CFG.splatRadius,
    densityScale:    CFG.densityScale,
    blurRadius:      CFG.blurRadius,
    threshold:       CFG.fluidThreshold,
    softness:        CFG.fluidSoftness,
    specPower:       CFG.specPower,
    crestBrightness: CFG.crestBrightness,
    crestThreshold:  CFG.crestThreshold,
    oceanDensityMin: CFG.oceanDensityMin,
    oceanDensityMax: CFG.oceanDensityMax,
    deepColor:       CFG.waterDeep,
    midColor:        CFG.waterMid,
    shallowColor:    CFG.waterShallow,
    foamColor:       CFG.waterFoam,
    posBlend:        CFG.waterPosBlend,
    // Reduced RT scale for better performance; fluid detail is preserved by blur
    rtScale:         isMobile ? 0.4 : 0.5,
  });
  fluidRenderer.setBounds(solver.cfg.boundsMin, solver.cfg.boundsMax);
  fluidRenderer.setYBounds(-1.0, 4.0);
  fluidRenderer.setFrustum(camera);

  interaction = new InteractionHandler(renderer, camera);
  interaction.forceRadius   = CFG.forceRadius;
  interaction.forceStrength = CFG.forceStrength;
  interaction.falloffExp    = CFG.falloffExp;
}

// ─── Initial build ────────────────────────────────────────────────────────────

rebuild();

// ─── Loading screen fade ──────────────────────────────────────────────────────

setTimeout(() => {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.add('fade-out');
  setTimeout(() => el.parentNode && el.parentNode.removeChild(el), 900);
}, 2800);

// ─── Resize ──────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  handleResize(camera, renderer);
  if (fluidRenderer) {
    fluidRenderer.resize();
    fluidRenderer.setFrustum(camera);
  }
});

// ─── Animation loop ──────────────────────────────────────────────────────────

function animate(timestamp) {
  requestAnimationFrame(animate);
  stats.begin();

  const steps = solver.cfg.substeps;
  for (let s = 0; s < steps; s++) solver.step();
  pRenderer.update(solver.positions, solver.velocities);

  interaction.update(solver, timestamp);

  // Density → blur → edge mask → wetness pipeline
  fluidRenderer.updatePositions(solver.positions);
  fluidRenderer.renderDensityPass();
  fluidRenderer.renderBlurPass();
  fluidRenderer.renderMaskPass();
  fluidRenderer.renderWetnessDownsample();
  const densityPixels = fluidRenderer.readWetnessPixels();
  updateWetness(
    terrainData.wetGrid, terrainData.wetTexture,
    densityPixels, solver.cfg, terrainData.terrainFn,
    CFG.wetnessRate, CFG.fluidThreshold,
  );

  // Render
  const W = window.innerWidth, H = window.innerHeight;
  renderer.setRenderTarget(null);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.clear(true, true, true);

  // Sync frustum uniforms (zoom may have changed since last frame)
  fluidRenderer.setFrustum(camera);

  renderer.render(bgScene, bgOrtho);   // navy gradient background
  renderer.render(scene, camera);
  fluidRenderer.renderWaterComposite();
  interaction.renderCursor(camera);

  stats.end();
}

animate(performance.now());
