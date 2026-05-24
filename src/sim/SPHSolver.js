/**
 * SPHSolver — Smoothed Particle Hydrodynamics fluid simulation
 *
 * ─── The Big Idea ───────────────────────────────────────────────────────────
 * SPH represents the fluid as a cloud of particles.  Any field A(r) is
 * approximated as a weighted sum over nearby particles:
 *
 *   A(rᵢ) ≈ Σⱼ (mⱼ/ρⱼ) · Aⱼ · W(rᵢ − rⱼ, h)
 *
 * where W(r, h) is a smoothing kernel — zero past radius h, integrates to 1.
 *
 * ─── The Three Kernels ──────────────────────────────────────────────────────
 *
 * 1) Poly6   (smooth — used for DENSITY)
 *    W(r,h) = (315/64πh⁹) · (h²−r²)³          for r ≤ h
 *    Chosen because it has no singularity at r = 0.
 *
 * 2) Spiky   (used for PRESSURE GRADIENT)
 *    ∇W(r⃗,h) = −(45/πh⁶) · (h−r)² · r⃗/r     for r ≤ h
 *    Chosen because its gradient is non-zero all the way to r = 0.
 *    Poly6's gradient → 0 at origin, which would let particles overlap
 *    without repulsion — the spiky kernel prevents that.
 *
 * 3) Viscosity Laplacian  (used for VISCOSITY)
 *    ∇²W(r,h) = (45/πh⁶) · (h−r)             for r ≤ h
 *    Strictly positive everywhere → always diffuses momentum, never amplifies.
 *
 * ─── Force Model (Müller et al. 2003) ───────────────────────────────────────
 *
 *   ρᵢ = Σⱼ m · W_poly6(|rᵢ−rⱼ|)                      density
 *   pᵢ = k · (ρᵢ − ρ₀)                                  EOS (negative p = cohesion)
 *   fᵢᵖ = −Σⱼ m·(pᵢ+pⱼ)/(2ρⱼ) · ∇W_spiky              pressure (force density)
 *   fᵢᵛ =  μ · Σⱼ m·(vⱼ−vᵢ)/ρⱼ · ∇²W_visc             viscosity (force density)
 *   a   = (fᵖ + fᵛ)/ρᵢ + g̃                             acceleration
 *
 * ─── Integration (Symplectic Euler) ─────────────────────────────────────────
 *   v' = v + a·Δt
 *   r' = r + v'·Δt   ← uses the updated v, not the old one
 *
 * ─── Ocean Simulation (Phase 3+) ────────────────────────────────────────────
 *
 * WAVE FIELD (bottom of domain, high Z):
 *   Field-based wave forcing applied to surface particles whose Z > waveZoneZ.
 *   Five sine waves summed (Phillips spectrum), primary direction −Z (toward beach).
 *   Taper: alpha² decays force smoothly toward waveZoneZ boundary.
 *
 * TERRAIN COLLISION (callback-driven floor):
 *   cfg.terrainFn(x, z) returns the floor height at any world position.
 *   _floorHeight delegates to it; falls back to flat boundsMin[1] if null.
 *   Floor collision uses 3D finite-difference normal so particles slide
 *   down-slope back into the ocean under gravity.
 *
 * BOUNDARIES (portrait domain: 60 × 15 × 100 world units):
 *     X walls (±30):              reflective side walls
 *     BOTTOM (z > +50):           hard reflect — ocean / wave-zone wall
 *     TOP    (z < −50):           hard reflect — beach overshoot wall
 *     CEILING (y > +10):          hard reflect
 *     FLOOR:                      slope-normal collision via _floorHeight
 */

import { SpatialHash } from './SpatialHash.js';

// ─── Parameters ───────────────────────────────────────────────────────────────

/**
 * User-facing default parameters for the ocean simulation stage.
 *
 * particleMass is NOT listed here — it is auto-derived in computeDerivedConfig
 * from restDensity, the fill volume, and numParticles.  Any time numParticles
 * changes, particleMass recalculates automatically.
 *
 * Domain: 100 units wide (X), 15 units tall (Y), 60 units deep (Z).
 * Water fills from boundsMin[0] to the terrain waterline crossing (derived
 * from slopeAngleDeg in computeDerivedConfig).
 *
 * terrainFn: injected by main.js.  Signature: (x, z) => floorY.
 */
export const DEFAULT_PARAMS = {
  numParticles: 5000,

  // SPH kernel
  smoothingRadius:   1.5,
  restDensity:       1000,
  gasConstant:       140,
  viscosityCoeff:    300,
  gravity:          -9.8,

  // Integration
  timeStep:    0.005,
  substeps:    3,
  wallDamping: 0.4,

  // Domain — 100 × 15 × 60 world units  (landscape: wide X, shallow Z)
  boundsMin: [-50, -5, -30],
  boundsMax: [ 50, 10,  30],

  // Global terrain slope (bottom=low, top=high along Z).
  // computeDerivedConfig derives waterlineZ from this.
  slopeAngleDeg: 4,

  // ── Multi-frequency wave field ────────────────────────────────────────────
  // Dominant wave
  wave1Amp:      5.0,   // amplitude of the primary wave (world units)
  wave1Period:   8.0,   // period of the primary wave (seconds)
  // Overtone control
  waveVariation: 0.5,   // scale for waves 2-5 (0 = flat, 1 = full spectrum)
  waveSpread:    15,    // max angle deviation from +X (degrees)
  // Slow amplitude modulation (creates "wave sets")
  waveNoiseMod:  0.3,   // modulation depth (0 = steady, 1 = strong variation)
  // Master
  waveIntensity: 1.0,   // overall multiplier

  // Surface detection: wave force applied only to particles that have fewer
  // than this many neighbors strictly above them (y_j > y_i + 0.3h).
  // These are computed for free during the density pass using the existing hash.
  // Lower value → only the very top particles get force (sharp surface).
  // Higher value → thicker "surface layer" gets force.
  surfaceNeighborThreshold: 3,

  // Per-step friction where floor is above the waterline
  beachFriction: 0.998,

  recycleSpeedThreshold: 0.45,

  // ── Configurable forces (Force Manager GUI) ───────────────────────────────
  // Applied each integration step on top of gravity + SPH forces.
  driftForce:  0.05,  // submerged leftward drift, fraction of |g| (−X)
  currentX:    0,     // constant X force on all particles (units/s²)
  currentZ:    0,     // constant Z force on all particles
  windX:       0,     // X force applied only above waterline (surface wind)

  // Injected by main.js once the terrain is built.
  // Signature: (x: number, z: number) => number (floor Y).
  terrainFn: null,
};

/**
 * Adds derived scalar fields required by SPHSolver._integrate and
 * _computeDensityPressure/_computeForces.
 *
 * Derived fields:
 *   waveMakerFreq  = 1 / waveMakerPeriod
 *   particleMass   = restDensity * fillVolume / numParticles
 *
 * fillVolume is the approximate submerged volume (triangular prism):
 *   X-width  = waterlineX − boundsMin[0]    (ocean zone)
 *   Y-depth  = |boundsMin[1]|               (seabed to surface, boundsMin[1]<0)
 *   Z-extent = boundsMax[2] − boundsMin[2]
 *
 * Recalculating here means changing numParticles (or any geometry param)
 * automatically yields the correct rest-density mass — no hardcoding needed.
 *
 * @param {object} p - User-facing parameter object (DEFAULT_PARAMS or subset)
 * @returns {object} Complete config including all derived fields
 */
export function computeDerivedConfig(p) {
  // Z where the sloped floor crosses y=0 (the waterline).
  // terrainFn(x,z) ≈ boundsMin[1] + tan(slope)*(boundsMax[2] - z)
  // Setting = 0 → z = boundsMax[2] - |boundsMin[1]| / tan(slope)
  const slopeTan    = Math.tan(((p.slopeAngleDeg || 4) * Math.PI) / 180);
  const waterlineZ  = Math.max(
    p.boundsMax[2] - Math.abs(p.boundsMin[1]) / slopeTan,
    p.boundsMin[2],
  );

  // Fill volume: triangular prism from waterlineZ to boundsMax[2], full X extent.
  // Average depth = |boundsMin[1]| / 2 (floor rises linearly from boundsMin[1] to 0).
  const waterDepth  = p.boundsMax[2] - waterlineZ;
  const avgDepth    = Math.abs(p.boundsMin[1]) / 2;
  const fillVolume  = waterDepth * avgDepth * (p.boundsMax[0] - p.boundsMin[0]);

  const particleMass = p.restDensity * fillVolume / p.numParticles;

  return { ...p, particleMass, waterlineZ };
}

// Convenience re-export so existing imports of CONFIG still work.
export const CONFIG = computeDerivedConfig(DEFAULT_PARAMS);

// ─── SPHSolver ────────────────────────────────────────────────────────────────

export class SPHSolver {
  constructor(cfg = {}) {
    this.cfg = computeDerivedConfig({ ...DEFAULT_PARAMS, ...cfg });
    const { numParticles: N, smoothingRadius: h } = this.cfg;

    // Particle state (flat TypedArrays — cache-friendly, GC-free)
    this.positions    = new Float32Array(N * 3);
    this.velocities   = new Float32Array(N * 3);
    this.densities    = new Float32Array(N);
    this.pressures    = new Float32Array(N);
    this._forces      = new Float32Array(N * 3);
    // 1 = surface particle (few neighbors above), 0 = buried.
    // Written each step during _computeDensityPressure, read in _integrate.
    this._surfaceFlags = new Uint8Array(N);

    // Kernel constants for h = 1.5
    // The kernel formulae are unchanged from the original; only h differs.
    //   Poly6 coeff:     315 / (64 π h⁹)
    //   Spiky grad coeff: −45 / (π h⁶)
    //   Visc lap coeff:    45 / (π h⁶)
    const h2 = h * h, h3 = h2 * h, h6 = h3 * h3, h9 = h6 * h3;
    this._poly6Coeff     =  315.0 / (64.0 * Math.PI * h9);
    this._spikyGradCoeff = -45.0  / (Math.PI * h6);
    this._viscLapCoeff   =  45.0  / (Math.PI * h6);
    this._h2 = h2;

    // SpatialHash with h = 1.5 and N = 3000.
    // Grid cells are 1.5 units. Domain 100×15×60 → ~67×10×40 ≈ 26,800 cells.
    // FNV-1a hash in SpatialHash.js handles this without modification.
    this._hash      = new SpatialHash(h, N);
    this._neighbors = [];
    this._time      = 0.0;

    this._initParticles();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  step() {
    this._buildHash();
    this._computeDensityPressure();
    this._computeForces();
    this._integrate();
    this._time += this.cfg.timeStep;
  }

  // ── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Place all N particles in a regular grid inside the initial water volume:
   *   X: [boundsMin[0]+h, waterlineX−h]
   *   Y: [boundsMin[1]+h, 0]
   *   Z: [boundsMin[2]+h, boundsMax[2]−h]
   *
   * Grid spacing is chosen so N particles fill the volume at uniform density.
   * A small jitter breaks the lattice symmetry (prevents pressure resonance).
   * Any particles that couldn't be placed on the grid are scattered randomly
   * in the same volume.
   */
  _initParticles() {
    const { numParticles: N, smoothingRadius: h,
            boundsMin, boundsMax, waterlineZ } = this.cfg;
    const pos = this.positions;

    const x0 = boundsMin[0] + h,  x1 = boundsMax[0] - h;
    const y0 = boundsMin[1] + h,  y1 = 0.0;
    const z0 = waterlineZ  + h,   z1 = boundsMax[2] - h;
    const volX = x1 - x0, volY = y1 - y0, volZ = z1 - z0;
    const spacing = Math.cbrt(volX * volY * volZ / N) * 0.97;

    let count = 0;
    outer:
    for (let ix = 0; x0 + spacing * ix <= x1; ix++) {
      for (let iy = 0; y0 + spacing * iy <= y1; iy++) {
        for (let iz = 0; z0 + spacing * iz <= z1; iz++) {
          if (count >= N) break outer;
          const jitter = spacing * 0.08;
          pos[3*count    ] = x0 + spacing*ix + (Math.random()-0.5)*jitter;
          pos[3*count + 1] = y0 + spacing*iy + (Math.random()-0.5)*jitter;
          pos[3*count + 2] = z0 + spacing*iz + (Math.random()-0.5)*jitter;
          count++;
        }
      }
    }
    // Fallback: scatter remaining particles randomly in the water volume
    while (count < N) {
      pos[3*count    ] = x0 + Math.random() * volX;
      pos[3*count + 1] = y0 + Math.random() * volY;
      pos[3*count + 2] = z0 + Math.random() * volZ;
      count++;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Floor height at world (x, z). Delegates to cfg.terrainFn if set. */
  _floorHeight(x, z) {
    if (this.cfg.terrainFn) return this.cfg.terrainFn(x, z);
    return this.cfg.boundsMin[1];
  }

  /**
   * Teleport particle i back to the deep-water reservoir.
   * Used when a particle escapes the open-ocean edges or strands on the beach.
   *
   * Reservoir zone (bottom strip of the domain, fully submerged):
   *   X: [boundsMin[0]+h, boundsMax[0]−h]
   *   Y: [boundsMin[1]+h, -1]
   *   Z: [boundsMax[2]−15, boundsMax[2]−h]  (ocean bottom strip)
   */
  _resetToReservoir(i) {
    const { boundsMin, boundsMax, smoothingRadius: h } = this.cfg;
    this.positions[3*i    ] = boundsMin[0] + h + Math.random() * (boundsMax[0] - boundsMin[0] - 2*h);
    this.positions[3*i + 1] = boundsMin[1] + h + Math.random() * (Math.abs(boundsMin[1]) - h - 1.0);
    this.positions[3*i + 2] = boundsMax[2] - 15 + Math.random() * (15 - h);
    this.velocities[3*i    ] = 0;
    this.velocities[3*i + 1] = 0;
    this.velocities[3*i + 2] = 0;
  }

  // ── SPH steps ───────────────────────────────────────────────────────────────

  _buildHash() {
    const { numParticles: N } = this.cfg;
    const pos  = this.positions;
    const hash = this._hash;
    hash.clear();
    for (let i = 0; i < N; i++) hash.insert(i, pos[3*i], pos[3*i+1], pos[3*i+2]);
  }

  /**
   * Density (Poly6) and pressure (EOS).
   *
   *   ρᵢ = Σⱼ m · (315/64πh⁹) · (h²−r²)³
   *   pᵢ = k · (ρᵢ − ρ₀)
   *
   * particleMass is read from cfg — it was derived in computeDerivedConfig
   * from restDensity * fillVolume / numParticles, so changing numParticles
   * automatically maintains correct rest density without hardcoding.
   */
  _computeDensityPressure() {
    const { numParticles: N, restDensity: rho0,
            gasConstant: k, particleMass: m,
            smoothingRadius: h, surfaceNeighborThreshold } = this.cfg;
    const pos   = this.positions;
    const den   = this.densities;
    const pre   = this.pressures;
    const flags = this._surfaceFlags;
    const h2    = this._h2;
    const c     = this._poly6Coeff;
    const nb    = this._neighbors;

    // A neighbor counts as "above" if its Y exceeds ours by at least 0.3h.
    // This gap prevents lateral particles at almost the same height from
    // being counted as overhead and burying a true surface particle.
    const aboveDelta = h * 0.3;

    for (let i = 0; i < N; i++) {
      const xi = pos[3*i], yi = pos[3*i+1], zi = pos[3*i+2];
      this._hash.query(xi, yi, zi, nb);

      let rho        = 0.0;
      let aboveCount = 0;
      const yThresh  = yi + aboveDelta; // neighbor must exceed this Y to count as above

      for (let ni = 0; ni < nb.length; ni++) {
        const j  = nb[ni];
        const dx = xi - pos[3*j];
        const dy = yi - pos[3*j+1];
        const dz = zi - pos[3*j+2];
        const r2 = dx*dx + dy*dy + dz*dz;

        if (r2 < h2) {
          const q = h2 - r2;
          rho += m * c * q*q*q;
          // Count neighbors that are meaningfully above this particle
          if (pos[3*j+1] > yThresh) aboveCount++;
        }
      }

      den[i]   = Math.max(rho, 1.0);
      pre[i]   = k * (den[i] - rho0);
      // Surface if fewer than threshold neighbors are above — works regardless
      // of absolute Y, so buried particles in deep piles are correctly identified.
      flags[i] = aboveCount < surfaceNeighborThreshold ? 1 : 0;
    }
  }

  /**
   * Pressure + viscosity forces (Müller 2003 equations 10 & 14).
   *
   * Pressure:   fᵢᵖ = −Σⱼ m·(pᵢ+pⱼ)/(2ρⱼ)·∇W_spiky
   * Viscosity:  fᵢᵛ =  μ·Σⱼ m·(vⱼ−vᵢ)/ρⱼ·∇²W_visc
   */
  _computeForces() {
    const { numParticles: N, smoothingRadius: h,
            viscosityCoeff: mu, particleMass: m } = this.cfg;
    const pos  = this.positions;
    const vel  = this.velocities;
    const den  = this.densities;
    const pre  = this.pressures;
    const f    = this._forces;
    const nb   = this._neighbors;
    const sGC  = this._spikyGradCoeff;
    const vLC  = this._viscLapCoeff;
    const h2   = this._h2;

    for (let i = 0; i < N; i++) {
      const xi  = pos[3*i],   yi  = pos[3*i+1], zi  = pos[3*i+2];
      const vxi = vel[3*i],   vyi = vel[3*i+1], vzi = vel[3*i+2];
      const rhoI = den[i], preI = pre[i];
      let fpx=0, fpy=0, fpz=0, fvx=0, fvy=0, fvz=0;

      this._hash.query(xi, yi, zi, nb);

      for (let ni = 0; ni < nb.length; ni++) {
        const j = nb[ni];
        if (j === i) continue;
        const dx = xi-pos[3*j], dy = yi-pos[3*j+1], dz = zi-pos[3*j+2];
        const r2 = dx*dx + dy*dy + dz*dz;
        if (r2 >= h2 || r2 < 1e-10) continue;

        const r    = Math.sqrt(r2);
        const rhoJ = den[j];

        const pt = m * (preI + pre[j]) / (2.0 * rhoJ);
        const sw = sGC * (h - r) * (h - r) / r;
        fpx -= pt * sw * dx;
        fpy -= pt * sw * dy;
        fpz -= pt * sw * dz;

        const vf = mu * m * vLC * (h - r) / rhoJ;
        fvx += vf * (vel[3*j]   - vxi);
        fvy += vf * (vel[3*j+1] - vyi);
        fvz += vf * (vel[3*j+2] - vzi);
      }

      f[3*i]   = fpx + fvx;
      f[3*i+1] = fpy + fvy;
      f[3*i+2] = fpz + fvz;
    }
  }

  /**
   * Integration + boundary conditions (portrait-orientation ocean simulation).
   *
   * Domain: X ∈ [−30, +30], Y ∈ [−5, +10], Z ∈ [−50, +50].
   * Waves travel in −Z direction (screen bottom → top).
   * Beach is at low Z (screen top); open ocean at high Z (screen bottom).
   *
   * Boundary summary:
   *
   * 1. X WALLS (x < −30 or x > +30): reflective — these are the side walls.
   *
   * 2. BOTTOM Z WALL (z > +50): hard reflect — ocean boundary, wave zone.
   *
   * 3. TOP Z WALL (z < −50): hard reflect — particles that overshoot the beach.
   *
   * 4. FLOOR — terrain collision:
   *    _floorHeight via cfg.terrainFn; 3D finite-difference normal so
   *    particles slide down-slope back toward the ocean.
   *
   * 5. CEILING (y > boundsMax[1] = +10): hard reflect.
   *
   * 6. SAFETY CLAMP.
   *
   * 7. BEACH RECYCLE: particles stranded on high dry ground (z < waterlineZ)
   *    with near-zero speed teleport to the deep-water reservoir.
   */
  _integrate() {
    const { numParticles: N, timeStep: dt, gravity: g,
            wallDamping, boundsMin, boundsMax,
            wave1Amp, wave1Period, waveVariation, waveSpread,
            waveNoiseMod, waveIntensity,
            waterlineZ,
            beachFriction, recycleSpeedThreshold,
            driftForce, currentX, currentZ, windX } = this.cfg;
    const pos = this.positions;
    const vel = this.velocities;
    const den = this.densities;
    const f   = this._forces;
    const t   = this._time;
    const TWO_PI = 2.0 * Math.PI;

    // ── WAVE FIELD — precompute per substep ───────────────────────────────────
    //
    // Five sine waves summed (Phillips-spectrum-inspired amplitudes):
    //   A_i ≈ A1 · (T_i/T1)²  — longer periods carry more energy
    //
    // Each wave has:
    //   ω_i  = 2π / T_i                      angular frequency
    //   k_i  = ω_i² / |g|                    wavenumber (deep-water dispersion)
    //   θ_i  = angleRatio_i · waveSpread      direction from +X
    //   kx_i = k_i cos(θ_i),  kz_i = k_i sin(θ_i)
    //
    // Per-particle horizontal acceleration (wave orbital motion):
    //   F_x += A_eff · ω² · cos(kx·x + kz·z − ω·t + φ) · exp(k·y) · cos(θ) · taper
    //   F_z += …                                                      · sin(θ) · taper
    //
    // taper = ((zoneEdge − px) / zoneWidth)²   decays force toward zone boundary.
    // exp(k·y): evanescent decay — surface particles feel full force, deep ones less.
    // Modulation: slow sin at ~15 s creates natural "wave set" variation.

    const absG        = Math.abs(g);
    const DEG2RAD     = Math.PI / 180;
    const domainD     = boundsMax[2] - boundsMin[2];      // 100 units
    const waveZoneZ   = boundsMax[2] - 0.15 * domainD;   // +35 for default domain
    const waveZoneW   = boundsMax[2] - waveZoneZ;         // 15 units

    // Fixed wave shape constants
    const PERIOD_RATIOS  = [1.0,  0.625, 0.4375, 0.3125, 0.225];
    const ANGLE_RATIOS   = [0.0,  0.33, -0.53,   0.80,  -0.87];
    const MOD_PERIODS    = [15.7, 17.3,  13.1,   19.4,  11.2];
    const PHASE_OFFSETS  = [0.0,  1.2,   2.4,    0.8,   3.1];

    // Per-wave derived values (5 waves, flat locals — no heap allocation)
    let w0om, w1om, w2om, w3om, w4om;
    let w0kx, w1kx, w2kx, w3kx, w4kx;
    let w0kz, w1kz, w2kz, w3kz, w4kz;
    let w0ea, w1ea, w2ea, w3ea, w4ea;
    let w0k,  w1k,  w2k,  w3k,  w4k;

    for (let w = 0; w < 5; w++) {
      const period   = wave1Period * PERIOD_RATIOS[w];
      const omega    = TWO_PI / period;
      const k        = omega * omega / absG;
      const theta    = ANGLE_RATIOS[w] * waveSpread * DEG2RAD;
      // Phillips amplitude: A_i = A1 * (T_i/T1)^2 for overtones
      const ampRatio = PERIOD_RATIOS[w] * PERIOD_RATIOS[w];
      const baseAmp  = w === 0
        ? wave1Amp
        : wave1Amp * ampRatio * waveVariation;
      // Slow modulation — creates wave sets
      const modPhase = TWO_PI * t / MOD_PERIODS[w] + w * 2.1;
      const mod      = 1.0 + waveNoiseMod * Math.sin(modPhase);
      const effAmp   = baseAmp * mod * waveIntensity;

      switch (w) {
        case 0: w0om=omega; w0k=k; w0kx=k*Math.sin(theta); w0kz=-k*Math.cos(theta); w0ea=effAmp; break;
        case 1: w1om=omega; w1k=k; w1kx=k*Math.sin(theta); w1kz=-k*Math.cos(theta); w1ea=effAmp; break;
        case 2: w2om=omega; w2k=k; w2kx=k*Math.sin(theta); w2kz=-k*Math.cos(theta); w2ea=effAmp; break;
        case 3: w3om=omega; w3k=k; w3kx=k*Math.sin(theta); w3kz=-k*Math.cos(theta); w3ea=effAmp; break;
        case 4: w4om=omega; w4k=k; w4kx=k*Math.sin(theta); w4kz=-k*Math.cos(theta); w4ea=effAmp; break;
      }
    }

    for (let i = 0; i < N; i++) {
      const invRho = 1.0 / den[i];

      // Acceleration: SPH forces / ρ  +  gravity  +  wave field  +  Force Manager
      const px = pos[3*i], py = pos[3*i + 1], pz = pos[3*i + 2];
      const submerged = py < 0;
      const driftZ = submerged ? -absG * driftForce : 0;
      const windFx = submerged ? 0 : windX;

      // Wave field — applied in the bottom 15% of the domain (+Z edge)
      let wfx = 0, wfy = 0, wfz = 0;
      if (pz > waveZoneZ) {
        const alpha = (pz - waveZoneZ) / waveZoneW;
        const taper = alpha * alpha;

        // ── Horizontal component: cos() — drives X/Z orbital motion ──────
        const f0 = w0ea * w0om * w0om * Math.cos(w0kx*px + w0kz*pz - w0om*t + PHASE_OFFSETS[0]) * taper;
        const f1 = w1ea * w1om * w1om * Math.cos(w1kx*px + w1kz*pz - w1om*t + PHASE_OFFSETS[1]) * taper;
        const f2 = w2ea * w2om * w2om * Math.cos(w2kx*px + w2kz*pz - w2om*t + PHASE_OFFSETS[2]) * taper;
        const f3 = w3ea * w3om * w3om * Math.cos(w3kx*px + w3kz*pz - w3om*t + PHASE_OFFSETS[3]) * taper;
        const f4 = w4ea * w4om * w4om * Math.cos(w4kx*px + w4kz*pz - w4om*t + PHASE_OFFSETS[4]) * taper;
        wfx = f0*(w0kx/(w0k+1e-8)) + f1*(w1kx/(w1k+1e-8)) + f2*(w2kx/(w2k+1e-8)) + f3*(w3kx/(w3k+1e-8)) + f4*(w4kx/(w4k+1e-8));
        wfz = f0*(w0kz/(w0k+1e-8)) + f1*(w1kz/(w1k+1e-8)) + f2*(w2kz/(w2k+1e-8)) + f3*(w3kz/(w3k+1e-8)) + f4*(w4kz/(w4k+1e-8));

        // ── Vertical component: sin() — directly lifts/lowers surface ────
        // 90° phase-shifted from horizontal (linear wave orbital motion).
        // This is what was missing: without it the wave force is purely
        // horizontal, viscosity damps the pressure-driven vertical response,
        // and particles never actually elevate at wave crests.
        // Scale 0.6× horizontal to avoid excessive bouncing while still
        // producing clear Y displacement the density buffer can detect.
        wfy = (w0ea * w0om * w0om * Math.sin(w0kx*px + w0kz*pz - w0om*t + PHASE_OFFSETS[0])
             + w1ea * w1om * w1om * Math.sin(w1kx*px + w1kz*pz - w1om*t + PHASE_OFFSETS[1])
             + w2ea * w2om * w2om * Math.sin(w2kx*px + w2kz*pz - w2om*t + PHASE_OFFSETS[2])
             + w3ea * w3om * w3om * Math.sin(w3kx*px + w3kz*pz - w3om*t + PHASE_OFFSETS[3])
             + w4ea * w4om * w4om * Math.sin(w4kx*px + w4kz*pz - w4om*t + PHASE_OFFSETS[4])
             ) * taper * 0.6;

        // ── Surface detection gate ────────────────────────────────────────
        // Only surface particles (few neighbors above) receive direct wave
        // force. Buried particles get zero — wave energy reaches them via
        // SPH pressure/viscosity from the surface layer.
        if (!this._surfaceFlags[i]) {
          wfx = 0; wfy = 0; wfz = 0;
        }
      }

      const ax = f[3*i    ] * invRho + currentX + windFx + wfx;
      const ay = f[3*i + 1] * invRho + g + wfy;
      const az = f[3*i + 2] * invRho + currentZ + driftZ + wfz;

      // Symplectic Euler: update v first, then r with the new v
      vel[3*i    ] += ax * dt;
      vel[3*i + 1] += ay * dt;
      vel[3*i + 2] += az * dt;
      pos[3*i    ] += vel[3*i    ] * dt;
      pos[3*i + 1] += vel[3*i + 1] * dt;
      pos[3*i + 2] += vel[3*i + 2] * dt;

      // ── X WALLS: reflective boundaries ───────────────────────────────
      if (pos[3*i] < boundsMin[0]) {
        pos[3*i] = boundsMin[0] + 1e-4;
        vel[3*i] = Math.abs(vel[3*i]) * wallDamping;
      }
      if (pos[3*i] > boundsMax[0]) {
        pos[3*i] = boundsMax[0] - 1e-4;
        vel[3*i] = -Math.abs(vel[3*i]) * wallDamping;
      }

      // ── FLOOR: terrain collision via _floorHeight(x, z) ─────────────
      const floorY = this._floorHeight(px, pz);
      if (pos[3*i + 1] < floorY) {
        pos[3*i + 1] = floorY + 1e-4;

        // 3D slope normal via finite differences — lets particles slide
        // down-slope back into the ocean instead of bouncing straight up.
        const eps = 0.5;
        const dhx = (this._floorHeight(px + eps, pz) - this._floorHeight(px - eps, pz)) / (2 * eps);
        const dhz = (this._floorHeight(px, pz + eps) - this._floorHeight(px, pz - eps)) / (2 * eps);
        const nLen = Math.sqrt(dhx * dhx + 1 + dhz * dhz);
        const nx = -dhx / nLen, ny = 1 / nLen, nz = -dhz / nLen;

        const vDotN = vel[3*i] * nx + vel[3*i+1] * ny + vel[3*i+2] * nz;
        if (vDotN < 0) {
          const imp = (1 + wallDamping) * vDotN;
          vel[3*i    ] -= imp * nx;
          vel[3*i + 1] -= imp * ny;
          vel[3*i + 2] -= imp * nz;
        }
        vel[3*i    ] *= beachFriction;
        vel[3*i + 1] *= beachFriction;
        vel[3*i + 2] *= beachFriction;
      }

      // ── CEILING: hard reflect ─────────────────────────────────────────
      if (pos[3*i + 1] > boundsMax[1]) {
        pos[3*i + 1] = boundsMax[1] - 1e-4;
        vel[3*i + 1] = -Math.abs(vel[3*i + 1]) * wallDamping;
      }

      // ── BOTTOM Z WALL (ocean, +Z): hard reflect ───────────────────────
      if (pos[3*i + 2] > boundsMax[2]) {
        pos[3*i + 2] = boundsMax[2] - 1e-4;
        vel[3*i + 2] = -Math.abs(vel[3*i + 2]) * wallDamping;
      }
      // ── TOP Z WALL (beach approach, -Z): hard reflect ─────────────────
      if (pos[3*i + 2] < boundsMin[2]) {
        pos[3*i + 2] = boundsMin[2] + 1e-4;
        vel[3*i + 2] = Math.abs(vel[3*i + 2]) * wallDamping;
      }

      // ── SAFETY CLAMP — catch any particle that still escaped ──────────
      pos[3*i    ] = Math.max(boundsMin[0], Math.min(boundsMax[0], pos[3*i    ]));
      pos[3*i + 1] = Math.max(boundsMin[1], Math.min(boundsMax[1], pos[3*i + 1]));
      pos[3*i + 2] = Math.max(boundsMin[2], Math.min(boundsMax[2], pos[3*i + 2]));

      // ── RECYCLE truly stranded particles ─────────────────────────────
      // The sloped terrain should drain most particles back under gravity.
      // Recycle only if: floor is above waterline (dry sand) AND particle
      // is resting on the floor AND essentially stopped — prevents permanent
      // accumulation at the far-right high ground.
      const floorHere = this._floorHeight(pos[3*i], pos[3*i + 2]);
      if (floorHere > 0.5 && pos[3*i + 1] <= floorHere + 0.4) {
        const vx = vel[3*i], vy = vel[3*i+1], vz = vel[3*i+2];
        if (vx*vx + vy*vy + vz*vz < recycleSpeedThreshold * recycleSpeedThreshold) {
          this._resetToReservoir(i);
        }
      }
    }
  }
}
