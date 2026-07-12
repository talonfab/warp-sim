import { useCallback, useMemo, useState } from 'react';
import {
  BedSurface,
  bedSurfaceFromBedType,
  FILAMENTS,
  matchFilamentType,
} from './lib/filaments';
import { DEFAULT_LIMITS, parseProjectFile, ProjectInfo } from './lib/threemf';
import { voxelize } from './lib/voxelize';
import { computePartMetrics, PartMetrics, SimulationSettings } from './lib/simulation';
import {
  FilamentConditionOverride,
  resolveConditions,
  simulatePlate,
} from './lib/plateSim';
import { DEMO_PARTS } from './lib/demo';
import Sidebar from './components/Sidebar';
import Viewer3D from './components/Viewer3D';
import ResultsTable from './components/ResultsTable';
import Legend from './components/Legend';

const DEFAULT_SELECTION = ['pla', 'petg', 'abs', 'asa', 'asa-cf10', 'asa-cf20', 'paht-cf'];

/** A brim the slicer will actually print (auto usually resolves to none). */
function projectUsesBrim(brimType: string | undefined): boolean {
  return !!brimType && brimType !== 'no_brim' && brimType !== 'auto_brim';
}

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [activePlateIdx, setActivePlateIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>(DEFAULT_SELECTION);
  const [activeId, setActiveId] = useState<string>('asa');
  const [brim, setBrim] = useState(false);
  const [bedSurface, setBedSurface] = useState<BedSurface>('textured-pei');
  const [condOverrides, setCondOverrides] = useState<Record<string, FilamentConditionOverride>>(
    {},
  );

  const adoptProject = useCallback((info: ProjectInfo) => {
    setProject(info);
    setActivePlateIdx(0);
    // Adopt the project's sliced conditions as the new baseline.
    setCondOverrides({});
    setBrim(projectUsesBrim(info.settings.brimType));
    setBedSurface(bedSurfaceFromBedType(info.settings.bedType) ?? 'textured-pei');
    // Pre-select filaments the project was sliced for.
    const matched = info.settings.filamentTypes
      .map((t) => matchFilamentType(t)?.id)
      .filter((id): id is string => !!id);
    if (matched.length > 0) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...matched])));
      setActiveId(matched[0]);
    }
  }, []);

  const loadBuffer = useCallback(
    (buffer: ArrayBuffer, name: string) => {
      setBusy(true);
      setError(null);
      // Yield a frame so the busy state paints before the synchronous parse.
      setTimeout(() => {
        try {
          adoptProject(parseProjectFile(buffer, name));
        } catch (e) {
          setProject(null);
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }, 30);
    },
    [adoptProject],
  );

  const onFile = useCallback(
    (file: File) => {
      // Reject oversized uploads before reading them into memory.
      if (file.size > DEFAULT_LIMITS.maxFileBytes) {
        setProject(null);
        setError(
          `File is too large (${Math.ceil(file.size / (1024 * 1024))} MB); limit is ` +
            `${Math.ceil(DEFAULT_LIMITS.maxFileBytes / (1024 * 1024))} MB.`,
        );
        return;
      }
      file.arrayBuffer().then((buf) => loadBuffer(buf, file.name));
    },
    [loadBuffer],
  );

  const onDemo = useCallback(
    (index: number) => {
      setError(null);
      adoptProject(DEMO_PARTS[index].make());
    },
    [adoptProject],
  );

  const plate = project
    ? project.plates[Math.min(activePlateIdx, project.plates.length - 1)]
    : null;

  const grids = useMemo(() => (plate ? plate.objects.map((o) => voxelize(o)) : null), [plate]);

  const metrics = useMemo<PartMetrics | null>(() => {
    if (!grids || grids.length === 0) return null;
    const perObject = grids.map(computePartMetrics);
    return {
      height: Math.max(...perObject.map((m) => m.height)),
      footprintArea: perObject.reduce((s, m) => s + m.footprintArea, 0),
      maxRadius: Math.max(...perObject.map((m) => m.maxRadius)),
      aspectRatio: Math.max(...perObject.map((m) => m.aspectRatio)),
    };
  }, [grids]);

  // What each filament would run at with no user overrides — shown as the
  // placeholder values in the per-filament condition inputs.
  const conditionDefaults = useMemo<Record<string, SimulationSettings>>(() => {
    const settings = project?.settings ?? { filamentTypes: [] };
    const map: Record<string, SimulationSettings> = {};
    for (const f of FILAMENTS) map[f.id] = resolveConditions(f, settings, { brim, bedSurface });
    return map;
  }, [project, brim, bedSurface]);

  const results = useMemo(() => {
    if (!project || !plate || !grids) return [];
    const ui = { brim, bedSurface, perFilament: condOverrides };
    return FILAMENTS.filter((f) => selectedIds.includes(f.id))
      .map((f) => simulatePlate(plate.objects, grids, f, resolveConditions(f, project.settings, ui)))
      .sort((a, b) => a.score - b.score);
  }, [project, plate, grids, selectedIds, brim, bedSurface, condOverrides]);

  const activeResult = results.find((r) => r.filament.id === activeId) ?? results[results.length - 1];

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Warp Simulator</h1>
          <p className="subtitle">
            Thermal warp-likelihood estimates for sliced 3MF projects across filaments
          </p>
        </div>
        <a
          className="credit"
          href="https://www.talonfab.com.au/"
          target="_blank"
          rel="noreferrer"
        >
          a free tool by <strong>TalonFab</strong> — parabolic microphones &amp; wildlife
          recording gear
        </a>
      </header>
      <div className="layout">
        <Sidebar
          project={project}
          activePlateIdx={activePlateIdx}
          onPlateChange={setActivePlateIdx}
          plateObjectCount={plate ? plate.objects.length : 0}
          metrics={metrics}
          busy={busy}
          error={error}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          brim={brim}
          onBrimChange={setBrim}
          bedSurface={bedSurface}
          onBedSurfaceChange={setBedSurface}
          condOverrides={condOverrides}
          onCondOverridesChange={setCondOverrides}
          conditionDefaults={conditionDefaults}
          onFile={onFile}
          onDemo={onDemo}
        />
        <main className="main">
          {plate && activeResult ? (
            <>
              <div className="viewer-wrap">
                <Viewer3D objects={plate.objects} parts={activeResult.objects} />
                <Legend
                  title={`Warp risk — ${activeResult.filament.name}`}
                  note="Sequential scale: light = stays flat, dark = likely corner lift"
                />
              </div>
              <ResultsTable results={results} activeId={activeResult.filament.id} onSelect={setActiveId} />
              <section className="recs">
                <h2>
                  Recommendations — {activeResult.filament.name}
                  {activeResult.objects.length > 1 && ' (worst object on the plate)'}
                </h2>
                <ul>
                  {activeResult.recommendations.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </section>
            </>
          ) : (
            <div className="empty">
              <p>
                Drop a sliced project (<code>.3mf</code>) or an <code>.stl</code> on the panel to
                the left, or load a demo part to explore the simulation.
              </p>
              <p className="fine">
                Everything runs locally in your browser — no files are uploaded anywhere.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
