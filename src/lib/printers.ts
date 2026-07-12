/**
 * Chamber-temperature inference from the printer model named in a sliced
 * project. Used only when the project itself doesn't specify a chamber
 * temperature (most profiles say 0 = uncontrolled): an enclosed printer
 * still soaks its chamber well above room temperature, and an open frame
 * never exceeds it — both matter a lot for warp.
 */
import { Filament } from './filaments';

interface PrinterClass {
  match: RegExp;
  /** Chamber temperature the machine can hold with hot-bed filaments, °C. */
  maxChamber: number;
}

const PRINTER_CLASSES: PrinterClass[] = [
  { match: /H2|X1E/i, maxChamber: 60 }, // actively heated chamber
  { match: /X1|P1S/i, maxChamber: 40 }, // enclosed, passively heated
  { match: /A1|P1P/i, maxChamber: 25 }, // open frame
];

/**
 * Realistic chamber temperature for `filament` on `printerModel`, or
 * undefined when the printer isn't recognised. The chamber only warms up
 * as far as the bed and print drive it, so cap at the filament's typical
 * chamber rather than the machine maximum (nobody heats a chamber for PLA).
 */
export function inferChamberTemp(
  printerModel: string | undefined,
  filament: Filament,
): number | undefined {
  if (!printerModel) return undefined;
  for (const cls of PRINTER_CLASSES) {
    if (cls.match.test(printerModel)) {
      return Math.min(filament.chamberTemp, cls.maxChamber);
    }
  }
  return undefined;
}
