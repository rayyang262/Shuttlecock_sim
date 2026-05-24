/**
 * FluidRenderer.js — Screen-Space Fluid Rendering
 *
 * Replaces visible particle spheres with a continuous water surface.
 * Built incrementally in steps:
 *
 *   Step 1 (done): Density buffer → raw Gaussian splat accumulation
 *   Step 2 (done): Separable Gaussian blur on density buffer
 *   Step 3 (done): Threshold + flat water colour composite over scene
 *   Step 4 (current): Depth colour, density-gradient normals, specular highlights, edge foam
 *   Step 4: Depth/velocity colour variation
 *   Step 5: Foam at edges
 *
 * ─── Pipeline ───────────────────────────────────────────────────────────────
 *
 *  Solver positions (world space)
 *        │
 *        ▼
 *  [Splat Pass]   render N Gaussian circles → densityRT (R channel, additive)
 *        │
 *        ▼
 *  [Blur H Pass]  17-tap horizontal Gaussian blur → blurHRT
 *        │
 *        ▼
 *  [Blur V Pass]  17-tap vertical Gaussian blur   → blurRT  (final smooth field)
 *        │
 *        ▼
 *  [Water Pass]   full-screen alpha-blended water colour composite (Step 3)
 *  [Debug Pass]   full-screen grayscale composite of blurRT (optional override)
 */

import * as THREE from 'three';

// ─── Constants ────────────────────────────────────────────────────────────────

const DOMAIN_W = 60; // world units — matches buildCamera(60, 100)

// ─── FluidRenderer ───────────────────────────────────────────────────────────

export class FluidRenderer {
  /**
   * @param {THREE.WebGLRenderer}       renderer
   * @param {THREE.OrthographicCamera}  sceneCamera   — top-down camera from CameraSetup
   * @param {number}                    numParticles
   * @param {object}                    [opts]
   * @param {number}                    [opts.splatRadius=2.5]   world units
   * @param {number}                    [opts.densityScale=4.0]  normalisation for debug
   * @param {number}                    [opts.blurRadius=8.0]    Gaussian sigma in RT texels
   * @param {number}                    [opts.threshold=0.18]    density cutoff for water surface
   * @param {number}                    [opts.softness=0.06]     smoothstep width around threshold
   * @param {number}                    [opts.specPower=80]      specular shininess exponent
   * @param {number}                    [opts.rtScale=0.75]      RT resolution vs viewport
   */
  constructor(renderer, sceneCamera, numParticles, opts = {}) {
    this._renderer    = renderer;
    this._camera      = sceneCamera;
    this._N           = numParticles;
    this.splatRadius    = opts.splatRadius    ?? 2.5;
    this.densityScale   = opts.densityScale   ?? 4.0;
    this.blurRadius     = opts.blurRadius     ?? 8.0;
    this.threshold      = opts.threshold      ?? 0.18;
    this.softness       = opts.softness       ?? 0.06;
    this.specPower      = opts.specPower      ?? 80;
    this.opacity          = opts.opacity           ?? 1.0;
    this.crestBrightness  = opts.crestBrightness  ?? 0.95;
    this.crestThreshold   = opts.crestThreshold   ?? 0.45;
    this.oceanDensityMin  = opts.oceanDensityMin  ?? 0.50;
    this.oceanDensityMax  = opts.oceanDensityMax  ?? 0.55;
    // Water colour palette — three-stop ramp + position blend
    this.deepColor    = opts.deepColor    ?? '#0082E0'; // Fiji Blue
    this.midColor     = opts.midColor     ?? '#00C0D1'; // Sea Serpent
    this.shallowColor = opts.shallowColor ?? '#8AE7D4'; // Seychelles Blue
    this.foamColor    = opts.foamColor    ?? '#deeeff'; // cool white foam
    this.posBlend     = opts.posBlend     ?? 0.35;      // 0=pure density, 1=pure position
    this._rtScale       = opts.rtScale          ?? 0.75;

    this._buildRenderTargets();
    this._buildSplatPass();
    this._buildBlurPass();
    this._buildMaskPass();
    this._buildWetnessDownsample();
    this._buildWaterComposite();
    this._buildDebugQuad();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Update the splat geometry with the latest particle positions. */
  updatePositions(positions) {
    const attr = this._splatGeo.attributes.position;
    for (let i = 0; i < this._N * 3; i++) attr.array[i] = positions[i];
    attr.needsUpdate = true;
  }

  /**
   * Render raw density into densityRT.
   * Always call this before renderBlurPass() and renderDebugView().
   */
  renderDensityPass() {
    const r = this._renderer;

    // ── Save renderer state so we don't leak clear-colour into main scene ──
    const savedColor = new THREE.Color();
    const savedAlpha = r.getClearAlpha();
    r.getClearColor(savedColor);

    const vpW = r.domElement.width;
    const ppu = (vpW * this._camera.zoom) / DOMAIN_W;
    this._splatMat.uniforms.uSplatRadius.value  = this.splatRadius;
    this._splatMat.uniforms.uPixelsPerUnit.value = ppu;

    r.setRenderTarget(this._densityRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this._splatScene, this._camera);
    r.setRenderTarget(null);

    // ── Restore ────────────────────────────────────────────────────────────
    r.setClearColor(savedColor, savedAlpha);
  }

  /**
   * Two-pass separable Gaussian blur: densityRT → blurHRT → blurRT.
   * Call after renderDensityPass().
   */
  renderBlurPass() {
    const r  = this._renderer;
    const W  = this._densityRT.width;
    const H  = this._densityRT.height;
    const sx = 1.0 / W;
    const sy = 1.0 / H;

    const savedColor = new THREE.Color();
    const savedAlpha = r.getClearAlpha();
    r.getClearColor(savedColor);

    // ── Horizontal pass: densityRT → blurHRT ──────────────────────────────
    this._blurMat.uniforms.uTexture.value = this._densityRT.texture;
    this._blurMat.uniforms.uStep.value.set(sx * this.blurRadius, 0.0);

    r.setRenderTarget(this._blurHRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this._blurScene, this._orthoCamera);
    r.setRenderTarget(null);

    // ── Vertical pass: blurHRT → blurRT ───────────────────────────────────
    this._blurMat.uniforms.uTexture.value = this._blurHRT.texture;
    this._blurMat.uniforms.uStep.value.set(0.0, sy * this.blurRadius);

    r.setRenderTarget(this._blurRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this._blurScene, this._orthoCamera);
    r.setRenderTarget(null);

    r.setClearColor(savedColor, savedAlpha);
  }

  /**
   * Apply an edge mask to the blurred density: blurRT → maskedRT.
   * Zeroes density within uEdgeMargin world units of the left/Z domain edges
   * so the blur halo never crosses the threshold and produces phantom water.
   * The right (coastline) edge is intentionally left unmasked.
   * Call AFTER renderBlurPass().
   */
  renderMaskPass() {
    const r = this._renderer;

    const savedColor = new THREE.Color();
    const savedAlpha = r.getClearAlpha();
    r.getClearColor(savedColor);

    r.setRenderTarget(this._maskedRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this._maskScene, this._orthoCamera);
    r.setRenderTarget(null);

    r.setClearColor(savedColor, savedAlpha);
  }

  /**
   * Downsample maskedRT → 128×80 wetnessReadRT (GPU-side).
   * Call AFTER renderMaskPass() so the latest mask is captured.
   * The 128×80 size matches TerrainBuilder's WET_GRID_W × WET_GRID_H exactly.
   */
  renderWetnessDownsample() {
    const r = this._renderer;
    const savedColor = new THREE.Color();
    const savedAlpha = r.getClearAlpha();
    r.getClearColor(savedColor);

    r.setRenderTarget(this._wetnessReadRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this._wetnessScene, this._orthoCamera);
    r.setRenderTarget(null);

    r.setClearColor(savedColor, savedAlpha);
  }

  /**
   * Read the 128×80 wetness RT back to CPU (40 KB transfer).
   * Returns the internal Uint8Array — caller must consume it before the next
   * renderWetnessDownsample() call.  R channel encodes density (0–255).
   *
   * GL readback convention: row 0 = GL bottom = UV.y = 0 = worldZ = boundsMax.z.
   * TerrainBuilder.updateWetness handles the Y-flip when indexing.
   */
  readWetnessPixels() {
    this._renderer.readRenderTargetPixels(
      this._wetnessReadRT, 0, 0, 128, 80, this._wetnessPixels,
    );
    return this._wetnessPixels;
  }

  /**
   * Composite the water surface over the already-rendered main scene.
   * Call AFTER renderMaskPass() and AFTER renderer.render(scene, camera).
   */
  renderWaterComposite() {
    const u  = this._waterMat.uniforms;
    u.uThreshold.value        = this.threshold;
    u.uSoftness.value         = this.softness;
    u.uSpecPower.value        = this.specPower;
    u.uOpacity.value          = this.opacity;
    u.uDeepColor.value.set(this.deepColor);
    u.uMidColor.value.set(this.midColor);
    u.uShallowColor.value.set(this.shallowColor);
    u.uFoamColor.value.set(this.foamColor);
    u.uPosBlend.value         = this.posBlend;
    u.uCrestBrightness.value  = this.crestBrightness;
    u.uCrestFoamStart.value   = this.crestThreshold;
    u.uOceanDensityMin.value  = this.oceanDensityMin;
    u.uOceanDensityMax.value  = this.oceanDensityMax;
    u.uTexelSize.value.set(
      1.0 / this._maskedRT.width,
      1.0 / this._maskedRT.height,
    );
    this._renderer.render(this._waterScene, this._orthoCamera);
  }

  /**
   * Render full-screen grayscale debug view of the blurred density.
   * Call AFTER renderBlurPass() and the main scene render.
   */
  renderDebugView() {
    this._debugMat.uniforms.uDensityScale.value = this.densityScale;
    this._renderer.render(this._quadScene, this._orthoCamera);
  }

  /**
   * Tell the water shader the world-space XZ domain extents.
   * Call once after rebuild() whenever boundsMin/boundsMax change.
   * @param {number[]} bmin  [minX, minY, minZ]
   * @param {number[]} bmax  [maxX, maxY, maxZ]
   */
  setBounds(bmin, bmax) {
    const mn = new THREE.Vector2(bmin[0], bmin[2]);
    const mx = new THREE.Vector2(bmax[0], bmax[2]);
    this._maskMat.uniforms.uBoundsMin.value.copy(mn);
    this._maskMat.uniforms.uBoundsMax.value.copy(mx);
    this._waterMat.uniforms.uBoundsMin.value.copy(mn);
    this._waterMat.uniforms.uBoundsMax.value.copy(mx);
  }

  /**
   * Update the camera frustum extents used by the mask and composite shaders for
   * UV → world-space reconstruction.  Must be called after every camera zoom change
   * (including on resize) because zoom alters the effective visible frustum.
   *
   * With contain-mode camera (landscape screen, portrait domain) the frustum is wider
   * than the domain in X — passing the actual frustum prevents incorrect edge suppression.
   *
   * Encoding convention:
   *   uFrustumMin = (worldX_leftEdge,  worldZ_topEdge   [beach, most-negative Z])
   *   uFrustumMax = (worldX_rightEdge, worldZ_bottomEdge[ocean, most-positive  Z])
   *
   * With camera.up = (0,0,-1):  screen top = world -Z, screen bottom = world +Z.
   * So worldZ_top = -camera.top/zoom  and  worldZ_bottom = -camera.bottom/zoom.
   *
   * @param {THREE.OrthographicCamera} camera
   */
  setFrustum(camera) {
    const z     = camera.zoom;
    const fL    =  camera.left   / z;   // worldX at screen left
    const fR    =  camera.right  / z;   // worldX at screen right
    const fMinZ = -camera.top    / z;   // worldZ at screen top    (beach, most-negative)
    const fMaxZ = -camera.bottom / z;   // worldZ at screen bottom (ocean, most-positive)

    const mn = new THREE.Vector2(fL,  fMinZ);
    const mx = new THREE.Vector2(fR,  fMaxZ);

    this._maskMat.uniforms.uFrustumMin.value.copy(mn);
    this._maskMat.uniforms.uFrustumMax.value.copy(mx);
    this._waterMat.uniforms.uFrustumMin.value.copy(mn);
    this._waterMat.uniforms.uFrustumMax.value.copy(mx);
  }

  /**
   * Set the Y-axis range used to weight particle density contributions by height.
   * Particles at yMax (wave crest) get weight 1.0; at yMin (seabed) get weight 0.15.
   * Call once after rebuild() whenever boundsMin/boundsMax change.
   * @param {number} yMin  boundsMin[1]
   * @param {number} yMax  boundsMax[1]
   */
  setYBounds(yMin, yMax) {
    this._splatMat.uniforms.uYMin.value = yMin;
    this._splatMat.uniforms.uYMax.value = yMax;
  }

  /** Resize RTs when viewport changes. */
  resize() {
    this._densityRT.dispose();
    this._blurHRT.dispose();
    this._blurRT.dispose();
    this._maskedRT.dispose();
    this._buildRenderTargets();
    // Rewire all downstream consumers to the new masked RT texture
    this._maskMat.uniforms.uDensity.value     = this._blurRT.texture;
    this._waterMat.uniforms.uDensity.value    = this._maskedRT.texture;
    this._debugMat.uniforms.uDensity.value    = this._maskedRT.texture;
    this._wetnessMat.uniforms.uDensity.value  = this._maskedRT.texture;
  }

  dispose() {
    this._densityRT.dispose();
    this._blurHRT.dispose();
    this._blurRT.dispose();
    this._maskedRT.dispose();
    this._wetnessReadRT.dispose();
    this._splatGeo.dispose();
    this._splatMat.dispose();
    this._blurMat.dispose();
    this._maskMat.dispose();
    this._wetnessMat.dispose();
    this._waterMat.dispose();
    this._debugMat.dispose();
  }

  // ── Private builders ────────────────────────────────────────────────────────

  _buildRenderTargets() {
    const W = Math.floor(this._renderer.domElement.width  * this._rtScale);
    const H = Math.floor(this._renderer.domElement.height * this._rtScale);

    const rtOpts = {
      minFilter:   THREE.LinearFilter,
      magFilter:   THREE.LinearFilter,
      format:      THREE.RGBAFormat,
      type:        THREE.UnsignedByteType, // byte type guarantees blending support
      depthBuffer: false,
    };

    this._densityRT = new THREE.WebGLRenderTarget(W, H, { ...rtOpts });
    this._blurHRT   = new THREE.WebGLRenderTarget(W, H, { ...rtOpts });
    this._blurRT    = new THREE.WebGLRenderTarget(W, H, { ...rtOpts });
    this._maskedRT  = new THREE.WebGLRenderTarget(W, H, { ...rtOpts });
  }

  _buildSplatPass() {
    this._splatGeo = new THREE.BufferGeometry();
    this._splatGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this._N * 3), 3),
    );

    this._splatMat = new THREE.ShaderMaterial({
      uniforms: {
        uSplatRadius:   { value: this.splatRadius },
        uPixelsPerUnit: { value: 20.0 },
        // Y-height weighting: elevated particles (wave crests) contribute more
        // density than deep particles (troughs), making wave peaks visible in
        // the 2D density buffer under a top-down orthographic projection.
        // Window is deliberately narrow — covers only the real wave displacement
        // range (~±2 world units around waterline) so small height differences
        // produce large weight differences (quadratic curve).
        uYMin: { value: -1.0 },  // Y at wave trough  → minimum weight (0.1)
        uYMax: { value:  4.0 },  // Y at wave crest   → maximum weight (1.0)
      },
      vertexShader: /* glsl */`
        uniform float uSplatRadius;
        uniform float uPixelsPerUnit;
        uniform float uYMin;
        uniform float uYMax;
        varying float vWeight;

        void main() {
          gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uSplatRadius * uPixelsPerUnit * 2.0;

          // Amplified quadratic weight: crests contribute far more density than troughs.
          // Previous: mix(0.1, 1.0, t²) → 10× ratio at extremes, ~5× at Y=+2
          // Now:      mix(0.05, 1.5, t²) → 30× ratio — wave crest density spikes are
          //           clearly visible vs. deep-trough baseline even after Gaussian blur.
          // Weight > 1.0 is valid: additive blending accumulates it across overlapping
          // particles, so a cluster of crest particles sums to a strong density peak.
          float yNorm = clamp((position.y - uYMin) / max(uYMax - uYMin, 0.001), 0.0, 1.0);
          vWeight = mix(0.05, 1.5, yNorm * yNorm);
        }
      `,
      fragmentShader: /* glsl */`
        varying float vWeight;

        void main() {
          vec2  d  = gl_PointCoord - vec2(0.5);
          float r2 = 4.0 * dot(d, d);
          if (r2 >= 1.0) discard;
          // Scale Gaussian density by height weight: crests brighter, troughs dimmer
          float density = exp(-r2 * 2.5) * vWeight;
          gl_FragColor = vec4(density, 0.0, 0.0, 1.0);
        }
      `,
      blending:    THREE.AdditiveBlending,
      depthTest:   false,
      depthWrite:  false,
      transparent: true,
    });

    this._splatScene  = new THREE.Scene();
    this._splatPoints = new THREE.Points(this._splatGeo, this._splatMat);
    this._splatScene.add(this._splatPoints);
  }

  _buildBlurPass() {
    // Shared orthographic camera for all full-screen quad passes
    this._orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Single blur material — direction set per-pass via uStep
    this._blurMat = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: null },
        uStep:    { value: new THREE.Vector2(0, 0) },
        // uStep = texelSize * blurRadius, set before each pass
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        // 9-tap separable Gaussian (taps at -4..+4 × uStep).
        // Reduced from 17-tap: saves ~47% GPU texture bandwidth on blur passes
        // with negligible quality loss — Gaussian weight at ±4 with sigma=3.5
        // is exp(-0.5*(4/3.5)²) ≈ 0.034, contributing < 4% of total weight.
        // Two passes (H+V) = 18 samples/pixel vs former 34.

        uniform sampler2D uTexture;
        uniform vec2      uStep;
        varying vec2      vUv;

        void main() {
          const float SIGMA = 3.5;
          float acc  = 0.0;
          float wsum = 0.0;

          for (int i = -4; i <= 4; i++) {
            float fi = float(i);
            float w  = exp(-0.5 * fi * fi / (SIGMA * SIGMA));
            acc  += texture2D(uTexture, vUv + uStep * fi).r * w;
            wsum += w;
          }

          gl_FragColor = vec4(acc / wsum, 0.0, 0.0, 1.0);
        }
      `,
      depthTest:  false,
      depthWrite: false,
    });

    // Reuse orthoCamera scene for both blur passes and debug quad
    this._blurScene = new THREE.Scene();
    const blurQuad  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._blurMat);
    this._blurScene.add(blurQuad);
  }

  _buildMaskPass() {
    // Reads blurRT, zeroes density within edgeMargin of the left/Z domain walls,
    // writes result to maskedRT.  The right edge (coastline) is left at full strength.
    this._maskMat = new THREE.ShaderMaterial({
      uniforms: {
        uDensity:    { value: this._blurRT.texture },
        uBoundsMin:  { value: new THREE.Vector2(-30, -50) },  // domain XZ min (set by setBounds)
        uBoundsMax:  { value: new THREE.Vector2( 30,  50) },  // domain XZ max (set by setBounds)
        uFrustumMin: { value: new THREE.Vector2(-30, -50) },  // camera frustum XZ min (set by setFrustum)
        uFrustumMax: { value: new THREE.Vector2( 30,  50) },  // camera frustum XZ max (set by setFrustum)
        uEdgeMargin: { value: 6.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uDensity;
        uniform vec2      uBoundsMin;
        uniform vec2      uBoundsMax;
        uniform vec2      uFrustumMin;
        uniform vec2      uFrustumMax;
        uniform float     uEdgeMargin;
        varying vec2      vUv;

        void main() {
          float d = texture2D(uDensity, vUv).r;

          // Reconstruct world XZ from UV using actual camera frustum extents.
          // uFrustumMin/Max encode (worldX, worldZ) at screen corners:
          //   uFrustumMin = (worldX_left,  worldZ_top   [beach, -Z])
          //   uFrustumMax = (worldX_right, worldZ_bottom[ocean, +Z])
          vec2  fsz    = uFrustumMax - uFrustumMin;
          float worldX = uFrustumMin.x + vUv.x * fsz.x;
          float worldZ = uFrustumMax.y - vUv.y * fsz.y;

          // Distance to each non-coastline domain wall.
          // Bottom (+Z, ocean) and both X walls are masked; top (-Z, beach) excluded.
          float distBottom = uBoundsMax.y - worldZ;  // ocean bottom wall (+Z)
          float distLeft   = worldX - uBoundsMin.x;  // left X wall
          float distRight  = uBoundsMax.x - worldX;  // right X wall
          // Top wall (-Z) = coastline — intentionally excluded (mask stays 1 there)

          float mask = smoothstep(0.0, uEdgeMargin, distBottom)
                     * smoothstep(0.0, uEdgeMargin, distLeft)
                     * smoothstep(0.0, uEdgeMargin, distRight);

          gl_FragColor = vec4(d * mask, 0.0, 0.0, 1.0);
        }
      `,
      depthTest:  false,
      depthWrite: false,
    });

    this._maskScene = new THREE.Scene();
    const maskQuad  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._maskMat);
    this._maskScene.add(maskQuad);
  }

  _buildWetnessDownsample() {
    // 128×80 matches TerrainBuilder WET_GRID_W × WET_GRID_H so readback pixels
    // map 1-to-1 onto wetness cells — no interpolation needed on the CPU side.
    this._wetnessReadRT = new THREE.WebGLRenderTarget(128, 80, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format:    THREE.RGBAFormat,
      type:      THREE.UnsignedByteType,
      depthBuffer: false,
    });
    this._wetnessPixels = new Uint8Array(128 * 80 * 4); // persistent — avoids per-frame alloc

    this._wetnessMat = new THREE.ShaderMaterial({
      uniforms: {
        uDensity: { value: this._maskedRT.texture },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uDensity;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(texture2D(uDensity, vUv).r, 0.0, 0.0, 1.0);
        }
      `,
      depthTest:  false,
      depthWrite: false,
    });

    this._wetnessScene = new THREE.Scene();
    this._wetnessScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._wetnessMat));
  }

  _buildWaterComposite() {
    this._waterMat = new THREE.ShaderMaterial({
      uniforms: {
        uDensity:      { value: this._maskedRT.texture }, // reads post-mask density
        uThreshold:    { value: this.threshold },
        uSoftness:     { value: this.softness },
        uSpecPower:    { value: this.specPower },
        uTexelSize:    { value: new THREE.Vector2(1, 1) }, // filled in renderWaterComposite
        // Three-stop colour ramp: deep trough → mid ocean → shallow crest
        uDeepColor:    { value: new THREE.Color(0x0082E0) }, // Fiji Blue
        uMidColor:     { value: new THREE.Color(0x00C0D1) }, // Sea Serpent
        uShallowColor: { value: new THREE.Color(0x8AE7D4) }, // Seychelles Blue
        uFoamColor:    { value: new THREE.Color(0xdeeeff) }, // cool white foam
        // Position-based tint blend (0=pure density variation, 1=pure left→right gradient)
        uPosBlend:     { value: 0.35 },
        // Wave crest visibility
        uCrestBrightness:  { value: 0.6  },
        uCrestFoamStart:   { value: 0.70 },
        // Contrast-stretch window
        uOceanDensityMin:  { value: 0.50 },
        uOceanDensityMax:  { value: 0.55 },
        // Domain bounds (XZ) for edge-foam suppression — set via setBounds()
        uBoundsMin:    { value: new THREE.Vector2(-30, -50) },  // domain XZ min (set by setBounds)
        uBoundsMax:    { value: new THREE.Vector2( 30,  50) },  // domain XZ max (set by setBounds)
        uFrustumMin:   { value: new THREE.Vector2(-30, -50) },  // camera frustum XZ min (set by setFrustum)
        uFrustumMax:   { value: new THREE.Vector2( 30,  50) },  // camera frustum XZ max (set by setFrustum)
        uEdgeMargin:   { value: 6.0 }, // world units — foam suppressed within this of any edge
        uOpacity:      { value: 1.0 }, // 0=fully transparent, 1=fully opaque
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uDensity;
        uniform float     uThreshold;
        uniform float     uSoftness;
        uniform float     uSpecPower;
        uniform vec2      uTexelSize;
        uniform vec3      uDeepColor;        // Fiji Blue    — deep trough / far-left ocean
        uniform vec3      uMidColor;         // Sea Serpent  — mid ocean
        uniform vec3      uShallowColor;     // Seychelles Blue — crest / near coast
        uniform vec3      uFoamColor;        // cool white foam
        uniform float     uCrestBrightness;
        uniform float     uCrestFoamStart;
        uniform float     uOceanDensityMin;
        uniform float     uOceanDensityMax;
        uniform vec2      uBoundsMin;   // XZ domain minimums (for domain wall distances)
        uniform vec2      uBoundsMax;   // XZ domain maximums (for domain wall distances)
        uniform vec2      uFrustumMin;  // XZ frustum minimums (for UV→world reconstruction)
        uniform vec2      uFrustumMax;  // XZ frustum maximums (for UV→world reconstruction)
        uniform float     uEdgeMargin;  // world units — suppress foam near edges
        uniform float     uOpacity;     // 0=transparent, 1=opaque
        varying vec2      vUv;

        void main() {
          float d = texture2D(uDensity, vUv).r;

          // ── Alpha: soft threshold ────────────────────────────────────────
          float alpha = smoothstep(
            uThreshold - uSoftness,
            uThreshold + uSoftness,
            d
          );
          if (alpha < 0.001) discard;

          // ── Edge suppression mask — computed first, used by both specular
          //    and foam to avoid glow artefacts at non-coastline domain edges.
          //
          //    Reconstruct world XZ from UV using camera frustum extents.
          //    The frustum may be wider than the domain (contain mode on landscape),
          //    so we use uFrustumMin/Max for UV→world and uBoundsMin/Max for distances.
          vec2  frustumSize   = uFrustumMax - uFrustumMin;
          float worldX        = uFrustumMin.x + vUv.x * frustumSize.x;
          float worldZ        = uFrustumMax.y - vUv.y * frustumSize.y;

          // Bottom (+Z, ocean) and both X walls are suppressed; top (-Z, beach) excluded.
          float distBottom = uBoundsMax.y - worldZ;  // ocean bottom wall (+Z)
          float distLeft   = worldX - uBoundsMin.x;  // left X wall
          float distRight  = uBoundsMax.x - worldX;  // right X wall
          // Top wall (-Z) = real coastline — excluded so specular/foam stay at beach.

          float edgeSuppression = smoothstep(0.0, uEdgeMargin, distBottom)
                                * smoothstep(0.0, uEdgeMargin, distLeft)
                                * smoothstep(0.0, uEdgeMargin, distRight);

          // ── SYSTEM 1: Position-based base colour (runs independently) ───────
          // vUv.y = 0 → screen bottom (open ocean, +Z, deepest) → Fiji Blue
          // vUv.y = 1 → screen top   (coastline, -Z)            → Seychelles Blue
          // Density has NO effect here — this is purely geographic depth.
          vec3 color = vUv.y < 0.5
            ? mix(uDeepColor,  uMidColor,    vUv.y * 2.0)
            : mix(uMidColor, uShallowColor, (vUv.y - 0.5) * 2.0);

          // ── SYSTEM 2: Wave-crest foam (runs independently on top) ─────────
          // oceanNorm → 1 where Y-height-weighted density peaks (elevated particles).
          // Purely drives the foam layer — does NOT touch the base colour.
          float oceanNorm = smoothstep(uOceanDensityMin, uOceanDensityMax, d);
          float crestFoam = smoothstep(uCrestFoamStart, 1.0, oceanNorm) * uCrestBrightness;
          color = mix(color, uFoamColor, crestFoam * 0.85);

          // ── Surface normal from density gradient (finite differences) ───
          float eps = 3.0;
          float dX = texture2D(uDensity, vUv + vec2(uTexelSize.x * eps, 0.0)).r
                   - texture2D(uDensity, vUv - vec2(uTexelSize.x * eps, 0.0)).r;
          float dY = texture2D(uDensity, vUv + vec2(0.0, uTexelSize.y * eps)).r
                   - texture2D(uDensity, vUv - vec2(0.0, uTexelSize.y * eps)).r;

          vec3 rawNormal = normalize(vec3(-dX * 5.0, 1.0, -dY * 5.0));

          // Blend toward a flat upward normal at domain edges.
          // At edgeSuppression=0 (deep in the margin) the normal is (0,1,0) —
          // perfectly flat, guaranteed zero off-axis specular contribution
          // regardless of the gradient spike.  Interior stays fully computed.
          vec3 normal = normalize(mix(vec3(0.0, 1.0, 0.0), rawNormal, edgeSuppression));

          // ── Lighting: sun from upper-right ──────────────────────────────
          vec3 sunDir  = normalize(vec3(0.5, 1.0, 0.4));
          vec3 viewDir = vec3(0.0, 1.0, 0.0);
          vec3 halfVec = normalize(sunDir + viewDir);

          float diff = max(dot(normal, sunDir), 0.0) * 0.25;
          float spec = pow(max(dot(normal, halfVec), 0.0), uSpecPower);

          color += color * diff;
          // Belt-and-suspenders: even if the blended normal still yields some
          // specular, scale it to zero at domain edges.
          color += vec3(0.85, 0.92, 1.0) * spec * 0.7 * edgeSuppression;

          // ── Coastline foam — suppressed at domain edges ─────────────────
          float rawFoam = 1.0 - smoothstep(
            uThreshold + uSoftness,
            uThreshold + uSoftness * 4.0,
            d
          );
          color = mix(color, uFoamColor, rawFoam * edgeSuppression * 0.6);

          gl_FragColor = vec4(clamp(color, 0.0, 1.0), alpha * uOpacity);
        }
      `,
      transparent: true,
      depthTest:   false,
      depthWrite:  false,
    });

    this._waterScene = new THREE.Scene();
    const waterQuad  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._waterMat);
    this._waterScene.add(waterQuad);
  }

  _buildDebugQuad() {
    this._quadScene = new THREE.Scene();

    this._debugMat = new THREE.ShaderMaterial({
      uniforms: {
        uDensity:      { value: this._maskedRT.texture }, // shows post-mask density
        uDensityScale: { value: this.densityScale },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uDensity;
        uniform float     uDensityScale;
        varying vec2      vUv;

        void main() {
          float d    = texture2D(uDensity, vUv).r;
          float grey = clamp(d / uDensityScale, 0.0, 1.0);
          gl_FragColor = vec4(grey, grey, grey, 1.0);
        }
      `,
      depthTest:  false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._debugMat);
    this._quadScene.add(quad);
  }
}
