/**
 * GUIControls.js — lil-gui panel for the SPH Ocean simulation (Unified Terrain)
 *
 * Usage:
 *   const gui = buildGUI(params, { liveUpdate, rebuild, rebuildTerrain });
 *
 * Expected params shape:
 * {
 *   waveMakerPeriod, waveMakerAmp,
 *   numParticles, substeps, particleMassDisplay, paused,
 *   slopeAngleDeg, terrainNoiseSeed, terrainNoiseAmp, terrainNoiseFreq,
 *   wetnessRate,
 *   cameraZoom, sideView,
 *   gasConstant, viscosityCoeff, gravity, beachFriction,
 * }
 */

import GUI from 'lil-gui';

export function buildGUI(params, callbacks) {
  const { liveUpdate, rebuild, rebuildTerrain } = callbacks;

  const gui = new GUI({ title: 'SPH Ocean — Unified Terrain' });

  // ── Wave Field ───────────────────────────────────────────────────────────────
  const waveFolder = gui.addFolder('Wave Field');
  waveFolder.add(params, 'wave1Amp', 0.5, 15, 0.5)
    .name('Wave 1 amplitude').onChange(liveUpdate);
  waveFolder.add(params, 'wave1Period', 2, 20, 0.5)
    .name('Wave 1 period (s)').onChange(liveUpdate);
  waveFolder.add(params, 'waveVariation', 0, 1, 0.05)
    .name('Overtone strength').onChange(liveUpdate);
  waveFolder.add(params, 'waveSpread', 0, 30, 1)
    .name('Direction spread (°)').onChange(liveUpdate);
  waveFolder.add(params, 'waveNoiseMod', 0, 1, 0.05)
    .name('Modulation depth').onChange(liveUpdate);
  waveFolder.add(params, 'waveIntensity', 0, 3, 0.05)
    .name('Master intensity').onChange(liveUpdate);

  // ── Simulation ───────────────────────────────────────────────────────────────
  const simFolder = gui.addFolder('Simulation');
  simFolder.add(params, 'numParticles', 1000, 10000, 100)
    .name('Particles').onFinishChange(rebuild);
  simFolder.add(params, 'substeps', 1, 6, 1)
    .name('Substeps/frame').onChange(liveUpdate);
  simFolder.add(params, 'particleMassDisplay')
    .name('Particle mass').disable().listen();

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

  // ── Sand ─────────────────────────────────────────────────────────────────────
  const sandFolder = gui.addFolder('Sand');
  sandFolder.add(params, 'wetnessRate', 0.001, 0.02, 0.001)
    .name('Drying rate').onChange(liveUpdate);

  // ── Camera ───────────────────────────────────────────────────────────────────
  const cameraFolder = gui.addFolder('Camera');
  cameraFolder.add(params, 'cameraZoom', 0.5, 3.0, 0.1)
    .name('Zoom').onChange(liveUpdate);
  cameraFolder.add(params, 'sideView')
    .name('Side view');

  // ── Fluid ────────────────────────────────────────────────────────────────────
  const fluidFolder = gui.addFolder('Fluid');
  fluidFolder.add(params, 'gasConstant', 50, 500, 10)
    .name('Pressure k').onChange(liveUpdate);
  fluidFolder.add(params, 'viscosityCoeff', 50, 500, 10)
    .name('Viscosity μ').onChange(liveUpdate);
  fluidFolder.add(params, 'gravity', -20, 0, 0.5)
    .name('Gravity').onChange(liveUpdate);
  fluidFolder.add(params, 'beachFriction', 0.9, 1.0, 0.001)
    .name('Beach friction').onChange(liveUpdate);

  // ── Controls ─────────────────────────────────────────────────────────────────
  const ctrlFolder = gui.addFolder('Controls');
  ctrlFolder.add({ reset: rebuild }, 'reset').name('Reset simulation');
  ctrlFolder.add({ newTerrain: rebuildTerrain }, 'newTerrain').name('Rebuild terrain');
  ctrlFolder.add(params, 'paused').name('Pause');

  return gui;
}

// ─── Force Manager (left-side panel) ─────────────────────────────────────────

/**
 * Builds a secondary lil-gui panel anchored to the top-left of the screen.
 * Controls runtime forces injected into SPHSolver._integrate via liveUpdate.
 *
 * Expected params fields:
 *   driftForce  — submerged leftward drift, fraction of |gravity| (0–0.3)
 *   currentX    — constant X force on every particle (units/s²)
 *   currentZ    — constant Z force on every particle
 *   windX       — X force on above-waterline particles (surface wind)
 *
 * @param {object}   params
 * @param {Function} liveUpdate  — pushes params into the running solver
 * @returns {GUI}
 */
export function buildForceGUI(params, liveUpdate) {
  const gui = new GUI({ title: 'Force Manager', width: 240 });

  // Pin to top-left
  Object.assign(gui.domElement.style, {
    position:  'fixed',
    left:      '10px',
    top:       '10px',
    zIndex:    '100',
  });

  const driftFolder = gui.addFolder('Beach Drift');
  driftFolder.add(params, 'driftForce', 0, 0.3, 0.005)
    .name('Drift (×|g|)')
    .onChange(liveUpdate);

  const currentFolder = gui.addFolder('Ocean Current');
  currentFolder.add(params, 'currentX', -8, 8, 0.1)
    .name('← X →')
    .onChange(liveUpdate);
  currentFolder.add(params, 'currentZ', -8, 8, 0.1)
    .name('← Z →')
    .onChange(liveUpdate);

  const windFolder = gui.addFolder('Surface Wind');
  windFolder.add(params, 'windX', -8, 8, 0.1)
    .name('← Wind X →')
    .onChange(liveUpdate);

  gui.add({ resetForces() {
    params.driftForce = 0.05;
    params.currentX   = 0;
    params.currentZ   = 0;
    params.windX      = 0;
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    liveUpdate();
  }}, 'resetForces').name('Reset all forces');

  return gui;
}
