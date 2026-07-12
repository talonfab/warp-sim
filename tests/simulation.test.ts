import { describe, expect, it } from 'vitest';
import { boxMesh } from '../src/lib/demo';
import { voxelize } from '../src/lib/voxelize';
import { applyTransform, computeBBox, centerOnBed } from '../src/lib/geometry';
import {
  simulate,
  computePartMetrics,
  lockInFraction,
  envTempAt,
} from '../src/lib/simulation';
import { getFilament, matchFilamentType } from '../src/lib/filaments';

const f = (id: string) => {
  const fil = getFilament(id);
  if (!fil) throw new Error(`missing filament ${id}`);
  return fil;
};

describe('geometry', () => {
  it('applies 3MF transforms (translation row)', () => {
    const v = new Float32Array([1, 2, 3]);
    const t = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30];
    const out = applyTransform(v, t);
    expect(Array.from(out)).toEqual([11, 22, 33]);
  });

  it('centres a part on the bed', () => {
    const mesh = centerOnBed(boxMesh(40, 20, 10));
    const box = computeBBox(mesh);
    expect(box.min[2]).toBeCloseTo(0, 5);
    expect(box.min[0]).toBeCloseTo(-20, 4);
    expect(box.max[1]).toBeCloseTo(10, 4);
  });
});

describe('voxelize', () => {
  it('recovers the footprint of a box', () => {
    const grid = voxelize(centerOnBed(boxMesh(100, 50, 10)));
    const metrics = computePartMetrics(grid);
    expect(metrics.footprintArea).toBeGreaterThan(100 * 50 * 0.9);
    expect(metrics.footprintArea).toBeLessThan(100 * 50 * 1.1);
    expect(metrics.height).toBeGreaterThan(9);
    expect(metrics.height).toBeLessThan(11.5);
    expect(metrics.aspectRatio).toBeGreaterThan(1.8);
    expect(metrics.aspectRatio).toBeLessThan(2.2);
  });

  it('fills interior layers, not just the shell', () => {
    const grid = voxelize(centerOnBed(boxMesh(20, 20, 20)));
    const mid = Math.floor(grid.nz / 2);
    expect(grid.layerCounts[mid]).toBeGreaterThan(0);
    // Every layer of a box should have roughly equal area.
    expect(grid.layerCounts[mid]).toBeGreaterThan(grid.layerCounts[0] * 0.85);
  });
});

describe('thermal model', () => {
  it('bed influence decays with height', () => {
    expect(envTempAt(0, 100, 25)).toBeCloseTo(100, 1);
    expect(envTempAt(50, 100, 25)).toBeLessThan(30);
  });

  it('locks in no differential strain when held near or above lock temperature', () => {
    expect(lockInFraction(110, 100)).toBe(0);
    // Within the stress-relaxation band below lock-in, creep still bleeds
    // the stress away (why PLA on a 60 °C bed prints flat).
    expect(lockInFraction(85, 100)).toBe(0);
    // Even stone cold, the strain picked up inside the band never loads
    // the part, so the locked fraction stays below 1.
    expect(lockInFraction(25, 100)).toBeGreaterThan(0.6);
    expect(lockInFraction(25, 100)).toBeLessThan(1);
    expect(lockInFraction(60, 100)).toBeGreaterThan(0.15);
    expect(lockInFraction(60, 100)).toBeLessThan(0.4);
  });
});

describe('warp simulation ranking', () => {
  const plate = voxelize(centerOnBed(boxMesh(140, 60, 5)));
  const cube = voxelize(centerOnBed(boxMesh(25, 25, 25)));
  const auto = { brim: false };

  it('ranks ABS well above PLA on a flat plate', () => {
    const pla = simulate(plate, f('pla'), auto);
    const abs = simulate(plate, f('abs'), auto);
    expect(abs.score).toBeGreaterThan(pla.score * 1.5);
  });

  it('carbon-filled grades warp less than their base polymer', () => {
    // Compare on an open printer, where locked-in strain actually develops.
    const box = voxelize(centerOnBed(boxMesh(140, 60, 20)));
    const openCold = { brim: false, chamberTemp: 25 };
    const asa = simulate(box, f('asa'), openCold).score;
    const asaCf10 = simulate(box, f('asa-cf10'), openCold).score;
    const asaCf20 = simulate(box, f('asa-cf20'), openCold).score;
    expect(asaCf10).toBeLessThan(asa);
    expect(asaCf20).toBeLessThan(asaCf10); // more fibre, less warp
    expect(simulate(box, f('petg-cf'), openCold).score).toBeLessThan(
      simulate(box, f('petg'), openCold).score,
    );
  });

  it('PAHT-CF warps less than PA6-CF but more than PLA', () => {
    const paht = simulate(plate, f('paht-cf'), auto);
    const pa6 = simulate(plate, f('pa6-cf'), auto);
    const pla = simulate(plate, f('pla'), auto);
    expect(paht.score).toBeLessThanOrEqual(pa6.score);
    expect(paht.score).toBeGreaterThan(pla.score);
  });

  it('a large part is riskier than a small cube under the same conditions', () => {
    // Compare where warp actually happens: an open printer. (In a chamber a
    // thin plate on a 100 °C bed is held near lock-in and both are benign.)
    const box = voxelize(centerOnBed(boxMesh(140, 60, 20)));
    const openCold = { brim: false, chamberTemp: 25 };
    expect(simulate(box, f('abs'), openCold).score).toBeGreaterThan(
      simulate(cube, f('abs'), openCold).score,
    );
  });

  it('a brim reduces risk', () => {
    expect(simulate(plate, f('abs'), { brim: true }).score).toBeLessThan(
      simulate(plate, f('abs'), auto).score,
    );
  });

  it('printing ABS in a cold open printer is worse than with its chamber', () => {
    const open = simulate(plate, f('abs'), { brim: false, chamberTemp: 25 });
    const chambered = simulate(plate, f('abs'), { brim: false });
    expect(open.score).toBeGreaterThan(chambered.score);
  });

  it('plate surface changes the outcome', () => {
    const box = voxelize(centerOnBed(boxMesh(140, 60, 20)));
    const openCold = { brim: false, chamberTemp: 25 };
    const onTextured = simulate(box, f('abs'), { ...openCold, bedSurface: 'textured-pei' });
    const onCool = simulate(box, f('abs'), { ...openCold, bedSurface: 'cool-smooth' });
    const onSmooth = simulate(box, f('abs'), { ...openCold, bedSurface: 'smooth-pei' });
    expect(onCool.score).toBeGreaterThan(onTextured.score);
    expect(onSmooth.score).toBeLessThanOrEqual(onTextured.score);
    // A poorly matched surface should be called out.
    expect(onCool.recommendations.some((r) => /plate surface/i.test(r))).toBe(true);
  });

  it('TPU shows low warp despite high shrink (too soft)', () => {
    expect(simulate(plate, f('tpu'), auto).bucket).toBe('low');
  });

  it('produces a corner field that peaks away from the centroid', () => {
    const res = simulate(plate, f('abs'), auto);
    const { nx, ny } = plate;
    const centre = res.cornerField[Math.floor(ny / 2) * nx + Math.floor(nx / 2)];
    let max = 0;
    for (let i = 0; i < res.cornerField.length; i++) max = Math.max(max, res.cornerField[i]);
    expect(max).toBeGreaterThan(centre * 1.5);
  });
});

describe('filament matching', () => {
  it('maps slicer filament_type strings to database entries', () => {
    expect(matchFilamentType('PLA Basic')?.id).toBe('pla');
    expect(matchFilamentType('PAHT-CF')?.id).toBe('paht-cf');
    // Unknown fibre fraction assumes the conservative (warpier) 10 % grade.
    expect(matchFilamentType('ASA-CF')?.id).toBe('asa-cf10');
    expect(matchFilamentType('ASA-CF20')?.id).toBe('asa-cf20');
    expect(matchFilamentType('ASA-CF 20 %')?.id).toBe('asa-cf20');
    expect(matchFilamentType('ASA Aero')?.id).toBe('asa-cf10');
    expect(matchFilamentType('ASA')?.id).toBe('asa');
    expect(matchFilamentType('PA6-CF')?.id).toBe('pa6-cf');
    expect(matchFilamentType('PETG HF')?.id).toBe('petg');
    expect(matchFilamentType('unknownium')).toBeUndefined();
  });
});
