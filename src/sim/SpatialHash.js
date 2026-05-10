/**
 * SpatialHash — uniform-grid broad-phase neighbor search
 *
 * Core idea: divide 3D space into axis-aligned cells of side `cellSize`.
 * Each particle lives in exactly one cell. To find all neighbors of
 * particle i, we only need to check the 3×3×3 = 27 cells that could
 * possibly overlap its smoothing sphere of radius h = cellSize.
 *
 * Collision resolution uses an intrusive singly-linked list:
 *   cells[h]   = head particle index in bucket h  (-1 = empty)
 *   next[i]    = next particle in the same bucket  (-1 = tail)
 *
 * This stores the list inside two flat Int32Arrays — no heap allocation
 * during insert or query, which matters at 60 fps with 1500 particles.
 *
 * Time complexity: O(N) build, O(k) query where k = avg. neighbor count
 * Worst-case O(N) query if all particles hash to the same bucket, but
 * with a well-chosen table size and FNV mixing this is extremely rare.
 */
export class SpatialHash {
  /**
   * @param {number} cellSize  Side length of each grid cell. Set equal to SPH
   *                           smoothing radius h so one "ring" of cells covers
   *                           the entire kernel support.
   * @param {number} maxParticles  Upper bound on particle count (sizes arrays).
   */
  constructor(cellSize, maxParticles) {
    this.cellSize  = cellSize;

    // A prime table size reduces clustering from regular grid patterns.
    // ~2× particle count keeps the load factor under 0.5.
    this.tableSize = nextPrime(maxParticles * 2 + 1);

    // Head-of-list for each hash bucket.  -1 means empty.
    this.cells = new Int32Array(this.tableSize).fill(-1);

    // Intrusive next-pointer array. next[i] is the particle after i in the
    // same bucket.  -1 means i is the last particle in that bucket.
    this.next  = new Int32Array(maxParticles).fill(-1);
  }

  /**
   * FNV-1a inspired 32-bit hash for an integer triplet.
   * Math.imul gives true 32-bit integer multiplication (no overflow to NaN).
   * The & 0xFFFF masks map negative cell indices into the unsigned 16-bit
   * range so negative coordinates hash correctly.
   */
  _hash(ix, iy, iz) {
    const FNV_OFFSET = 2166136261;
    const FNV_PRIME  = 16777619;
    let h = FNV_OFFSET;
    h = (Math.imul(h ^ (ix & 0xFFFF), FNV_PRIME)) >>> 0;
    h = (Math.imul(h ^ (iy & 0xFFFF), FNV_PRIME)) >>> 0;
    h = (Math.imul(h ^ (iz & 0xFFFF), FNV_PRIME)) >>> 0;
    return h % this.tableSize;
  }

  /** Convert a world-space coordinate to an integer cell index. */
  _cellOf(x, y, z) {
    const inv = 1.0 / this.cellSize;
    return [Math.floor(x * inv) | 0,
            Math.floor(y * inv) | 0,
            Math.floor(z * inv) | 0];
  }

  /**
   * Reset all buckets.  O(tableSize) — call once per timestep, before insert.
   * We only reset `cells`, not `next`, because every next[i] we read will have
   * been written by a prior insert in the same frame.
   */
  clear() {
    this.cells.fill(-1);
  }

  /** Insert particle `id` whose world position is (x, y, z). */
  insert(id, x, y, z) {
    const [ix, iy, iz] = this._cellOf(x, y, z);
    const h = this._hash(ix, iy, iz);
    // Prepend to the linked list in bucket h
    this.next[id]  = this.cells[h];
    this.cells[h]  = id;
  }

  /**
   * Fill `out` with the IDs of every particle in the 27 cells surrounding
   * (x, y, z).  May contain false positives from hash collisions — the SPH
   * force loops already perform a distance check, so this is fine.
   *
   * @param {number}   x, y, z  Query position (world space)
   * @param {number[]} out      Output array (reused each call to avoid GC)
   */
  query(x, y, z, out) {
    const [cx, cy, cz] = this._cellOf(x, y, z);
    out.length = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const h = this._hash(cx + dx, cy + dy, cz + dz);
          let id = this.cells[h];
          while (id !== -1) {
            out.push(id);
            id = this.next[id];
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPrime(n) {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 === 0 || n % 3 === 0) return false;
  for (let i = 5; i * i <= n; i += 6) {
    if (n % i === 0 || n % (i + 2) === 0) return false;
  }
  return true;
}

function nextPrime(n) {
  let c = n | 1; // start odd
  while (!isPrime(c)) c += 2;
  return c;
}
