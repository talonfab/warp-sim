// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parse3MF, parseSTL } from '../src/lib/threemf';
import { computeBBox } from '../src/lib/geometry';

const CUBE_MESH_XML = `
  <mesh>
    <vertices>
      <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>
      <vertex x="10" y="10" z="0"/><vertex x="0" y="10" z="0"/>
      <vertex x="0" y="0" z="10"/><vertex x="10" y="0" z="10"/>
      <vertex x="10" y="10" z="10"/><vertex x="0" y="10" z="10"/>
    </vertices>
    <triangles>
      <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/>
      <triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
      <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/>
      <triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/>
      <triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/>
      <triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/>
    </triangles>
  </mesh>`;

function zip(entries: Record<string, string>): ArrayBuffer {
  const files: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) files[k] = strToU8(v);
  const out = zipSync(files);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function plateMeta(id: number, instances: Array<[objectId: number, instanceId: number]>): string {
  return `<plate>
    <metadata key="plater_id" value="${id}"/>
    <metadata key="plater_name" value=""/>
    ${instances
      .map(
        ([obj, inst]) => `<model_instance>
          <metadata key="object_id" value="${obj}"/>
          <metadata key="instance_id" value="${inst}"/>
        </model_instance>`,
      )
      .join('\n')}
  </plate>`;
}

describe('parse3MF', () => {
  it('parses a single-object model, preserving item-transform layout within the plate', () => {
    const buf = zip({
      '3D/3dmodel.model': `<?xml version="1.0"?>
        <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
          <resources><object id="1" type="model">${CUBE_MESH_XML}</object></resources>
          <build>
            <item objectid="1"/>
            <item objectid="1" transform="1 0 0 0 1 0 0 0 1 40 0 0"/>
          </build>
        </model>`,
    });
    const info = parse3MF(buf, 'cubes.3mf');
    expect(info.plates).toHaveLength(1);
    expect(info.plates[0].objects).toHaveLength(2);
    expect(info.objectCount).toBe(2);
    const a = computeBBox(info.plates[0].objects[0]);
    const b = computeBBox(info.plates[0].objects[1]);
    // Plate is centered as a whole; the 40 mm offset between items survives.
    expect(b.min[0] - a.min[0]).toBeCloseTo(40);
    expect(a.min[2]).toBeCloseTo(0);
    // Union spans -25..25 in x (two 10 mm cubes, 40 mm apart, centered).
    expect(a.min[0]).toBeCloseTo(-25);
    expect(b.max[0]).toBeCloseTo(25);
  });

  it('follows production-extension p:path component references and reads project settings', () => {
    const buf = zip({
      '3D/3dmodel.model': `<?xml version="1.0"?>
        <model unit="millimeter"
               xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
               xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
          <resources>
            <object id="2" type="model">
              <components><component objectid="1" p:path="/3D/Objects/object_1.model"/></components>
            </object>
          </resources>
          <build><item objectid="2"/></build>
        </model>`,
      '3D/Objects/object_1.model': `<?xml version="1.0"?>
        <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
          <resources><object id="1" type="model">${CUBE_MESH_XML}</object></resources>
          <build/>
        </model>`,
      'Metadata/project_settings.config': JSON.stringify({
        filament_type: ['PAHT-CF', 'PLA'],
        hot_plate_temp: ['100', '60'],
      }),
    });
    const info = parse3MF(buf, 'project.3mf');
    expect(info.plates[0].objects[0].vertices.length).toBe(24);
    expect(info.settings.filamentTypes).toEqual(['PAHT-CF', 'PLA']);
    expect(info.settings.bedTemps).toEqual([100, 60]);
  });

  it('splits objects across build plates and skips unprintable items', () => {
    const buf = zip({
      '3D/3dmodel.model': `<?xml version="1.0"?>
        <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
          <resources>
            <object id="1" type="model">${CUBE_MESH_XML}</object>
            <object id="2" type="model">${CUBE_MESH_XML}</object>
          </resources>
          <build>
            <item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/>
            <item objectid="1" transform="1 0 0 0 1 0 0 0 1 420 100 0"/>
            <item objectid="2" transform="1 0 0 0 1 0 0 0 1 140 100 0"/>
            <item objectid="2" transform="1 0 0 0 1 0 0 0 1 460 140 0" printable="0"/>
          </build>
        </model>`,
      'Metadata/model_settings.config': `<?xml version="1.0"?>
        <config>
          ${plateMeta(1, [
            [1, 0],
            [2, 0],
          ])}
          ${plateMeta(2, [[1, 1]])}
        </config>`,
      'Metadata/project_settings.config': JSON.stringify({
        filament_type: ['PLA', 'ABS'],
        curr_bed_type: 'Textured PEI Plate',
        textured_plate_temp: ['65', '100'],
        hot_plate_temp: ['60', '100'],
        chamber_temperatures: ['0', '60'],
        brim_type: 'no_brim',
        brim_width: '5',
        printer_model: 'H2D',
      }),
    });
    const info = parse3MF(buf, 'multiplate.3mf');

    expect(info.plates).toHaveLength(2);
    expect(info.plates[0].id).toBe(1);
    expect(info.plates[0].objects).toHaveLength(2); // cube 1 instance 0 + cube 2
    expect(info.plates[1].id).toBe(2);
    expect(info.plates[1].objects).toHaveLength(1); // cube 1 instance 1
    expect(info.objectCount).toBe(3); // printable="0" item skipped

    // Each plate is centered independently: the lone cube on plate 2 sits at
    // the origin instead of 320 mm off to the side.
    const lone = computeBBox(info.plates[1].objects[0]);
    expect((lone.min[0] + lone.max[0]) / 2).toBeCloseTo(0);
    expect(lone.min[2]).toBeCloseTo(0);
    // Plate 1 keeps the 40 mm layout offset between its two cubes.
    const p1a = computeBBox(info.plates[0].objects[0]);
    const p1b = computeBBox(info.plates[0].objects[1]);
    expect(p1b.min[0] - p1a.min[0]).toBeCloseTo(40);

    // Sliced settings: textured plate temps win over hot plate temps.
    expect(info.settings.bedType).toBe('Textured PEI Plate');
    expect(info.settings.bedTemps).toEqual([65, 100]);
    expect(info.settings.chamberTemps).toEqual([0, 60]);
    expect(info.settings.brimType).toBe('no_brim');
    expect(info.settings.brimWidth).toBe(5);
    expect(info.settings.printerModel).toBe('H2D');
  });

  it('splits far-apart objects into areas when there is no plate layout', () => {
    const buf = zip({
      '3D/3dmodel.model': `<?xml version="1.0"?>
        <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
          <resources><object id="1" type="model">${CUBE_MESH_XML}</object></resources>
          <build>
            <item objectid="1"/>
            <item objectid="1" transform="1 0 0 0 1 0 0 0 1 500 0 0"/>
          </build>
        </model>`,
    });
    const info = parse3MF(buf, 'wide.3mf');
    // 500 mm apart cannot be one bed: grouped into two areas, each centered.
    expect(info.plates).toHaveLength(2);
    expect(info.plates[0].objects).toHaveLength(1);
    expect(info.plates[1].objects).toHaveLength(1);
    for (const plate of info.plates) {
      const box = computeBBox(plate.objects[0]);
      expect((box.min[0] + box.max[0]) / 2).toBeCloseTo(0);
    }
  });

  it('rejects archives without geometry', () => {
    const buf = zip({ 'Metadata/readme.txt': 'nothing here' });
    expect(() => parse3MF(buf, 'empty.3mf')).toThrow();
  });
});

describe('parseSTL', () => {
  it('parses ASCII STL', () => {
    const ascii = `solid t
      facet normal 0 0 1
        outer loop
          vertex 0 0 0
          vertex 10 0 0
          vertex 0 10 0
        endloop
      endfacet
    endsolid t`;
    const buf = strToU8(ascii);
    const info = parseSTL(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      't.stl',
    );
    const mesh = info.plates[0].objects[0];
    expect(mesh.indices.length).toBe(3);
    const box = computeBBox(mesh);
    expect(box.max[0] - box.min[0]).toBeCloseTo(10);
    expect(box.max[1] - box.min[1]).toBeCloseTo(10);
  });

  it('parses binary STL', () => {
    const nTri = 1;
    const buf = new ArrayBuffer(84 + nTri * 50);
    const view = new DataView(buf);
    view.setUint32(80, nTri, true);
    const tri = [0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 5, 0]; // normal + 3 vertices
    tri.forEach((val, i) => view.setFloat32(84 + i * 4, val, true));
    const info = parseSTL(buf, 'bin.stl');
    const mesh = info.plates[0].objects[0];
    expect(mesh.indices.length).toBe(3);
    const box = computeBBox(mesh);
    expect(box.max[0] - box.min[0]).toBeCloseTo(5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(5);
  });
});
