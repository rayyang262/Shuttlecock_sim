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

  // "Cover" mode: always fill the viewport completely — no black bars.
  // If the viewport is wider than the domain aspect, we fit the domain width
  // and crop Z.  If narrower, we fit the domain depth and crop X.
  // Either way every pixel is occupied by the simulation.
  const { left, right, top, bottom } = _coverFrustum(halfW, halfD, aspect);

  const camera = new THREE.OrthographicCamera(
    left, right, top, bottom,
    0.1,   // near
    500,   // far
  );

  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);

  // Store domain half-extents so handleResize can recalculate correctly
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
  const { left, right, top, bottom } = _coverFrustum(halfW, halfD, aspect);

  camera.left   = left;
  camera.right  = right;
  camera.top    = top;
  camera.bottom = bottom;

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
 * "Cover" frustum: always fills the viewport with no black bars.
 *
 * Domain aspect = halfW / halfD  (50/30 ≈ 1.667).
 *
 * Wide viewport  (aspect ≥ domainAspect): fit the domain width exactly,
 *   set height from viewport aspect → some Z is cropped off screen.
 *
 * Tall viewport  (aspect <  domainAspect): fit the domain depth exactly,
 *   set width from viewport aspect → some X is cropped off screen.
 *
 * Either way the viewport is pixel-perfectly filled by the simulation
 * with square pixels and no letterboxing/pillarboxing.
 *
 * @param {number} halfW
 * @param {number} halfD
 * @param {number} aspect  window.innerWidth / window.innerHeight
 * @returns {{ left, right, top, bottom }}
 */
function _coverFrustum(halfW, halfD, aspect) {
  const domainAspect = halfW / halfD;

  if (aspect >= domainAspect) {
    // Wider than domain — lock X to domain width, derive Z from aspect
    const halfH = halfW / aspect;
    return { left: -halfW, right: halfW, top: halfH, bottom: -halfH };
  } else {
    // Taller than domain — lock Z to domain depth, derive X from aspect
    const halfR = halfD * aspect;
    return { left: -halfR, right: halfR, top: halfD, bottom: -halfD };
  }
}
