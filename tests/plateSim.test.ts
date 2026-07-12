import { describe, expect, it } from 'vitest';
import { boxMesh } from '../src/lib/demo';
import { voxelize } from '../src/lib/voxelize';
import { applyTransform, centerMeshesOnBed, Mesh } from '../src/lib/geometry';
import { bedSurfaceFromBedType, getFilament } from '../src/lib/filaments';
import { inferChamberTemp } from '../src/lib/printers';
import { resolveConditions, simulatePlate } from '../src/lib/plateSim';
import { SlicerSettings } from '../src/lib/threemf';

const f = (id: string) => {
  const fil = getFilament(id);
  if (!fil) throw new Error(`missing filament ${id}`);
  return fil;
};

const HEATED_CHAMBER_PROJECT: SlicerSettings = {
  filamentTypes: ['PLA', 'ABS'],
  bedType: 'Textured PEI Plate',
  bedTemps: [65, 95],
  chamberTemps: [0, 60],
  brimType: 'no_brim',
  printerModel: 'H2D',
};

describe('resolveConditions', () => {
  it('uses the sliced bed and chamber temps for matching filaments', () => {
    const abs = resolveConditions(f('abs'), HEATED_CHAMBER_PROJECT, { brim: false });
    expect(abs.bedTemp).toBe(95);
    expect(abs.chamberTemp).toBe(60);
  });

  it('infers the chamber from the printer model when the project says 0', () => {
    const pla = resolveConditions(f('pla'), HEATED_CHAMBER_PROJECT, { brim: false });
    expect(pla.bedTemp).toBe(65);
    // PLA chamber is capped by the filament, not the printer.
    expect(pla.chamberTemp).toBe(35);

    const openProject = { ...HEATED_CHAMBER_PROJECT, chamberTemps: [0, 0], printerModel: 'A1' };
    const abs = resolveConditions(f('abs'), openProject, { brim: false });
    // An open frame can't hold a chamber even though ABS wants one.
    expect(abs.chamberTemp).toBe(25);
  });

  it('falls back to filament recommendations for filaments not in the project', () => {
    const petg = resolveConditions(f('petg'), HEATED_CHAMBER_PROJECT, { brim: false });
    expect(petg.bedTemp).toBe(f('petg').bedTemp);
  });

  it('lets per-filament UI overrides win over everything', () => {
    const overrides = { abs: { bedTemp: 80, chamberTemp: 30 } };
    const abs = resolveConditions(f('abs'), HEATED_CHAMBER_PROJECT, { brim: true, perFilament: overrides });
    expect(abs.bedTemp).toBe(80);
    expect(abs.chamberTemp).toBe(30);
    expect(abs.brim).toBe(true);
    // Overriding ABS must not leak into other filaments.
    const pla = resolveConditions(f('pla'), HEATED_CHAMBER_PROJECT, { brim: true, perFilament: overrides });
    expect(pla.bedTemp).toBe(65);
  });

  it('resolves brim per filament over the baseline', () => {
    const overrides = { abs: { brim: true } };
    const ui = { brim: false, perFilament: overrides };
    expect(resolveConditions(f('abs'), HEATED_CHAMBER_PROJECT, ui).brim).toBe(true);
    expect(resolveConditions(f('pla'), HEATED_CHAMBER_PROJECT, ui).brim).toBe(false);
  });

  it('resolves the plate surface from the project, overridable', () => {
    expect(resolveConditions(f('abs'), HEATED_CHAMBER_PROJECT, { brim: false }).bedSurface).toBe(
      'textured-pei',
    );
    expect(
      resolveConditions(f('abs'), HEATED_CHAMBER_PROJECT, { brim: false, bedSurface: 'smooth-pei' })
        .bedSurface,
    ).toBe('smooth-pei');
  });
});

describe('bedSurfaceFromBedType', () => {
  it('maps slicer bed type strings', () => {
    expect(bedSurfaceFromBedType('Textured PEI Plate')).toBe('textured-pei');
    expect(bedSurfaceFromBedType('High Temp Plate')).toBe('smooth-pei');
    expect(bedSurfaceFromBedType('Engineering Plate')).toBe('smooth-pei');
    expect(bedSurfaceFromBedType('Cool Plate (SuperTack)')).toBe('high-tack');
    expect(bedSurfaceFromBedType('Cool Plate')).toBe('cool-smooth');
    expect(bedSurfaceFromBedType(undefined)).toBeUndefined();
  });
});

describe('inferChamberTemp', () => {
  it('classifies known printer models', () => {
    expect(inferChamberTemp('H2D', f('abs'))).toBe(60); // hot filament reaches machine max
    expect(inferChamberTemp('H2D', f('pla'))).toBe(35); // capped by cold filament's default
    expect(inferChamberTemp('X1E', f('pc'))).toBe(60);
    expect(inferChamberTemp('P1S', f('abs'))).toBe(40); // capped by passive enclosure
    expect(inferChamberTemp('A1 mini', f('abs'))).toBe(25);
    expect(inferChamberTemp('SomeOther Printer', f('abs'))).toBeUndefined();
    expect(inferChamberTemp(undefined, f('abs'))).toBeUndefined();
  });
});

describe('simulatePlate', () => {
  const cold = { brim: false, chamberTemp: 25 };

  function distantCubes(): Mesh[] {
    const a = boxMesh(25, 25, 25);
    const b = boxMesh(25, 25, 25);
    return centerMeshesOnBed([
      a,
      { vertices: applyTransform(b.vertices, [1, 0, 0, 0, 1, 0, 0, 0, 1, 200, 0, 0]), indices: b.indices },
    ]);
  }

  it('two distant cubes score like one cube, not like one huge part', () => {
    const single = boxMesh(25, 25, 25);
    const singleScore = simulatePlate([single], [voxelize(single)], f('asa'), cold).score;

    const pair = distantCubes();
    const pairScore = simulatePlate(pair, pair.map((m) => voxelize(m)), f('asa'), cold).score;

    // Regression: the old merged-footprint model scored the pair ~6× worse.
    expect(Math.abs(pairScore - singleScore)).toBeLessThanOrEqual(3);
  });

  it('reports the worst object on the plate', () => {
    const cube = boxMesh(25, 25, 25);
    const box = boxMesh(140, 60, 20);
    const objects = centerMeshesOnBed([
      cube,
      { vertices: applyTransform(box.vertices, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 120, 0]), indices: box.indices },
    ]);
    const grids = objects.map((m) => voxelize(m));
    const result = simulatePlate(objects, grids, f('abs'), cold);
    expect(result.worstIndex).toBe(1);
    expect(result.score).toBe(result.objects[1].result.score);
    expect(result.score).toBeGreaterThan(result.objects[0].result.score);
  });
});
