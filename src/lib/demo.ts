import { Mesh } from './geometry';
import { ProjectInfo } from './threemf';

/** Axis-aligned watertight box, centred in xy, sitting on z=0. */
export function boxMesh(sx: number, sy: number, sz: number): Mesh {
  const x = sx / 2;
  const y = sy / 2;
  // prettier-ignore
  const vertices = new Float32Array([
    -x, -y, 0,  x, -y, 0,  x, y, 0,  -x, y, 0,
    -x, -y, sz, x, -y, sz, x, y, sz, -x, y, sz,
  ]);
  // prettier-ignore
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,       // bottom (normal -z)
    4, 5, 6, 4, 6, 7,       // top
    0, 1, 5, 0, 5, 4,       // -y
    1, 2, 6, 1, 6, 5,       // +x
    2, 3, 7, 2, 7, 6,       // +y
    3, 0, 4, 3, 4, 7,       // -x
  ]);
  return { vertices, indices };
}

function singlePartProject(mesh: Mesh, fileName: string): ProjectInfo {
  return {
    plates: [{ id: 1, objects: [mesh] }],
    objectCount: 1,
    settings: { filamentTypes: [] },
    fileName,
  };
}

export const DEMO_PARTS: Array<{ name: string; make: () => ProjectInfo }> = [
  {
    name: 'Box 140×60×20 mm (warp-prone)',
    make: () => singlePartProject(boxMesh(140, 60, 20), 'demo-box.3mf'),
  },
  {
    name: 'Small cube 25×25×25 mm (benign)',
    make: () => singlePartProject(boxMesh(25, 25, 25), 'demo-cube.3mf'),
  },
];
