/**
 * Filament material database used by the warp simulation.
 *
 * Values are representative of manufacturer datasheets and general polymer
 * literature. They are intentionally
 * "typical" numbers, not brand-exact: the simulation compares filaments
 * against each other, so relative accuracy matters more than absolute.
 *
 * Key physics captured per material:
 *  - shrinkStrain: total linear shrink from lock-in temperature to ambient
 *    (combines CTE integration and, for semi-crystalline polymers, the
 *    crystallisation volume change — the dominant warp driver for PA/PP).
 *  - lockTemp: temperature below which stress can no longer relax
 *    (~Tg for amorphous polymers, ~crystallisation temp for semi-crystalline).
 *  - stiffness: relative in-plane modulus of the printed road (PLA ≈ 3.5 GPa
 *    = 1.0; PETG/ABS/ASA ≈ 2.1–2.3 GPa ≈ 0.6–0.65; CF grades 4–5 GPa).
 *    Stiffer materials transmit more shrink force to the bed interface.
 *    Carbon fibre raises stiffness but reduces shrinkStrain much more,
 *    which is why CF grades warp less overall.
 *  - bedAdhesion: relative first-layer adhesion on the recommended plate at
 *    the recommended bed temperature (1 = PLA-on-PEI baseline).
 */

export interface Filament {
  id: string;
  name: string;
  /** Broad family for grouping in the UI. */
  family: 'PLA' | 'PETG' | 'ABS' | 'ASA' | 'PC' | 'PA' | 'TPU';
  semiCrystalline: boolean;
  carbonFilled: boolean;
  /** Typical nozzle temperature, °C. */
  nozzleTemp: number;
  /** Recommended bed temperature, °C. */
  bedTemp: number;
  /** Glass transition (amorphous) or crystallisation (semi-crystalline) lock-in temperature, °C. */
  lockTemp: number;
  /** Effective linear shrink strain from lockTemp to 25 °C (dimensionless, e.g. 0.008 = 0.8 %). */
  shrinkStrain: number;
  /** Relative road stiffness (PLA = 1.0). */
  stiffness: number;
  /** Relative first-layer adhesion on recommended plate (PLA = 1.0). */
  bedAdhesion: number;
  /** Whether an enclosed / actively heated chamber is recommended. */
  needsChamber: boolean;
  /** Typical chamber temperature achievable/recommended, °C (ambient if none). */
  chamberTemp: number;
  notes: string;
}

export const FILAMENTS: Filament[] = [
  {
    id: 'pla',
    name: 'PLA',
    family: 'PLA',
    semiCrystalline: false,
    carbonFilled: false,
    nozzleTemp: 220,
    bedTemp: 60,
    lockTemp: 60,
    shrinkStrain: 0.003,
    stiffness: 1.0,
    bedAdhesion: 1.0,
    needsChamber: false,
    chamberTemp: 35,
    notes: 'Low shrink and low lock-in temperature make PLA the least warp-prone common filament.',
  },
  {
    id: 'petg',
    name: 'PETG',
    family: 'PETG',
    semiCrystalline: false,
    carbonFilled: false,
    nozzleTemp: 250,
    bedTemp: 70,
    lockTemp: 78,
    shrinkStrain: 0.005,
    stiffness: 0.6,
    bedAdhesion: 1.2,
    needsChamber: false,
    chamberTemp: 35,
    notes: 'Slightly more shrink than PLA but excellent bed adhesion keeps warp low.',
  },
  {
    id: 'petg-cf',
    name: 'PETG-CF',
    family: 'PETG',
    semiCrystalline: false,
    carbonFilled: true,
    nozzleTemp: 260,
    bedTemp: 70,
    lockTemp: 78,
    shrinkStrain: 0.0018,
    stiffness: 1.1,
    bedAdhesion: 1.0,
    needsChamber: false,
    chamberTemp: 35,
    notes: 'Fibre fill constrains shrink to roughly a third of plain PETG.',
  },
  {
    id: 'pla-cf',
    name: 'PLA-CF',
    family: 'PLA',
    semiCrystalline: false,
    carbonFilled: true,
    nozzleTemp: 230,
    bedTemp: 60,
    lockTemp: 60,
    shrinkStrain: 0.0012,
    stiffness: 1.5,
    bedAdhesion: 0.95,
    needsChamber: false,
    chamberTemp: 35,
    notes: 'Among the most dimensionally stable filaments available.',
  },
  {
    id: 'abs',
    name: 'ABS',
    family: 'ABS',
    semiCrystalline: false,
    carbonFilled: false,
    nozzleTemp: 260,
    bedTemp: 100,
    lockTemp: 102,
    shrinkStrain: 0.008,
    stiffness: 0.65,
    bedAdhesion: 0.75,
    needsChamber: true,
    chamberTemp: 60,
    notes: 'High Tg plus high shrink: the classic warper. A heated chamber and 100 °C bed are strongly advised.',
  },
  {
    id: 'asa',
    name: 'ASA',
    family: 'ASA',
    semiCrystalline: false,
    carbonFilled: false,
    nozzleTemp: 260,
    bedTemp: 100,
    lockTemp: 100,
    shrinkStrain: 0.007,
    stiffness: 0.65,
    bedAdhesion: 0.8,
    needsChamber: true,
    chamberTemp: 60,
    notes: 'Marginally better than ABS for warp; UV stable. Enclosure recommended.',
  },
  {
    id: 'asa-cf10',
    name: 'ASA-CF 10 %',
    family: 'ASA',
    semiCrystalline: false,
    carbonFilled: true,
    nozzleTemp: 270,
    bedTemp: 100,
    lockTemp: 100,
    shrinkStrain: 0.0038,
    stiffness: 0.92,
    bedAdhesion: 0.78,
    needsChamber: true,
    chamberTemp: 60,
    notes: '10 % short carbon fibre roughly halves ASA shrink (in-plane, fibres align with the road); modest stiffness gain.',
  },
  {
    id: 'asa-cf20',
    name: 'ASA-CF 20 %',
    family: 'ASA',
    semiCrystalline: false,
    carbonFilled: true,
    nozzleTemp: 270,
    bedTemp: 100,
    lockTemp: 100,
    shrinkStrain: 0.0024,
    stiffness: 1.25,
    bedAdhesion: 0.75,
    needsChamber: true,
    chamberTemp: 60,
    notes: '20 % fibre cuts ASA shrink to about a third; the added stiffness costs back a little, but net warp is the lowest of the ASA family.',
  },
  {
    id: 'pc',
    name: 'PC',
    family: 'PC',
    semiCrystalline: false,
    carbonFilled: false,
    nozzleTemp: 280,
    bedTemp: 110,
    lockTemp: 140,
    shrinkStrain: 0.007,
    stiffness: 0.7,
    bedAdhesion: 0.7,
    needsChamber: true,
    chamberTemp: 60,
    notes: 'Very high lock-in temperature drives large thermal gradients; needs a hot chamber.',
  },
  {
    id: 'pa6-cf',
    name: 'PA6-CF (Nylon)',
    family: 'PA',
    semiCrystalline: true,
    carbonFilled: true,
    nozzleTemp: 290,
    bedTemp: 100,
    lockTemp: 150,
    shrinkStrain: 0.0045,
    stiffness: 1.3,
    bedAdhesion: 0.65,
    needsChamber: true,
    chamberTemp: 60,
    notes: 'Semi-crystalline: crystallisation shrink adds to thermal shrink. CF fill tames it but adhesion is tricky — dry the filament and use glue.',
  },
  {
    id: 'paht-cf',
    name: 'PAHT-CF',
    family: 'PA',
    semiCrystalline: true,
    carbonFilled: true,
    nozzleTemp: 290,
    bedTemp: 100,
    lockTemp: 160,
    shrinkStrain: 0.0035,
    stiffness: 1.35,
    bedAdhesion: 0.7,
    needsChamber: true,
    chamberTemp: 60,
    notes: 'High-temp nylon with carbon fibre. Lower shrink than PA6-CF but very high lock-in temperature; enclosure and dried filament are essential.',
  },
  {
    id: 'tpu',
    name: 'TPU 95A',
    family: 'TPU',
    semiCrystalline: false,
    carbonFilled: false,
    nozzleTemp: 230,
    bedTemp: 40,
    lockTemp: 40,
    shrinkStrain: 0.008,
    stiffness: 0.05,
    bedAdhesion: 1.2,
    needsChamber: false,
    chamberTemp: 35,
    notes: 'Shrinks noticeably but is far too soft to generate warp force — parts stay flat.',
  },
];

export function getFilament(id: string): Filament | undefined {
  return FILAMENTS.find((f) => f.id === id);
}

/**
 * Build-plate surfaces. The filament `bedAdhesion` values are calibrated on
 * textured PEI (factor 1.0 across the board); other surfaces scale grip up
 * or down per polymer family.
 */
export type BedSurface = 'textured-pei' | 'smooth-pei' | 'cool-smooth' | 'high-tack';

export const BED_SURFACES: Array<{ id: BedSurface; label: string }> = [
  { id: 'textured-pei', label: 'Textured PEI' },
  { id: 'smooth-pei', label: 'Smooth PEI (high-temp / engineering)' },
  { id: 'cool-smooth', label: 'Smooth cool plate (PC / PP)' },
  { id: 'high-tack', label: 'High-tack cool plate' },
];

/**
 * Relative first-layer grip vs textured PEI. Smooth PEI has more contact
 * area (PETG famously bonds almost too well); cool-plate surfaces are made
 * for PLA/TPU and hold hot-bed polymers poorly; high-tack coatings grip PLA
 * hardest of all but aren't meant for engineering materials either.
 */
const SURFACE_FACTORS: Record<BedSurface, Record<Filament['family'], number>> = {
  'textured-pei': { PLA: 1.0, PETG: 1.0, ABS: 1.0, ASA: 1.0, PC: 1.0, PA: 1.0, TPU: 1.0 },
  'smooth-pei': { PLA: 1.1, PETG: 1.2, ABS: 1.1, ASA: 1.1, PC: 1.1, PA: 1.0, TPU: 1.1 },
  'cool-smooth': { PLA: 1.05, PETG: 0.6, ABS: 0.5, ASA: 0.5, PC: 0.5, PA: 0.5, TPU: 1.0 },
  'high-tack': { PLA: 1.25, PETG: 0.7, ABS: 0.5, ASA: 0.5, PC: 0.5, PA: 0.5, TPU: 1.1 },
};

export function bedSurfaceFactor(surface: BedSurface | undefined, f: Filament): number {
  return SURFACE_FACTORS[surface ?? 'textured-pei'][f.family];
}

/** Map a slicer `curr_bed_type` string to a surface, if we recognise it. */
export function bedSurfaceFromBedType(bedType: string | undefined): BedSurface | undefined {
  if (!bedType) return undefined;
  if (/supertack|high[- ]?tack/i.test(bedType)) return 'high-tack';
  if (/textured/i.test(bedType)) return 'textured-pei';
  if (/high temp|eng|smooth/i.test(bedType)) return 'smooth-pei';
  if (/cool/i.test(bedType)) return 'cool-smooth';
  return undefined;
}

/**
 * Map a slicer `filament_type` / tray value (e.g. "ABS", "PAHT-CF",
 * "PLA Basic") to a filament in our database, if we recognise it.
 */
export function matchFilamentType(type: string): Filament | undefined {
  const t = type.trim().toUpperCase();
  const direct = FILAMENTS.find((f) => f.name.toUpperCase() === t || f.id.toUpperCase() === t);
  if (direct) return direct;
  // Order matters: check filled/specific grades before plain families.
  const rules: Array<[RegExp, string]> = [
    [/PAHT[- ]?CF/, 'paht-cf'],
    [/PA6?[- ]?(CF|GF)/, 'pa6-cf'],
    [/^PA|NYLON/, 'pa6-cf'],
    [/ASA[- ]?CF[- ]?20|ASA.*20\s*%/, 'asa-cf20'],
    // Unknown fibre fraction: assume 10 % (the conservative, warpier grade).
    [/ASA[- ]?(CF|AERO)/, 'asa-cf10'],
    [/ASA/, 'asa'],
    [/ABS/, 'abs'],
    [/PETG[- ]?CF/, 'petg-cf'],
    [/PETG|PCTG/, 'petg'],
    [/PLA[- ]?CF/, 'pla-cf'],
    [/PLA/, 'pla'],
    [/^PC/, 'pc'],
    [/TPU|FLEX/, 'tpu'],
  ];
  for (const [re, id] of rules) {
    if (re.test(t)) return getFilament(id);
  }
  return undefined;
}
