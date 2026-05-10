/**
 * CameraSetup.js — Stage 2.5A
 *
 * Top-down OrthographicCamera that fits the full simulation domain in view,
 * with mouse-wheel zoom clamped between 0.5× and 3×.
 *
 * Public API
 * ----------
 *   buildCamera(domainW, domainD)
 *     Returns a configured THREE.OrthographicCamera.
 *
 *   handleResize(camera, renderer)
 *     Call from a window 'resize' listener to keep the domain in frame.
 *
 *   attachZoom(camera, domElement)
 *     Wires up the mouse-wheel listener.  Returns a cleanup function that
 *     removes the listener (call on teardown / rebuild).
 */

import * as THREE from 'three';

// ─── Constants ────────────────────────────────────────────────────────────────

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1; // zoom delta per wheel tick (normalised)

// ─── buildCamera ──────────────────────────────────────────────────────────────

/**
 * Create a top-down OrthographicCamera sized to fit the simulation domain.
 *
 * The domain is assumed to be centred at world origin (0, 0, 0):
 *   X: [-domainW/2, +domainW/2]  (default: -50 … +50  → 100 units wide)
 *   Z: [-domainD/2, +domainD/2]  (default: -30 … +30  →  60 units deep)
 *
 * Camera looks straight down (+Y → −Y).  Because +Z is "into the screen" for
 * Three's default convention but we want a top-down map view, we set up=(0,0,-1)
 * so that "screen up" maps to world -Z (north on a typical overhead map).
 *
 * @param {number} [domainW=100]  Domain width  in world units (X axis)
 * @param {number} [domainD=60]   Domain depth  in world units (Z axis)
 * @returns {THREE.OrthographicCamera}
 */
export function buildCamera(domainW = 100, domainD = 60) {
  const halfW = domainW / 2; // 50
  const halfD = domainD / 2; // 30

  const aspect = window.innerWidth / window.innerHeight;

  // Compute frustum half-extents that keep the full domain visible.
  // We fit to the tighter axis so nothing is clipped.
  const fitScale = _fitScale(halfW, halfD, aspect);

  const camera = new THREE.OrthographicCamera(
    -halfW * fitScale,  // left
     halfW * fitScale,  // right
     halfD * fitScale,  // top
    -halfD * fitScale,  // bottom
    0.1,                // near
    500,                // far
  );

  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);

  // Store half-extents on camera for use in handleResize
  camera.userData.halfW = halfW;
  camera.userData.halfD = halfD;

  camera.updateProjectionMatrix();

  return camera;
}

// ─── handleResize ─────────────────────────────────────────────────────────────

/**
 * Recalculate frustum extents after a window resize so the domain stays fully
 * visible regardless of aspect ratio.  Also re-applies the current zoom level.
 *
 * @param {THREE.OrthographicCamera} camera
 * @param {THREE.WebGLRenderer}      renderer
 */
export function handleResize(camera, renderer) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);

  const aspect = w / h;
  const { halfW, halfD } = camera.userData;
  const fitScale = _fitScale(halfW, halfD, aspect);

  // Re-apply fit scale; zoom is stored as camera.zoom which Three multiplies
  // into the projection matrix separately.
  camera.left   = -halfW * fitScale;
  camera.right  =  halfW * fitScale;
  camera.top    =  halfD * fitScale;
  camera.bottom = -halfD * fitScale;

  camera.updateProjectionMatrix();
}

// ─── attachZoom ───────────────────────────────────────────────────────────────

/**
 * Wire mouse-wheel zoom to camera.zoom, clamped to [ZOOM_MIN, ZOOM_MAX].
 *
 * @param {THREE.OrthographicCamera} camera
 * @param {HTMLElement}              domElement   Usually renderer.domElement
 * @returns {Function} cleanup — call to remove the event listener on teardown
 */
export function attachZoom(camera, domElement) {
  function onWheel(event) {
    event.preventDefault();

    // Normalise wheel delta: positive scroll → zoom in (larger zoom value)
    const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    let newZoom = camera.zoom + delta;

    if (newZoom < ZOOM_MIN) newZoom = ZOOM_MIN;
    if (newZoom > ZOOM_MAX) newZoom = ZOOM_MAX;

    camera.zoom = newZoom;
    camera.updateProjectionMatrix();
  }

  domElement.addEventListener('wheel', onWheel, { passive: false });

  // Return cleanup function
  return () => domElement.removeEventListener('wheel', onWheel);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute a uniform scale factor so that the domain (halfW × halfD) fits
 * entirely within the current aspect ratio without distortion.
 *
 * We want: frustumWidth  = halfW * fitScale * 2  >= domainW
 *          frustumHeight = halfD * fitScale * 2  >= domainD
 *
 * Choosing fitScale = max(1, domainD/(domainW/aspect)) ensures neither axis
 * is clipped.  For a landscape viewport this is usually 1.0; for portrait or
 * very wide domains it scales up to reveal the full extent.
 *
 * @param {number} halfW
 * @param {number} halfD
 * @param {number} aspect   window.innerWidth / window.innerHeight
 * @returns {number}
 */
function _fitScale(halfW, halfD, aspect) {
  // The frustum naturally shows halfW * aspect  height worth of world-units
  // when aspect > 1 (landscape).  We need at least halfD height visible.
  const heightNeeded = halfD;
  const heightFromAspect = halfW / aspect;

  if (heightFromAspect < heightNeeded) {
    // Viewport is too wide — scale up so height fits
    return heightNeeded / heightFromAspect;
  }

  return 1.0;
}
