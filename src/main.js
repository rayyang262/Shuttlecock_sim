/**
 * main.js — Unified Terrain
 *
 * One continuous sloped+noisy terrain mesh covers the whole domain.
 * Floor tilts left-low / right-high so gravity naturally drains water leftward.
 * Coastline is defined by where the terrain crosses y=0 (the waterline).
 */

import * as THREE from 'three';
import Stats from 'stats.js';

import { SPHSolver, DEFAULT_PARAMS } from './sim/SPHSolver.js';
import { ParticleRenderer } from './render/ParticleRenderer.js';
import { buildTerrain, updateWetness } from './scene/TerrainBuilder.js';
import { buildCamera, handleResize, attachZoom } from './scene/CameraSetup.js';
import { buildGUI, buildForceGUI } from './ui/GUIControls.js';

// ─── Renderer ────────────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// ─── Scene ───────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1520);

// ─── Lighting ────────────────────────────────────────────────────────────────

scene.add(new THREE.AmbientLight(0xffd090, 0.55));
const sunLight = new THREE.DirectionalLight(0xffffff, 2.5);
sunLight.position.set(0, 100, 0);
scene.add(sunLight);

// ─── Cameras ─────────────────────────────────────────────────────────────────

// Top-down orthographic (default)
const camera = buildCamera(100, 60);
const detachZoom = attachZoom(camera, renderer.domElement);

// Side view: looks from +Z, shows X-Y cross-section of the slope
const sideCamera = (() => {
  const cam = new THREE.OrthographicCamera(-55, 55, 10, -10, 0.1, 500);
  cam.position.set(0, 2.5, 200);
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 2.5, 0);
  cam.updateProjectionMatrix();
  return cam;
})();

// ─── Stats ───────────────────────────────────────────────────────────────────

const stats = new Stats();
stats.showPanel(0);
document.body.appendChild(stats.dom);

// ─── GUI params ──────────────────────────────────────────────────────────────

const params = {
  // Wave field
  wave1Amp:      DEFAULT_PARAMS.wave1Amp,
  wave1Period:   DEFAULT_PARAMS.wave1Period,
  waveVariation: DEFAULT_PARAMS.waveVariation,
  waveSpread:    DEFAULT_PARAMS.waveSpread,
  waveNoiseMod:  DEFAULT_PARAMS.waveNoiseMod,
  waveIntensity: DEFAULT_PARAMS.waveIntensity,

  numParticles:        DEFAULT_PARAMS.numParticles,
  substeps:            DEFAULT_PARAMS.substeps,
  particleMassDisplay: 0,
  paused:              false,

  // Terrain
  slopeAngleDeg:    DEFAULT_PARAMS.slopeAngleDeg,
  terrainNoiseSeed:  1,
  terrainNoiseAmp:   0.3,
  terrainNoiseFreq:  0.06,
  wetnessRate:       0.005,

  // Camera
  cameraZoom:  1.0,
  sideView:    false,

  // Fluid
  gasConstant:    DEFAULT_PARAMS.gasConstant,
  viscosityCoeff: DEFAULT_PARAMS.viscosityCoeff,
  gravity:        DEFAULT_PARAMS.gravity,
  beachFriction:  DEFAULT_PARAMS.beachFriction,

  // Force Manager
  driftForce: DEFAULT_PARAMS.driftForce,
  currentX:   DEFAULT_PARAMS.currentX,
  currentZ:   DEFAULT_PARAMS.currentZ,
  windX:      DEFAULT_PARAMS.windX,
};

// ─── Mutable simulation objects ───────────────────────────────────────────────

let solver, pRenderer, terrainData, gui, forceGui;

// ─── Live update — push GUI values into the running solver ───────────────────

function liveUpdate() {
  if (!solver) return;
  solver.cfg.wave1Amp      = params.wave1Amp;
  solver.cfg.wave1Period   = params.wave1Period;
  solver.cfg.waveVariation = params.waveVariation;
  solver.cfg.waveSpread    = params.waveSpread;
  solver.cfg.waveNoiseMod  = params.waveNoiseMod;
  solver.cfg.waveIntensity = params.waveIntensity;
  solver.cfg.beachFriction = params.beachFriction;
  solver.cfg.gasConstant     = params.gasConstant;
  solver.cfg.viscosityCoeff  = params.viscosityCoeff;
  solver.cfg.gravity         = params.gravity;
  solver.cfg.substeps        = params.substeps;
  // Force Manager
  solver.cfg.driftForce = params.driftForce;
  solver.cfg.currentX   = params.currentX;
  solver.cfg.currentZ   = params.currentZ;
  solver.cfg.windX      = params.windX;
  camera.zoom = params.cameraZoom;
  camera.updateProjectionMatrix();
}

// ─── Terrain rebuild — regenerate mesh + update solver callback ───────────────

function rebuildTerrain() {
  if (terrainData) {
    scene.remove(terrainData.mesh);
    terrainData.mesh.geometry.dispose();
    terrainData.mesh.material.dispose();
  }

  const cfg = {
    ...DEFAULT_PARAMS,
    slopeAngleDeg:   params.slopeAngleDeg,
    terrainNoiseSeed: params.terrainNoiseSeed,
    terrainNoiseAmp:  params.terrainNoiseAmp,
    terrainNoiseFreq: params.terrainNoiseFreq,
  };
  terrainData = buildTerrain(cfg);
  scene.add(terrainData.mesh);

  if (solver) solver.cfg.terrainFn = terrainData.terrainFn;
}

// ─── Full rebuild ─────────────────────────────────────────────────────────────

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
  if (gui)      { gui.destroy();      gui      = null; }
  if (forceGui) { forceGui.destroy(); forceGui = null; }

  const terrainCfg = {
    ...DEFAULT_PARAMS,
    slopeAngleDeg:   params.slopeAngleDeg,
    terrainNoiseSeed: params.terrainNoiseSeed,
    terrainNoiseAmp:  params.terrainNoiseAmp,
    terrainNoiseFreq: params.terrainNoiseFreq,
  };
  terrainData = buildTerrain(terrainCfg);
  scene.add(terrainData.mesh);

  solver = new SPHSolver({
    numParticles:    params.numParticles,
    wave1Amp:        params.wave1Amp,
    wave1Period:     params.wave1Period,
    waveVariation:   params.waveVariation,
    waveSpread:      params.waveSpread,
    waveNoiseMod:    params.waveNoiseMod,
    waveIntensity:   params.waveIntensity,
    beachFriction:   params.beachFriction,
    gasConstant:     params.gasConstant,
    viscosityCoeff:  params.viscosityCoeff,
    gravity:         params.gravity,
    substeps:        params.substeps,
    slopeAngleDeg:   params.slopeAngleDeg,
    terrainFn:       terrainData.terrainFn,
    driftForce:      params.driftForce,
    currentX:        params.currentX,
    currentZ:        params.currentZ,
    windX:           params.windX,
  });

  params.particleMassDisplay = +solver.cfg.particleMass.toFixed(2);

  const fcfg = solver.cfg;
  pRenderer = new ParticleRenderer(
    scene,
    fcfg.numParticles,
    fcfg.smoothingRadius * 0.4,
    0,
    { boundsMin: fcfg.boundsMin, boundsMax: fcfg.boundsMax },
  );

  gui      = buildGUI(params, { liveUpdate, rebuild, rebuildTerrain });
  forceGui = buildForceGUI(params, liveUpdate);
}

// ─── Initial build ────────────────────────────────────────────────────────────

rebuild();

// ─── Resize ──────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => handleResize(camera, renderer));

// ─── Animation loop ──────────────────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  stats.begin();

  if (!params.paused) {
    const steps = solver.cfg.substeps;
    for (let s = 0; s < steps; s++) solver.step();

    updateWetness(
      terrainData.wetGrid,
      terrainData.wetTexture,
      solver.positions,
      solver.cfg.numParticles,
      solver.cfg,
      terrainData.terrainFn,
      params.wetnessRate,
    );

    params.particleMassDisplay = +solver.cfg.particleMass.toFixed(2);
    pRenderer.update(solver.positions, solver.velocities);
  }

  const W = window.innerWidth;
  const H = window.innerHeight;

  if (params.sideView) {
    // Side view fills the full canvas
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.render(scene, sideCamera);
  } else {
    // Top-down fills the full canvas + small side inset
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.render(scene, camera);

    const IW = 340, IH = 120;
    const IX = W - IW - 10, IY = 10;
    renderer.setScissorTest(true);
    renderer.setScissor(IX, IY, IW, IH);
    renderer.setViewport(IX, IY, IW, IH);
    renderer.render(scene, sideCamera);
    renderer.setScissorTest(false);
  }

  stats.end();
}

animate();
