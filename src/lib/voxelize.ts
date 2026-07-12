/**
 * Column-parity voxelizer.
 *
 * For every (x, y) grid column we collect the z-heights where a vertical ray
 * through the column centre crosses a triangle, sort them, and fill between
 * alternating crossings. This is robust for watertight meshes and cheap
 * enough to run in the browser for typical printable models.
 */
import { Mesh, computeBBox } from './geometry';

export interface VoxelGrid {
  nx: number;
  ny: number;
  nz: number;
  /** Cell size in mm (x and y). */
  cellXY: number;
  /** Layer thickness in mm (z). */
  cellZ: number;
  /** Grid origin in model coordinates (min corner). */
  origin: [number, number, number];
  /** Occupancy, indexed z * nx * ny + y * nx + x. */
  occupancy: Uint8Array;
  /** Occupied cell count per layer. */
  layerCounts: Uint32Array;
  /** Per-layer centroid x (grid coords), NaN when the layer is empty. */
  layerCentroidX: Float32Array;
  layerCentroidY: Float32Array;
}

export interface VoxelizeOptions {
  /** Max cells along the larger xy dimension. */
  maxXYResolution?: number;
  /** Max layers along z. */
  maxLayers?: number;
}

export function voxelize(mesh: Mesh, opts: VoxelizeOptions = {}): VoxelGrid {
  const maxXY = opts.maxXYResolution ?? 96;
  const maxZ = opts.maxLayers ?? 160;

  const box = computeBBox(mesh);
  const sx = Math.max(box.max[0] - box.min[0], 1e-6);
  const sy = Math.max(box.max[1] - box.min[1], 1e-6);
  const sz = Math.max(box.max[2] - box.min[2], 1e-6);

  const cellXY = Math.max(sx, sy) / maxXY;
  const nx = Math.max(1, Math.ceil(sx / cellXY));
  const ny = Math.max(1, Math.ceil(sy / cellXY));
  const cellZ = Math.max(sz / maxZ, 0.05);
  const nz = Math.max(1, Math.ceil(sz / cellZ));

  // Crossing lists per column.
  const crossings: number[][] = new Array(nx * ny);

  const v = mesh.vertices;
  const idx = mesh.indices;
  const ox = box.min[0];
  const oy = box.min[1];
  const oz = box.min[2];

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ax = v[a] - ox, ay = v[a + 1] - oy, az = v[a + 2] - oz;
    const bx = v[b] - ox, by = v[b + 1] - oy, bz = v[b + 2] - oz;
    const cx = v[c] - ox, cy = v[c + 1] - oy, cz = v[c + 2] - oz;

    const minGX = Math.max(0, Math.floor(Math.min(ax, bx, cx) / cellXY - 0.5));
    const maxGX = Math.min(nx - 1, Math.ceil(Math.max(ax, bx, cx) / cellXY - 0.5));
    const minGY = Math.max(0, Math.floor(Math.min(ay, by, cy) / cellXY - 0.5));
    const maxGY = Math.min(ny - 1, Math.ceil(Math.max(ay, by, cy) / cellXY - 0.5));

    for (let gy = minGY; gy <= maxGY; gy++) {
      const py = (gy + 0.5) * cellXY;
      for (let gx = minGX; gx <= maxGX; gx++) {
        const px = (gx + 0.5) * cellXY;
        // Barycentric point-in-triangle in xy.
        const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        if (hasNeg && hasPos) continue; // outside
        const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area2) < 1e-12) continue; // vertical/degenerate in xy
        const w0 = d2 / area2;
        const w1 = d3 / area2;
        const w2 = d1 / area2;
        const z = w0 * az + w1 * bz + w2 * cz;
        const col = gy * nx + gx;
        (crossings[col] ??= []).push(z);
      }
    }
  }

  const occupancy = new Uint8Array(nx * ny * nz);
  const layerCounts = new Uint32Array(nz);
  const sumX = new Float64Array(nz);
  const sumY = new Float64Array(nz);

  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const list = crossings[gy * nx + gx];
      if (!list || list.length < 2) continue;
      list.sort((p, q) => p - q);
      // Deduplicate near-identical crossings (shared edges / touching tris).
      const uniq: number[] = [];
      for (const z of list) {
        if (uniq.length === 0 || z - uniq[uniq.length - 1] > cellZ * 0.25) uniq.push(z);
      }
      for (let s = 0; s + 1 < uniq.length; s += 2) {
        const z0 = uniq[s];
        const z1 = uniq[s + 1];
        const k0 = Math.max(0, Math.floor(z0 / cellZ));
        const k1 = Math.min(nz - 1, Math.ceil(z1 / cellZ) - 1);
        for (let k = k0; k <= k1; k++) {
          const cellIdx = k * nx * ny + gy * nx + gx;
          if (!occupancy[cellIdx]) {
            occupancy[cellIdx] = 1;
            layerCounts[k]++;
            sumX[k] += gx + 0.5;
            sumY[k] += gy + 0.5;
          }
        }
      }
    }
  }

  const layerCentroidX = new Float32Array(nz);
  const layerCentroidY = new Float32Array(nz);
  for (let k = 0; k < nz; k++) {
    layerCentroidX[k] = layerCounts[k] ? sumX[k] / layerCounts[k] : NaN;
    layerCentroidY[k] = layerCounts[k] ? sumY[k] / layerCounts[k] : NaN;
  }

  return {
    nx,
    ny,
    nz,
    cellXY,
    cellZ,
    origin: [box.min[0], box.min[1], box.min[2]],
    occupancy,
    layerCounts,
    layerCentroidX,
    layerCentroidY,
  };
}
