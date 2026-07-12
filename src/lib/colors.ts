/**
 * Colour roles for the app, following a sequential single-hue ramp for the
 * continuous risk field and reserved status colours (always paired with a
 * label, never colour alone) for the risk buckets.
 */
import { RiskBucket } from './simulation';

/** Sequential blue ramp, light -> dark (steps 100..700). */
export const SEQ_RAMP = [
  '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b',
];

export const STATUS: Record<RiskBucket, { color: string; icon: string; label: string }> = {
  low: { color: '#0ca30c', icon: '✓', label: 'Low' },
  moderate: { color: '#fab219', icon: '◑', label: 'Moderate' },
  high: { color: '#ec835a', icon: '▲', label: 'High' },
  severe: { color: '#d03b3b', icon: '✕', label: 'Severe' },
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const RAMP_RGB = SEQ_RAMP.map(hexToRgb);

/** Sample the sequential ramp at t in [0, 1]; returns rgb 0-255. */
export function riskColor(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  const pos = clamped * (RAMP_RGB.length - 1);
  const i = Math.min(RAMP_RGB.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = RAMP_RGB[i];
  const b = RAMP_RGB[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function riskColorCss(t: number): string {
  const [r, g, b] = riskColor(t);
  return `rgb(${r}, ${g}, ${b})`;
}
