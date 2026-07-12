/** Triangle mesh in millimetres. */
export interface Mesh {
  /** xyz triples. */
  vertices: Float32Array;
  /** Vertex indices, 3 per triangle. */
  indices: Uint32Array;
}

export interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** 3MF transform: 12 numbers, rows of a 4x3 matrix (last row = translation). */
export type Transform3MF = number[];

export const IDENTITY: Transform3MF = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function composeTransforms(a: Transform3MF, b: Transform3MF): Transform3MF {
  // Result applies b first, then a (v' = (v * B) * A).
  const r = new Array<number>(12).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += b[row * 3 + k] * a[k * 3 + col];
      if (row === 3) s += a[9 + col];
      r[row * 3 + col] = s;
    }
  }
  return r;
}

export function applyTransform(vertices: Float32Array, t: Transform3MF): Float32Array {
  const out = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    const z = vertices[i + 2];
    out[i] = x * t[0] + y * t[3] + z * t[6] + t[9];
    out[i + 1] = x * t[1] + y * t[4] + z * t[7] + t[10];
    out[i + 2] = x * t[2] + y * t[5] + z * t[8] + t[11];
  }
  return out;
}

export function parseTransformAttr(attr: string | null | undefined): Transform3MF {
  if (!attr) return IDENTITY;
  const parts = attr.trim().split(/\s+/).map(Number);
  if (parts.length !== 12 || parts.some((n) => !Number.isFinite(n))) return IDENTITY;
  return parts;
}

export function mergeMeshes(meshes: Mesh[]): Mesh {
  let nv = 0;
  let ni = 0;
  for (const m of meshes) {
    nv += m.vertices.length;
    ni += m.indices.length;
  }
  const vertices = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    vertices.set(m.vertices, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.vertices.length;
    io += m.indices.length;
  }
  return { vertices, indices };
}

export function computeBBox(mesh: Mesh): BBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const c = v[i + a];
      if (c < min[a]) min[a] = c;
      if (c > max[a]) max[a] = c;
    }
  }
  return { min, max };
}

/**
 * Subdivide triangles until no edge exceeds maxEdge, returning a triangle
 * soup (sequentially indexed). Used for display: per-vertex risk colours are
 * meaningless on parts with large flat faces unless the faces carry enough
 * vertices to paint a gradient across them.
 */
export function subdivideMesh(mesh: Mesh, maxEdge: number, maxTriangles = 300000): Mesh {
  const src = mesh.vertices;
  const out: number[] = [];

  const emit = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => {
    out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  };

  const subdivide = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    depth: number,
  ): void => {
    const eab = Math.hypot(bx - ax, by - ay, bz - az);
    const ebc = Math.hypot(cx - bx, cy - by, cz - bz);
    const eca = Math.hypot(ax - cx, ay - cy, az - cz);
    // Past the budget, emit unrefined — colours are just coarser there.
    if (depth <= 0 || Math.max(eab, ebc, eca) <= maxEdge || out.length / 9 >= maxTriangles) {
      emit(ax, ay, az, bx, by, bz, cx, cy, cz);
      return;
    }
    const mabx = (ax + bx) / 2, maby = (ay + by) / 2, mabz = (az + bz) / 2;
    const mbcx = (bx + cx) / 2, mbcy = (by + cy) / 2, mbcz = (bz + cz) / 2;
    const mcax = (cx + ax) / 2, mcay = (cy + ay) / 2, mcaz = (cz + az) / 2;
    subdivide(ax, ay, az, mabx, maby, mabz, mcax, mcay, mcaz, depth - 1);
    subdivide(mabx, maby, mabz, bx, by, bz, mbcx, mbcy, mbcz, depth - 1);
    subdivide(mcax, mcay, mcaz, mbcx, mbcy, mbcz, cx, cy, cz, depth - 1);
    subdivide(mabx, maby, mabz, mbcx, mbcy, mbcz, mcax, mcay, mcaz, depth - 1);
  };

  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] * 3;
    const b = mesh.indices[t + 1] * 3;
    const c = mesh.indices[t + 2] * 3;
    subdivide(
      src[a], src[a + 1], src[a + 2],
      src[b], src[b + 1], src[b + 2],
      src[c], src[c + 1], src[c + 2],
      8,
    );
  }
  const vertices = new Float32Array(out);
  const indices = new Uint32Array(vertices.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { vertices, indices };
}

/** Translate so the part sits on z=0 with its xy centre at the origin. */
export function centerOnBed(mesh: Mesh): Mesh {
  return centerMeshesOnBed([mesh])[0];
}

/**
 * Translate a group of meshes by one shared offset so the group's union
 * bounding box sits on z=0 centred at the xy origin. Relative positions
 * within the group (e.g. parts laid out on a build plate) are preserved.
 */
export function centerMeshesOnBed(meshes: Mesh[]): Mesh[] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const box = computeBBox(mesh);
    for (let a = 0; a < 3; a++) {
      if (box.min[a] < min[a]) min[a] = box.min[a];
      if (box.max[a] > max[a]) max[a] = box.max[a];
    }
  }
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const dz = min[2];
  return meshes.map((mesh) => {
    const vertices = new Float32Array(mesh.vertices.length);
    for (let i = 0; i < vertices.length; i += 3) {
      vertices[i] = mesh.vertices[i] - cx;
      vertices[i + 1] = mesh.vertices[i + 1] - cy;
      vertices[i + 2] = mesh.vertices[i + 2] - dz;
    }
    return { vertices, indices: mesh.indices };
  });
}
