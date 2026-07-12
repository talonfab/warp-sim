import { useCallback, useRef, useState, DragEvent, ChangeEvent } from 'react';
import { BED_SURFACES, BedSurface, FILAMENTS } from '../lib/filaments';
import { ProjectInfo } from '../lib/threemf';
import { PartMetrics, SimulationSettings } from '../lib/simulation';
import { FilamentConditionOverride } from '../lib/plateSim';
import { DEMO_PARTS } from '../lib/demo';

interface Props {
  project: ProjectInfo | null;
  activePlateIdx: number;
  onPlateChange: (idx: number) => void;
  plateObjectCount: number;
  metrics: PartMetrics | null;
  busy: boolean;
  error: string | null;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  brim: boolean;
  onBrimChange: (v: boolean) => void;
  bedSurface: BedSurface;
  onBedSurfaceChange: (v: BedSurface) => void;
  condOverrides: Record<string, FilamentConditionOverride>;
  onCondOverridesChange: (v: Record<string, FilamentConditionOverride>) => void;
  /** Resolved no-override conditions per filament id (placeholder values). */
  conditionDefaults: Record<string, SimulationSettings>;
  onFile: (file: File) => void;
  onDemo: (index: number) => void;
}

const BRIM_LABELS: Record<string, string> = {
  auto_brim: 'auto',
  no_brim: 'none',
  outer_only: 'outer',
  outer_and_inner: 'outer + inner',
  brim_ears: 'mouse ears',
  painted: 'painted',
};

/** "60 °C" for uniform arrays, "60 / 70 °C" when filaments differ. */
function formatTemps(temps: number[] | undefined): string | null {
  if (!temps || temps.length === 0) return null;
  const active = temps.filter((t) => t > 0);
  if (active.length === 0) return null;
  const uniq = Array.from(new Set(active));
  return `${uniq.join(' / ')} °C`;
}

export default function Sidebar(props: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) props.onFile(file);
    },
    [props],
  );

  const onPick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) props.onFile(file);
      e.target.value = '';
    },
    [props],
  );

  const toggle = (id: string) => {
    props.onSelectionChange(
      props.selectedIds.includes(id)
        ? props.selectedIds.filter((s) => s !== id)
        : [...props.selectedIds, id],
    );
  };

  const settings = props.project?.settings;
  const hasProjectConditions = !!settings && (!!settings.bedTemps || !!settings.chamberTemps);

  return (
    <aside className="sidebar">
      <section>
        <h2>Project</h2>
        <div
          className={`dropzone${dragOver ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        >
          {props.busy
            ? 'Analyzing…'
            : props.project
              ? props.project.fileName
              : 'Drop .3mf / .stl here or click to browse'}
          <input
            ref={inputRef}
            type="file"
            accept=".3mf,.stl"
            onChange={onPick}
            style={{ display: 'none' }}
          />
        </div>
        {props.error && <p className="error">⚠ {props.error}</p>}
        <div className="demos">
          {DEMO_PARTS.map((d, i) => (
            <button key={d.name} className="linklike" onClick={() => props.onDemo(i)}>
              Load demo: {d.name}
            </button>
          ))}
        </div>
        {props.project && props.project.plates.length > 1 && (
          <div className="plates" role="tablist" aria-label="Build plates">
            {props.project.plates.map((p, i) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={i === props.activePlateIdx}
                className={`platebtn${i === props.activePlateIdx ? ' active' : ''}`}
                onClick={() => props.onPlateChange(i)}
                title={`${p.objects.length} object${p.objects.length === 1 ? '' : 's'}`}
              >
                {p.name || `Plate ${p.id}`}
              </button>
            ))}
          </div>
        )}
        {props.project && props.metrics && (
          <dl className="metrics">
            <dt>Objects on plate</dt>
            <dd>{props.plateObjectCount}</dd>
            <dt>Height</dt>
            <dd>{props.metrics.height.toFixed(1)} mm</dd>
            <dt>Footprint</dt>
            <dd>{(props.metrics.footprintArea / 100).toFixed(1)} cm²</dd>
            <dt>Max corner reach</dt>
            <dd>{props.metrics.maxRadius.toFixed(0)} mm</dd>
          </dl>
        )}
      </section>

      {settings && (settings.printerModel || settings.bedType || settings.filamentTypes.length > 0) && (
        <section>
          <h2>Sliced settings</h2>
          <dl className="metrics">
            {settings.printerModel && (
              <>
                <dt>Printer</dt>
                <dd>{settings.printerModel}</dd>
              </>
            )}
            {settings.filamentTypes.length > 0 && (
              <>
                <dt>Filaments</dt>
                <dd>{Array.from(new Set(settings.filamentTypes)).join(', ')}</dd>
              </>
            )}
            {settings.bedType && (
              <>
                <dt>Plate</dt>
                <dd>
                  {settings.bedType}
                  {formatTemps(settings.bedTemps) ? ` @ ${formatTemps(settings.bedTemps)}` : ''}
                </dd>
              </>
            )}
            {settings.chamberTemps && (
              <>
                <dt>Chamber</dt>
                <dd>{formatTemps(settings.chamberTemps) ?? 'uncontrolled'}</dd>
              </>
            )}
            {settings.brimType && (
              <>
                <dt>Brim</dt>
                <dd>
                  {BRIM_LABELS[settings.brimType] ?? settings.brimType}
                  {settings.brimWidth ? ` (${settings.brimWidth} mm)` : ''}
                </dd>
              </>
            )}
          </dl>
          <p className="fine">
            These sliced values are used as the simulation defaults for the matching filaments.
          </p>
        </section>
      )}

      <section>
        <h2>Filaments</h2>
        <ul className="filament-list">
          {FILAMENTS.map((f) => (
            <li key={f.id}>
              <label title={f.notes}>
                <input
                  type="checkbox"
                  checked={props.selectedIds.includes(f.id)}
                  onChange={() => toggle(f.id)}
                />
                {f.name}
                {f.needsChamber && <span className="tag">enclosure</span>}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Print conditions</h2>
        <label className="row surface-row">
          Plate surface
          <select
            value={props.bedSurface}
            onChange={(e) => props.onBedSurfaceChange(e.target.value as BedSurface)}
          >
            {BED_SURFACES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <table className="cond-table">
          <colgroup>
            <col />
            <col className="c-bed" />
            <col className="c-chamber" />
            <col className="c-brim" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Filament</th>
              <th scope="col" title="Bed temperature, °C">
                Bed
              </th>
              <th scope="col" title="Chamber temperature, °C">
                Chamber
              </th>
              <th scope="col">
                <label className="brim-all" title="Set brim for all filaments">
                  Brim{' '}
                  <input
                    type="checkbox"
                    checked={props.brim}
                    onChange={(e) => {
                      // The header checkbox is the master: reset the column.
                      props.onBrimChange(e.target.checked);
                      const rest: Record<string, FilamentConditionOverride> = {};
                      for (const [id, o] of Object.entries(props.condOverrides)) {
                        const { brim: _drop, ...keep } = o;
                        if (keep.bedTemp !== undefined || keep.chamberTemp !== undefined) {
                          rest[id] = keep;
                        }
                      }
                      props.onCondOverridesChange(rest);
                    }}
                    aria-label="Brim for all filaments"
                  />
                </label>
              </th>
            </tr>
          </thead>
          <tbody>
            {FILAMENTS.filter((f) => props.selectedIds.includes(f.id)).map((f) => {
              const override = props.condOverrides[f.id] ?? {};
              const defaults = props.conditionDefaults[f.id];
              const set = (patch: Partial<FilamentConditionOverride>) => {
                const next = { ...override, ...patch };
                const rest = { ...props.condOverrides };
                if (
                  next.bedTemp === undefined &&
                  next.chamberTemp === undefined &&
                  next.brim === undefined
                ) {
                  delete rest[f.id];
                  props.onCondOverridesChange(rest);
                } else {
                  props.onCondOverridesChange({ ...rest, [f.id]: next });
                }
              };
              return (
                <tr key={f.id}>
                  <th scope="row" title={f.name}>
                    {f.name}
                  </th>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={130}
                      placeholder={String(defaults?.bedTemp ?? '')}
                      value={override.bedTemp ?? ''}
                      onChange={(e) =>
                        set({ bedTemp: e.target.value === '' ? undefined : Number(e.target.value) })
                      }
                      aria-label={`${f.name} bed temperature`}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={80}
                      placeholder={String(defaults?.chamberTemp ?? '')}
                      value={override.chamberTemp ?? ''}
                      onChange={(e) =>
                        set({
                          chamberTemp: e.target.value === '' ? undefined : Number(e.target.value),
                        })
                      }
                      aria-label={`${f.name} chamber temperature`}
                    />
                  </td>
                  <td className="brim-cell">
                    <input
                      type="checkbox"
                      checked={override.brim ?? props.brim}
                      onChange={(e) => set({ brim: e.target.checked })}
                      aria-label={`${f.name} brim`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="fine">
          {hasProjectConditions
            ? 'Greyed values are the defaults: the project’s sliced settings where a filament matches (plus the printer model for the chamber), each filament’s recommendation otherwise. Type to override per filament; clear to restore. The header brim checkbox sets the whole column.'
            : 'Greyed values are each filament’s recommended bed and chamber temperatures. Type to override per filament (e.g. chamber 25 °C on an open printer); clear to restore. The header brim checkbox sets the whole column.'}
        </p>
      </section>
    </aside>
  );
}
