/**
 * Simplified thermo-mechanical warp model.
 *
 * The goal is a fast, browser-friendly estimate of *relative* warp likelihood
 * across filaments for a given part, not an FEA-grade prediction. The model
 * follows the standard qualitative physics of FFF warping:
 *
 * 1. Thermal field. While printing, material at height z equilibrates to a
 *    local environment temperature T_env(z) — dominated by the bed near z=0
 *    and decaying to the chamber/ambient temperature with height.
 *
 * 2. Stress lock-in. A layer accumulates "differential" shrink strain only
 *    once it drops below the material's lock-in temperature (≈ Tg for
 *    amorphous polymers, ≈ crystallisation temperature for semi-crystalline
 *    ones). Layers that the heated bed keeps *above* lock-in during the print
 *    shrink together with the part during final cooldown, which produces far
 *    less warp — this is exactly why hot beds and heated chambers work.
 *    Moreover, material held only slightly below lock-in still relaxes its
 *    stress viscoelastically over the minutes-long print (creep near Tg), so
 *    stress only survives once a layer sits a whole relaxation band below
 *    lock-in. This is why PLA on a 60 °C bed and PETG on a 70 °C bed print
 *    flat, while high-Tg ABS/PC and high-crystallisation-point nylons sit far
 *    below their lock-in even on a 100 °C bed and keep nearly all of it.
 *
 * 3. Corner lift. The locked-in strain of the part pulls the bottom surface
 *    toward the footprint centroid. The peel stress at a bottom cell grows
 *    super-linearly with its distance from the centroid (bimetal-strip
 *    curvature acting over a longer lever) and with road stiffness, and is
 *    resisted by first-layer adhesion (improved by a brim). The lever
 *    saturates: past a bending wavelength the plate flexes instead of
 *    prying, so a 250 mm sheet is not radically worse than a 120 mm one.
 */
import { BedSurface, bedSurfaceFactor, Filament } from './filaments';
import { VoxelGrid } from './voxelize';
import { Mesh } from './geometry';

export interface SimulationSettings {
  /** Bed temperature override, °C. Defaults to the filament's recommendation. */
  bedTemp?: number;
  /** Chamber/ambient temperature around the part, °C. Defaults to the filament's typical chamber. */
  chamberTemp?: number;
  /** Whether a brim is used (improves first-layer adhesion). */
  brim: boolean;
  /** Build-plate surface; defaults to textured PEI (the adhesion baseline). */
  bedSurface?: BedSurface;
}

export type RiskBucket = 'low' | 'moderate' | 'high' | 'severe';

export interface SimulationResult {
  filament: Filament;
  /** Overall warp likelihood, 0–100. */
  score: number;
  bucket: RiskBucket;
  /** Peak peel-to-adhesion ratio at the worst bottom cell. */
  cornerLiftPeak: number;
  /** Mean differential (locked-in during print) strain across layers. */
  meanDiffStrain: number;
  /** Per-layer differential strain profile (nz entries). */
  layerStrain: Float32Array;
  /** Per-bottom-cell corner-lift risk 0..1, indexed y * nx + x. */
  cornerField: Float32Array;
  bedTemp: number;
  chamberTemp: number;
  recommendations: string[];
}

export interface PartMetrics {
  height: number;
  footprintArea: number;
  maxRadius: number;
  aspectRatio: number;
}

/** Height scale (mm) over which the bed's thermal influence decays. */
const BED_THERMAL_DECAY_MM = 7;
/** Fraction of post-print (uniform) shrink that still contributes to warp. */
const UNIFORM_SHRINK_FACTOR = 0.05;
/**
 * Material held within this band below its lock-in temperature still relaxes
 * its stress viscoelastically during the print (creep near Tg / ongoing
 * crystallisation), so only cooling further than this locks strain in.
 */
const STRESS_RELAX_BAND = 20;
/**
 * Lever normalisation: the corner distance at which a "reference bad" print
 * (plain ABS locked in cold) reaches a peel-to-adhesion ratio of ~1.
 */
const R_REF_MM = 60;
/**
 * Lever saturation length: beyond this distance the base plate bends rather
 * than prying the corner, so extra footprint stops adding leverage.
 */
const R_SAT_MM = 90;
const AMBIENT = 25;

export function bucketFor(score: number): RiskBucket {
  if (score < 20) return 'low';
  if (score < 45) return 'moderate';
  if (score < 70) return 'high';
  return 'severe';
}

export function computePartMetrics(grid: VoxelGrid): PartMetrics {
  const { nx, ny, cellXY, cellZ, occupancy, layerCounts, nz } = grid;
  let topLayer = 0;
  for (let k = 0; k < nz; k++) if (layerCounts[k] > 0) topLayer = k;
  const height = (topLayer + 1) * cellZ;

  const footprintArea = layerCounts[0] * cellXY * cellXY;
  const cx = grid.layerCentroidX[0];
  const cy = grid.layerCentroidY[0];
  let maxRadius = 0;
  let minGX = Infinity, maxGX = -Infinity, minGY = Infinity, maxGY = -Infinity;
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      if (!occupancy[gy * nx + gx]) continue;
      const dx = (gx + 0.5 - cx) * cellXY;
      const dy = (gy + 0.5 - cy) * cellXY;
      maxRadius = Math.max(maxRadius, Math.hypot(dx, dy));
      minGX = Math.min(minGX, gx);
      maxGX = Math.max(maxGX, gx);
      minGY = Math.min(minGY, gy);
      maxGY = Math.max(maxGY, gy);
    }
  }
  const w = Math.max(maxGX - minGX + 1, 1);
  const h = Math.max(maxGY - minGY + 1, 1);
  const aspectRatio = Math.max(w, h) / Math.min(w, h);
  return { height, footprintArea, maxRadius, aspectRatio };
}

/** Environment temperature at height z while printing. */
export function envTempAt(z: number, bedTemp: number, chamberTemp: number): number {
  return chamberTemp + (bedTemp - chamberTemp) * Math.exp(-z / BED_THERMAL_DECAY_MM);
}

/**
 * Differential-strain fraction for a layer held at temperature tHold:
 * 0 while the bed keeps it within the relaxation band of lock-in (stress
 * creeps away and the layer shrinks with the part during final cooldown),
 * growing as it cools further below. The fraction is of the material's total
 * shrink strain, so even a stone-cold layer keeps less than 1 — the strain
 * picked up inside the relaxation band never loads the part.
 */
export function lockInFraction(tHold: number, lockTemp: number): number {
  const lockEff = lockTemp - STRESS_RELAX_BAND;
  if (lockEff <= AMBIENT) return 0;
  const f = (lockEff - tHold) / (lockTemp - AMBIENT);
  return Math.min(1, Math.max(0, f));
}

export function simulate(
  grid: VoxelGrid,
  filament: Filament,
  settings: SimulationSettings,
): SimulationResult {
  const bedTemp = settings.bedTemp ?? filament.bedTemp;
  const chamberTemp = settings.chamberTemp ?? filament.chamberTemp;
  const { nx, ny, nz, cellXY, cellZ, layerCounts } = grid;

  // --- 1 & 2: per-layer locked-in differential strain -----------------
  const layerStrain = new Float32Array(nz);
  let strainSum = 0;
  let weightSum = 0;
  for (let k = 0; k < nz; k++) {
    if (layerCounts[k] === 0) continue;
    const z = (k + 0.5) * cellZ;
    const tHold = envTempAt(z, bedTemp, chamberTemp);
    const phi = lockInFraction(tHold, filament.lockTemp);
    // Locked-in differential strain + attenuated share of uniform shrink.
    const eps = filament.shrinkStrain * (phi + UNIFORM_SHRINK_FACTOR * (1 - phi));
    layerStrain[k] = eps;
    strainSum += eps * layerCounts[k];
    weightSum += layerCounts[k];
  }
  const meanDiffStrain = weightSum > 0 ? strainSum / weightSum : 0;

  // Strain in the lower region drives base bending; weight layers by
  // exponential decay with height so tall parts don't dominate unfairly.
  const metrics = computePartMetrics(grid);
  const hRef = Math.max(metrics.height * 0.4, 3);
  let lowerStrain = 0;
  let lowerW = 0;
  for (let k = 0; k < nz; k++) {
    if (layerCounts[k] === 0) continue;
    const z = (k + 0.5) * cellZ;
    const w = layerCounts[k] * Math.exp(-z / hRef);
    lowerStrain += layerStrain[k] * w;
    lowerW += w;
  }
  const epsBase = lowerW > 0 ? lowerStrain / lowerW : 0;

  // Taller parts have more shrinking material above the base pulling on it,
  // saturating quickly (only the first ~centimetre matters much).
  const heightFactor = Math.min(2, Math.sqrt(metrics.height / 10) + 0.5);

  // --- 3: corner lift field --------------------------------------------
  const adhesion =
    filament.bedAdhesion *
    bedSurfaceFactor(settings.bedSurface, filament) *
    (settings.brim ? 1.6 : 1.0);
  const cornerField = new Float32Array(nx * ny);
  const cx = grid.layerCentroidX[0];
  const cy = grid.layerCentroidY[0];
  let peak = 0;
  const ratios: number[] = [];
  // Reference strain scale for a "known bad" locked-in print.
  const EPS_REF = 0.003;
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      if (!grid.occupancy[gy * nx + gx]) continue; // bottom layer occupancy (k=0 block)
      const dx = (gx + 0.5 - cx) * cellXY;
      const dy = (gy + 0.5 - cy) * cellXY;
      const r = Math.hypot(dx, dy);
      // Effective lever saturates at R_SAT_MM (plate bending wavelength).
      const rEff = R_SAT_MM * (1 - Math.exp(-r / R_SAT_MM));
      // Peel force ∝ modulus × strain (a soft bead stretches instead of
      // pulling the corner up, which is why high-shrink TPU still prints flat).
      const peel =
        filament.stiffness *
        (epsBase / EPS_REF) *
        Math.pow(rEff / R_REF_MM, 1.5) *
        heightFactor;
      const ratio = peel / adhesion;
      ratios.push(ratio);
      if (ratio > peak) peak = ratio;
      cornerField[gy * nx + gx] = ratio / (1 + ratio);
    }
  }

  // Overall score: emphasise the worst corners (95th percentile).
  ratios.sort((a, b) => a - b);
  const p95 = ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.95))] : 0;
  const score = Math.round(100 * (p95 / (1 + p95)));

  const recommendations = buildRecommendations(filament, settings, score, metrics, bedTemp, chamberTemp);

  return {
    filament,
    score,
    bucket: bucketFor(score),
    cornerLiftPeak: peak,
    meanDiffStrain,
    layerStrain,
    cornerField,
    bedTemp,
    chamberTemp,
    recommendations,
  };
}

function buildRecommendations(
  f: Filament,
  settings: SimulationSettings,
  score: number,
  metrics: PartMetrics,
  bedTemp: number,
  chamberTemp: number,
): string[] {
  const recs: string[] = [];
  if (f.id === 'tpu') {
    recs.push('TPU is too soft to warp; focus on bed adhesion and slow first layers instead.');
    return recs;
  }
  if (bedSurfaceFactor(settings.bedSurface, f) < 0.8) {
    recs.push(
      `This plate surface grips ${f.family} poorly — switch to a textured or smooth PEI plate.`,
    );
  }
  if (bedTemp < f.bedTemp) {
    recs.push(`Raise the bed to ${f.bedTemp} °C (currently ${bedTemp} °C) — keeping the base above lock-in temperature is the single biggest lever.`);
  }
  if (f.needsChamber && chamberTemp < f.chamberTemp) {
    recs.push(`Use an enclosure at ~${f.chamberTemp} °C; at ${chamberTemp} °C ambient, upper layers lock in stress early.`);
  }
  if (!settings.brim && score >= 30) {
    recs.push('Add a brim (5–8 mm) to increase first-layer holding force at the corners.');
  }
  if (score >= 45 && metrics.maxRadius > 40) {
    recs.push('The footprint is large; consider splitting the part or adding mouse-ear tabs at the far corners.');
  }
  if (metrics.aspectRatio > 2.5 && score >= 30) {
    recs.push('Long, thin footprints concentrate shrink along one axis — reorienting 45° on the plate or shortening the part helps.');
  }
  if (f.family === 'PA') {
    recs.push('Dry the filament before printing and use a PA-specific adhesive (glue stick / liquid glue) on the plate.');
  }
  if (f.carbonFilled) {
    recs.push('Carbon-filled grades shrink less but are abrasive — use a hardened nozzle (0.4 mm or larger).');
  }
  if (recs.length === 0) {
    recs.push('No special precautions needed — standard plate prep should print flat.');
  }
  return recs;
}

/**
 * Map the simulation onto mesh vertices for the heatmap (0..1 per vertex).
 * Bottom-corner cells carry the corner-lift field; risk decays with height
 * but keeps a floor proportional to the local layer strain so tall chimneys
 * on a risky base still show elevated colour near the base only.
 */
export function vertexRiskField(
  mesh: Mesh,
  grid: VoxelGrid,
  result: SimulationResult,
): Float32Array {
  const { nx, ny, cellXY, cellZ, origin } = grid;
  const nVerts = mesh.vertices.length / 3;
  const out = new Float32Array(nVerts);
  const metrics = computePartMetrics(grid);
  // A lifting corner takes a region of wall with it whose height scales with
  // the footprint's lateral extent (bending wavelength), not part height.
  const decay = Math.min(15, Math.max(3, metrics.maxRadius * 0.15));
  const maxStrain = result.filament.shrinkStrain || 1e-6;
  for (let i = 0; i < nVerts; i++) {
    const x = mesh.vertices[i * 3] - origin[0];
    const y = mesh.vertices[i * 3 + 1] - origin[1];
    const z = mesh.vertices[i * 3 + 2] - origin[2];
    let gx = Math.min(nx - 1, Math.max(0, Math.round(x / cellXY - 0.5)));
    let gy = Math.min(ny - 1, Math.max(0, Math.round(y / cellXY - 0.5)));
    // Sample the nearest occupied bottom cell within a small window so the
    // shell vertices (often just outside cell centres) pick up the field.
    let corner = 0;
    for (let wy = -1; wy <= 1; wy++) {
      for (let wx = -1; wx <= 1; wx++) {
        const qx = gx + wx;
        const qy = gy + wy;
        if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
        corner = Math.max(corner, result.cornerField[qy * nx + qx]);
      }
    }
    const k = Math.min(grid.nz - 1, Math.max(0, Math.floor(z / cellZ)));
    const strainNorm = result.layerStrain[k] / maxStrain;
    out[i] = Math.min(1, corner * Math.exp(-z / decay) + 0.15 * strainNorm * corner);
  }
  return out;
}
