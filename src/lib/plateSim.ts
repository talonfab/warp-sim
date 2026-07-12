/**
 * Plate-level simulation: each build item on a plate is a separate printed
 * object that shrinks toward its own centroid, so warp is simulated per
 * object and the plate takes the score of its worst object. Print
 * conditions default to the project's sliced settings when available.
 */
import {
  BedSurface,
  bedSurfaceFromBedType,
  Filament,
  matchFilamentType,
} from './filaments';
import { SlicerSettings } from './threemf';
import { inferChamberTemp } from './printers';
import { simulate, SimulationResult, SimulationSettings, RiskBucket } from './simulation';
import { VoxelGrid } from './voxelize';
import { Mesh } from './geometry';

/** User-set conditions for one filament. */
export interface FilamentConditionOverride {
  bedTemp?: number;
  chamberTemp?: number;
  brim?: boolean;
}

export interface ConditionOverrides {
  /** Baseline brim for filaments without their own override. */
  brim: boolean;
  /** Build-plate surface (one plate per print, so this is global). */
  bedSurface?: BedSurface;
  /** Per-filament overrides keyed by filament id. */
  perFilament?: Record<string, FilamentConditionOverride>;
}

/**
 * Print conditions for one filament: UI override for that filament →
 * project sliced value (for the matching project filament) →
 * printer-inferred chamber → filament recommendation.
 */
export function resolveConditions(
  filament: Filament,
  project: SlicerSettings,
  ui: ConditionOverrides,
): SimulationSettings {
  const override = ui.perFilament?.[filament.id];
  const idx = project.filamentTypes.findIndex(
    (t) => matchFilamentType(t)?.id === filament.id,
  );
  const projectBed = idx >= 0 ? project.bedTemps?.[idx] : undefined;
  const projectChamber = idx >= 0 ? project.chamberTemps?.[idx] : undefined;
  return {
    brim: override?.brim ?? ui.brim,
    bedSurface: ui.bedSurface ?? bedSurfaceFromBedType(project.bedType) ?? 'textured-pei',
    bedTemp:
      override?.bedTemp ??
      (projectBed && projectBed > 0 ? projectBed : undefined) ??
      filament.bedTemp,
    chamberTemp:
      override?.chamberTemp ??
      (projectChamber && projectChamber > 0 ? projectChamber : undefined) ??
      inferChamberTemp(project.printerModel, filament) ??
      filament.chamberTemp,
  };
}

export interface PlateObjectResult {
  mesh: Mesh;
  grid: VoxelGrid;
  result: SimulationResult;
}

export interface PlateResult {
  filament: Filament;
  /** Worst object's score — a plate fails if any object lifts. */
  score: number;
  bucket: RiskBucket;
  bedTemp: number;
  chamberTemp: number;
  recommendations: string[];
  worstIndex: number;
  objects: PlateObjectResult[];
}

export function simulatePlate(
  objects: Mesh[],
  grids: VoxelGrid[],
  filament: Filament,
  settings: SimulationSettings,
): PlateResult {
  const perObject: PlateObjectResult[] = grids.map((grid, i) => ({
    mesh: objects[i],
    grid,
    result: simulate(grid, filament, settings),
  }));
  let worstIndex = 0;
  for (let i = 1; i < perObject.length; i++) {
    if (perObject[i].result.score > perObject[worstIndex].result.score) worstIndex = i;
  }
  const worst = perObject[worstIndex].result;
  return {
    filament,
    score: worst.score,
    bucket: worst.bucket,
    bedTemp: worst.bedTemp,
    chamberTemp: worst.chamberTemp,
    recommendations: worst.recommendations,
    worstIndex,
    objects: perObject,
  };
}
