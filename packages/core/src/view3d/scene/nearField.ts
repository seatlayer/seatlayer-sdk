/**
 * "Which seats are close enough to be worth drawing as chairs?" — a uniform XZ
 * grid over the seat cloud, queried nearest-cell-first.
 *
 * This is the piece that makes the near field affordable. The chair mesh could
 * simply carry every seat and let the vertex stage collapse the far ones to
 * zero size, but that is 52,000 × 72 vertices of shading per frame to draw a few
 * hundred chairs — the whole 60 fps claim, spent on geometry that is discarded.
 * Instead the CPU hands the mesh a COMPACT set bounded by CHAIR_MAX_INSTANCES,
 * so near-field cost is a function of the camera's neighbourhood and not of
 * venue size.
 *
 * The grid is built lazily on the first gather: a camera that never comes down
 * to the deck never pays for it, and the intro pose is always far out.
 */

/** Target seats per cell. Small enough to prune hard, large enough that the
 *  bucket arrays stay short and cache-friendly. */
const SEATS_PER_CELL = 4;

export class NearFieldIndex {
  private readonly iPosition: Float32Array;
  private readonly count: number;
  private minX = 0;
  private minZ = 0;
  private cell = 1;
  private cols = 1;
  private rows = 1;
  /** CSR-style buckets: `cellStart[c]…cellStart[c+1]` indexes into `cellItems`. */
  private cellStart: Int32Array | null = null;
  private cellItems: Int32Array | null = null;

  constructor(iPosition: Float32Array, count: number) {
    this.iPosition = iPosition;
    this.count = count;
  }

  /** Built on demand; safe to call repeatedly. */
  private ensureGrid(): void {
    if (this.cellStart || this.count === 0) return;
    const p = this.iPosition;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const x = p[i * 3], z = p[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const w = Math.max(maxX - minX, 1e-3);
    const h = Math.max(maxZ - minZ, 1e-3);
    this.cell = Math.max(Math.sqrt((w * h * SEATS_PER_CELL) / this.count), 0.25);
    this.cols = Math.max(1, Math.ceil(w / this.cell) + 1);
    this.rows = Math.max(1, Math.ceil(h / this.cell) + 1);
    this.minX = minX;
    this.minZ = minZ;
    // Counting sort into CSR — no per-cell arrays, one pass to count and one to
    // place. At 52k seats this is two linear scans and two typed allocations.
    const nCells = this.cols * this.rows;
    const start = new Int32Array(nCells + 1);
    const cellOf = (i: number): number => {
      const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((p[i * 3] - minX) / this.cell)));
      const cz = Math.min(this.rows - 1, Math.max(0, Math.floor((p[i * 3 + 2] - minZ) / this.cell)));
      return cz * this.cols + cx;
    };
    for (let i = 0; i < this.count; i++) start[cellOf(i) + 1]++;
    for (let c = 0; c < nCells; c++) start[c + 1] += start[c];
    const items = new Int32Array(this.count);
    const cursor = start.slice(0, nCells);
    for (let i = 0; i < this.count; i++) items[cursor[cellOf(i)]++] = i;
    this.cellStart = start;
    this.cellItems = items;
  }

  /**
   * Fill `out` with the indices of seats within `radius` metres of (camX, camZ),
   * nearest cell-ring first, and return how many were written.
   *
   * Ring order is what makes the CHAIR_MAX_INSTANCES cap harmless: when the cap
   * bites it drops the OUTERMOST seats, which are the ones already past the fade
   * band and drawing nothing. A cap that truncated in index order would instead
   * punch holes in the row you are sitting in.
   *
   * Note this is a horizontal (XZ) query and ignores height. A stacked venue's
   * upper tier is therefore gathered along with the stalls beneath it — which is
   * correct, because the fade weight is re-derived from true view depth in the
   * shader anyway. The grid's only job is to bound the candidate set.
   */
  gather(camX: number, camZ: number, radius: number, out: Int32Array): number {
    this.ensureGrid();
    const start = this.cellStart;
    const items = this.cellItems;
    if (!start || !items) return 0;
    const cap = out.length;
    const r2 = radius * radius;
    const cx = Math.floor((camX - this.minX) / this.cell);
    const cz = Math.floor((camZ - this.minZ) / this.cell);
    const maxRing = Math.ceil(radius / this.cell) + 1;
    const p = this.iPosition;
    let n = 0;
    for (let ring = 0; ring <= maxRing && n < cap; ring++) {
      const z0 = cz - ring, z1 = cz + ring;
      const x0 = cx - ring, x1 = cx + ring;
      for (let gz = z0; gz <= z1 && n < cap; gz++) {
        if (gz < 0 || gz >= this.rows) continue;
        // Only the newly-exposed cells of this ring: the full row on the top and
        // bottom edges, just the two end cells in between.
        const edge = (gz === z0 || gz === z1);
        for (let gx = x0; gx <= x1 && n < cap; gx++) {
          if (!edge && gx !== x0 && gx !== x1) { gx = x1 - 1; continue; }
          if (gx < 0 || gx >= this.cols) continue;
          const c = gz * this.cols + gx;
          for (let k = start[c], e = start[c + 1]; k < e && n < cap; k++) {
            const i = items[k];
            const dx = p[i * 3] - camX;
            const dz = p[i * 3 + 2] - camZ;
            if (dx * dx + dz * dz <= r2) out[n++] = i;
          }
        }
      }
    }
    return n;
  }
}
