# Shuttlecock Simulator — Phase 1: SPH Fluid Foundation

A real-time 3-D fluid simulation using Smoothed Particle Hydrodynamics (SPH),
rendered with Three.js.  1 500 particles fall under gravity, settle into a box,
and behave like water — surface forms, particles resist compression, viscosity
diffuses momentum.

---

## Quick start

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (usually `http://localhost:5173`).

**Controls:** left-drag to orbit, scroll to zoom, right-drag to pan.
The FPS counter is in the top-left corner.

---

## Project structure

```
src/
  main.js                    Scene setup, lighting, animation loop
  sim/
    SPHSolver.js             Physics: density, pressure, viscosity, gravity
    SpatialHash.js           O(k) neighbour search via uniform grid hashing
  render/
    ParticleRenderer.js      Three.js InstancedMesh + velocity colour mapping
```

---

## SPH parameters

All physics knobs live at the top of `src/sim/SPHSolver.js` in the `CONFIG`
object.  Here is what each one does and how to tune it.

| Parameter | Default | Effect |
|-----------|---------|--------|
| `numParticles` | 1500 | More = denser fluid, higher CPU cost. Stays interactive up to ~3000 on modern hardware. |
| `smoothingRadius` h | 0.3 | Kernel support radius. Determines neighbourhood size. Larger h = smoother but more expensive (27-cell search doesn't change, but more particles fall inside each cell). |
| `restDensity` ρ₀ | 1000 | Target equilibrium density. Pressure = 0 when ρ = ρ₀. Rule of thumb: set `particleMass = ρ₀ × V_fill / N` so the initial pack starts near rest. |
| `gasConstant` k | 200 | Pressure stiffness. Higher k → less compressible (water-like) but needs smaller `timeStep` to stay stable. CFL guide: `Δt < h / √k`. |
| `viscosityCoeff` μ | 250 | Dynamic viscosity. Higher = thicker (honey). Lower = more splashy. Setting it too low causes high-frequency noise. |
| `gravity` g | −9.8 | Gravitational acceleration (m/s² equivalent). Reduce to −2 for slow-motion aesthetics. |
| `particleMass` m | 6.0 | Per-particle mass. Derived as `ρ₀ × V_fill / N`. Changing this shifts the rest density; if you change `restDensity` also change this. |
| `timeStep` Δt | 0.005 | Integration step size. Halve this if the sim explodes (particles fly apart). Double it (carefully) for a cheaper sim. |
| `substeps` | 3 | Physics steps per rendered frame. Increase for more stable simulations at a higher `gasConstant`. |
| `wallDamping` e | 0.5 | Energy kept after each wall bounce. 1.0 = elastic (bouncy), 0.0 = inelastic (particles stick). |

---

## The maths, interview-ready

### Kernel approximation

Any field `A(r)` is approximated as a weighted sum:

```
A(rᵢ) ≈ Σⱼ  (mⱼ / ρⱼ) · Aⱼ · W(rᵢ − rⱼ, h)
```

`W` is a smoothing kernel — a radially-symmetric function that integrates to 1
over all space and is zero outside radius `h`.

### Poly6 kernel (density)

```
W(r, h) = (315 / 64π h⁹) · (h² − r²)³    for r ≤ h, else 0
```

Used for density because it is smooth and has no singularity at `r = 0`.

### Spiky kernel (pressure gradient)

```
W(r, h)  = (15 / π h⁶) · (h − r)³
∇W(r⃗, h) = −(45 / π h⁶) · (h − r)² · r⃗/r
```

Used for pressure because its gradient is nonzero all the way to `r = 0`.
The Poly6 gradient collapses to zero at the origin — two coincident particles
would feel no repulsion, causing unphysical clumping.

### Viscosity kernel Laplacian

```
∇²W(r, h) = (45 / π h⁶) · (h − r)
```

Strictly positive everywhere — required so viscosity always *diffuses*
momentum (never anti-diffuses).

### Density and equation of state

```
ρᵢ = Σⱼ m · W_poly6(|rᵢ − rⱼ|, h)
pᵢ = k · (ρᵢ − ρ₀)
```

Negative pressure when `ρ < ρ₀` gives a surface-tension–like effect — the
fluid pulls itself together at free surfaces.

### Force densities (N/m³)

```
fᵢᵖ = −Σⱼ m · (pᵢ + pⱼ)/(2ρⱼ) · ∇W_spiky(rᵢ − rⱼ)   [pressure]
fᵢᵛ =  μ · Σⱼ m · (vⱼ − vᵢ)/ρⱼ  · ∇²W_visc(|rᵢ − rⱼ|) [viscosity]
```

Acceleration: `a = (fᵖ + fᵛ) / ρᵢ  +  g`

### Spatial hashing

Naïve O(N²) neighbour search: for 1 500 particles that is 2.25 M pair
checks per substep × 3 substeps × 60 fps = 405 M checks/s — too slow.

The spatial hash divides space into cells of side `h`.  Each particle maps
to one cell.  To find neighbours we query only the 27 cells in the
3×3×3 block around the query point.  For ~15 expected neighbours this is
orders of magnitude faster.

Hash function (FNV-1a inspired):
```
hash(ix, iy, iz):
  h = FNV_OFFSET
  h = imul(h XOR (ix & 0xFFFF), FNV_PRIME)
  h = imul(h XOR (iy & 0xFFFF), FNV_PRIME)
  h = imul(h XOR (iz & 0xFFFF), FNV_PRIME)
  return h % tableSize
```

Collision resolution is a linked list stored in two flat `Int32Array`s —
zero heap allocation per frame.

### Integration (symplectic Euler)

```
v(t+Δt) = v(t) + a · Δt
r(t+Δt) = r(t) + v(t+Δt) · Δt   ← uses UPDATED velocity
```

Using the new velocity for the position update makes the integrator
*symplectic* (area-preserving in phase space).  It conserves a discrete
Hamiltonian, so the simulation doesn't drift toward infinite energy over
long runs — unlike explicit (forward) Euler.

---

## Phase roadmap

- **Phase 1 (this)** — SPH solver, box container, basic rendering
- **Phase 2** — Ocean surface mesh, wave forces, open water boundary
- **Phase 3** — Shuttlecocks: rigid body, buoyancy, drag
- **Phase 4** — Cursor interaction (force field), visual polish
