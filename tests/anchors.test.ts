/**
 * Calibration anchors: box-part scenarios with known real-world outcomes.
 * These pin the score buckets to reality so retuning constants can't silently
 * drift into over- or under-warning. Run with CAL_TABLE=1 to print the table.
 */
import { describe, expect, it } from 'vitest';
import { boxMesh } from '../src/lib/demo';
import { voxelize } from '../src/lib/voxelize';
import { simulate } from '../src/lib/simulation';
import { getFilament } from '../src/lib/filaments';

interface Anchor {
  label: string;
  filament: string;
  size: [number, number, number];
  bed: number;
  chamber: number;
  brim?: boolean;
  /** Inclusive score window the anchor must land in. */
  window: [number, number];
  expected: string;
}

const ANCHORS: Anchor[] = [
  // Prints that come out flat in practice must not be flagged.
  { label: 'PLA 200×200×5, bed 60, open printer', filament: 'pla', size: [200, 200, 5], bed: 60, chamber: 25, window: [0, 19], expected: 'low' },
  { label: 'PLA 140×60×5, bed 60, open printer', filament: 'pla', size: [140, 60, 5], bed: 60, chamber: 25, window: [0, 19], expected: 'low' },
  { label: 'PLA 25 mm cube', filament: 'pla', size: [25, 25, 25], bed: 60, chamber: 25, window: [0, 10], expected: 'low' },
  { label: 'PETG 150×150×8, bed 70, open printer', filament: 'petg', size: [150, 150, 8], bed: 70, chamber: 25, window: [0, 19], expected: 'low' },
  { label: 'PETG 256×256×3 full sheet, bed 70', filament: 'petg', size: [256, 256, 3], bed: 70, chamber: 25, window: [0, 44], expected: '≤ moderate' },
  { label: 'TPU 140×60×5', filament: 'tpu', size: [140, 60, 5], bed: 40, chamber: 25, window: [0, 19], expected: 'low' },
  { label: 'ABS 140×60×20 box, chamber 60 (heated chamber)', filament: 'abs', size: [140, 60, 20], bed: 100, chamber: 60, window: [0, 44], expected: 'low–moderate' },
  // Known warpers must still be flagged. A 100 °C bed holds a *thin* ABS
  // plate near lock-in, so height is what exposes ABS to cold air.
  { label: 'ABS 140×60×5 thin plate, open printer', filament: 'abs', size: [140, 60, 5], bed: 100, chamber: 25, window: [10, 55], expected: 'borderline' },
  { label: 'ABS 140×60×20 box, open printer, no brim', filament: 'abs', size: [140, 60, 20], bed: 100, chamber: 25, window: [45, 100], expected: 'high or severe' },
  { label: 'ABS 140×60×20 box, chamber 45 + brim', filament: 'abs', size: [140, 60, 20], bed: 100, chamber: 45, brim: true, window: [15, 44], expected: 'moderate' },
  { label: 'PAHT-CF 150×100×8, chamber 60 (heated chamber)', filament: 'paht-cf', size: [150, 100, 8], bed: 100, chamber: 60, window: [25, 60], expected: 'moderate–high' },
  { label: 'PAHT-CF 150×100×8, open printer', filament: 'paht-cf', size: [150, 100, 8], bed: 100, chamber: 25, window: [45, 100], expected: 'high or severe' },
];

function run(a: Anchor) {
  const grid = voxelize(boxMesh(...a.size));
  return simulate(grid, getFilament(a.filament)!, {
    brim: a.brim ?? false,
    bedTemp: a.bed,
    chamberTemp: a.chamber,
  });
}

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;

describe('calibration anchors', () => {
  if (env?.CAL_TABLE) {
    it('prints the calibration table', () => {
      console.table(
        ANCHORS.map((a) => {
          const res = run(a);
          const ok = res.score >= a.window[0] && res.score <= a.window[1];
          return {
            anchor: a.label,
            score: res.score,
            bucket: res.bucket,
            window: `${a.window[0]}–${a.window[1]} (${a.expected})`,
            ok: ok ? '✓' : '✗',
          };
        }),
      );
    });
  }

  for (const a of ANCHORS) {
    it(`${a.label} → ${a.expected}`, () => {
      const res = run(a);
      expect(res.score, `score ${res.score} (${res.bucket})`).toBeGreaterThanOrEqual(a.window[0]);
      expect(res.score, `score ${res.score} (${res.bucket})`).toBeLessThanOrEqual(a.window[1]);
    });
  }
});
