/**
 * GUIControls.js — lil-gui panels for the SPH Ocean simulation
 *
 * All folders start closed. Presets folder at top for quick configuration.
 */

import GUI from 'lil-gui';

// ─── Preset definitions ───────────────────────────────────────────────────────

const PRESETS = {
  Default: {
    wave1Amp: 5.0, wave1Period: 8.0, waveVariation: 0.5,
    waveSpread: 15, waveNoiseMod: 0.3, waveIntensity: 1.0,
    gasConstant: 140, viscosityCoeff: 300, gravity: -9.8,
    beachFriction: 0.998, driftForce: 0.05, currentX: 0, currentZ: 0, windX: 0,
  },
  'Calm Ocean': {
    wave1Amp: 2.0, wave1Period: 13.0, waveVariation: 0.25,
    waveSpread: 6, waveNoiseMod: 0.15, waveIntensity: 0.6,
    gasConstant: 120, viscosityCoeff: 340, gravity: -9.8,
    beachFriction: 0.999, driftForce: 0.03, currentX: 0, currentZ: 0, windX: 0,
  },
  Stormy: {
    wave1Amp: 9.0, wave1Period: 4.5, waveVariation: 0.75,
    waveSpread: 28, waveNoiseMod: 0.55, waveIntensity: 1.9,
    gasConstant: 160, viscosityCoeff: 240, gravity: -9.8,
    beachFriction: 0.994, driftForce: 0.08, currentX: 1.5, currentZ: 0, windX: 2.0,
  },
};

function applyPreset(name, params, liveUpdate, gui) {
  const p = PRESETS[name];
  if (!p) return;
  Object.assign(params, p);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  liveUpdate();
}

// ─── Main GUI ─────────────────────────────────────────────────────────────────

export function buildGUI(params, callbacks) {
  const { liveUpdate, rebuild, rebuildTerrain } = callbacks;

  const gui = new GUI({ title: 'SPH Ocean' });

  // ── Presets ──────────────────────────────────────────────────────────────────
  const presetsFolder = gui.addFolder('Presets');
  Object.keys(PRESETS).forEach(name => {
    presetsFolder.add({ apply: () => applyPreset(name, params, liveUpdate, gui) }, 'apply')
      .name(name);
  });
  presetsFolder.open();  // keep presets open — they're the entry point

  // ── Wave Field ───────────────────────────────────────────────────────────────
  const waveFolder = gui.addFolder('Wave Field');
  waveFolder.add(params, 'wave1Amp', 0.5, 15, 0.5)
    .name('Amplitude').onChange(liveUpdate);
  waveFolder.add(params, 'wave1Period', 2, 20, 0.5)
    .name('Period (s)').onChange(liveUpdate);
  waveFolder.add(params, 'waveVariation', 0, 1, 0.05)
    .name('Overtone strength').onChange(liveUpdate);
  waveFolder.add(params, 'waveSpread', 0, 30, 1)
    .name('Direction spread (°)').onChange(liveUpdate);
  waveFolder.add(params, 'waveNoiseMod', 0, 1, 0.05)
    .name('Modulation depth').onChange(liveUpdate);
  waveFolder.add(params, 'waveIntensity', 0, 3, 0.05)
    .name('Master intensity').onChange(liveUpdate);
  waveFolder.add(params, 'surfaceNeighborThreshold', 1, 8, 1)
    .name('Surface layer (neighbors)').onChange(liveUpdate);
  waveFolder.close();

  // ── Fluid Physics ────────────────────────────────────────────────────────────
  const fluidFolder = gui.addFolder('Fluid Physics');
  fluidFolder.add(params, 'gasConstant', 50, 500, 10)
    .name('Pressure k').onChange(liveUpdate);
  fluidFolder.add(params, 'viscosityCoeff', 50, 500, 10)
    .name('Viscosity μ').onChange(liveUpdate);
  fluidFolder.add(params, 'gravity', -20, 0, 0.5)
    .name('Gravity').onChange(liveUpdate);
  fluidFolder.add(params, 'beachFriction', 0.9, 1.0, 0.001)
    .name('Beach friction').onChange(liveUpdate);
  fluidFolder.close();

  // ── Simulation ───────────────────────────────────────────────────────────────
  const simFolder = gui.addFolder('Simulation');
  simFolder.add(params, 'numParticles', 500, 10000, 100)
    .name('Particles').onFinishChange(rebuild);
  simFolder.add(params, 'substeps', 1, 6, 1)
    .name('Substeps/frame').onChange(liveUpdate);
  simFolder.add(params, 'particleMassDisplay')
    .name('Particle mass').disable().listen();
  simFolder.close();

  // ── Terrain ──────────────────────────────────────────────────────────────────
  const terrainFolder = gui.addFolder('Terrain');
  terrainFolder.add(params, 'slopeAngleDeg', 1, 12, 0.5)
    .name('Slope angle (°)').onFinishChange(rebuild);
  terrainFolder.add(params, 'terrainNoiseSeed', 1, 999, 1)
    .name('Noise seed').onFinishChange(rebuildTerrain);
  terrainFolder.add(params, 'terrainNoiseAmp', 0, 2.0, 0.05)
    .name('Noise amplitude').onFinishChange(rebuildTerrain);
  terrainFolder.add(params, 'terrainNoiseFreq', 0.01, 0.2, 0.005)
    .name('Noise frequency').onFinishChange(rebuildTerrain);
  terrainFolder.add(params, 'wetnessRate', 0.001, 0.02, 0.001)
    .name('Sand drying rate').onChange(liveUpdate);
  terrainFolder.close();

  // ── Rendering ────────────────────────────────────────────────────────────────
  const renderFolder = gui.addFolder('Rendering');
  renderFolder.add(params, 'showFluid').name('Show fluid surface');
  renderFolder.add(params, 'oceanOpacity', 0.0, 1.0, 0.05).name('Ocean opacity');
  renderFolder.add(params, 'showParticles').name('Show particles');
  renderFolder.add(params, 'splatRadius', 0.5, 6.0, 0.1).name('Splat radius');
  renderFolder.add(params, 'blurRadius', 1.0, 20.0, 0.5).name('Blur radius (px)');
  renderFolder.add(params, 'fluidThreshold', 0.05, 0.90, 0.01).name('Surface threshold');
  renderFolder.add(params, 'fluidSoftness', 0.005, 0.15, 0.005).name('Threshold sharpness');
  renderFolder.add(params, 'specPower', 8, 256, 4).name('Specular sharpness');
  renderFolder.add(params, 'crestBrightness',  0.0, 1.0, 0.05).name('Crest brightness');
  renderFolder.add(params, 'crestThreshold',   0.3, 1.0, 0.05).name('Crest threshold');
  renderFolder.add(params, 'oceanDensityMin',  0.30, 0.80, 0.01).name('Ocean min density');
  renderFolder.add(params, 'oceanDensityMax',  0.50, 1.50, 0.01).name('Ocean max density');
  renderFolder.add(params, 'densityDebug').name('Debug: density');
  renderFolder.add(params, 'densityScale', 0.5, 20.0, 0.5).name('Debug scale');
  renderFolder.close();

  // ── Color Palette ────────────────────────────────────────────────────────────
  const paletteFolder = gui.addFolder('Color Palette');
  // Water colours — live-update via per-frame sync in animate loop
  paletteFolder.addColor(params, 'waterDeep')   .name('Deep water');
  paletteFolder.addColor(params, 'waterMid')    .name('Mid water');
  paletteFolder.addColor(params, 'waterShallow').name('Shallow water');
  paletteFolder.addColor(params, 'waterFoam')   .name('Foam');
  // waterPosBlend kept in params for future use but not wired to shader
  // Sand colours
  paletteFolder.addColor(params, 'sandDry').name('Dry sand');
  paletteFolder.addColor(params, 'sandWet').name('Wet sand');
  paletteFolder.close();

  // ── Camera ───────────────────────────────────────────────────────────────────
  const cameraFolder = gui.addFolder('Camera');
  cameraFolder.add(params, 'cameraZoom', 0.5, 3.0, 0.1)
    .name('Zoom').onChange(liveUpdate);
  cameraFolder.add(params, 'sideView').name('Side view');
  cameraFolder.close();

  // ── Interaction ──────────────────────────────────────────────────────────────
  const interactionFolder = gui.addFolder('Interaction');
  interactionFolder.add(params, 'forceRadius', 2, 15, 0.5)
    .name('Force radius');
  interactionFolder.add(params, 'forceStrength', 0.5, 5.0, 0.1)
    .name('Force strength');
  interactionFolder.add(params, 'falloffExp', { Quadratic: 2, Quartic: 4 })
    .name('Falloff shape');
  interactionFolder.close();

  // ── Controls ─────────────────────────────────────────────────────────────────
  const ctrlFolder = gui.addFolder('Controls');
  ctrlFolder.add({ reset: rebuild }, 'reset').name('Reset simulation');
  ctrlFolder.add({ newTerrain: rebuildTerrain }, 'newTerrain').name('Rebuild terrain');
  ctrlFolder.add(params, 'paused').name('Pause');
  ctrlFolder.close();

  return gui;
}

// ─── Force Manager (left-side panel) ─────────────────────────────────────────

export function buildForceGUI(params, liveUpdate) {
  const gui = new GUI({ title: 'Force Manager', width: 240 });

  Object.assign(gui.domElement.style, {
    position: 'fixed',
    left:     '10px',
    top:      '10px',
    zIndex:   '100',
  });

  const driftFolder = gui.addFolder('Beach Drift');
  driftFolder.add(params, 'driftForce', 0, 0.3, 0.005)
    .name('Drift (×|g|)').onChange(liveUpdate);
  driftFolder.close();

  const currentFolder = gui.addFolder('Ocean Current');
  currentFolder.add(params, 'currentX', -8, 8, 0.1).name('← X →').onChange(liveUpdate);
  currentFolder.add(params, 'currentZ', -8, 8, 0.1).name('← Z →').onChange(liveUpdate);
  currentFolder.close();

  const windFolder = gui.addFolder('Surface Wind');
  windFolder.add(params, 'windX', -8, 8, 0.1).name('← Wind X →').onChange(liveUpdate);
  windFolder.close();

  gui.add({
    resetForces() {
      params.driftForce = 0.05;
      params.currentX   = 0;
      params.currentZ   = 0;
      params.windX      = 0;
      gui.controllersRecursive().forEach(c => c.updateDisplay());
      liveUpdate();
    },
  }, 'resetForces').name('Reset all forces');

  return gui;
}
