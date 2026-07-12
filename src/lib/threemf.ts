/**
 * Minimal 3MF reader with support for sliced project files.
 *
 * A .3mf is a zip. The root model lives at `3D/3dmodel.model`; sliced
 * projects usually keep per-object geometry in `3D/Objects/*.model` files
 * referenced from the root via the production extension (`p:path` attribute
 * on <component>). Slicers also ship:
 *  - `Metadata/model_settings.config` (XML): build-plate layout — which
 *    object instances sit on which plate. All plates share one world
 *    coordinate space (plates are laid out side by side), so plate
 *    membership is essential to make sense of the geometry.
 *  - `Metadata/project_settings.config` (JSON): the full slicer profile —
 *    filaments, per-plate-type bed temperatures, chamber temperatures,
 *    brim configuration, printer model.
 */
import { unzipSync, strFromU8 } from 'fflate';
import {
  Mesh,
  Transform3MF,
  composeTransforms,
  applyTransform,
  computeBBox,
  mergeMeshes,
  parseTransformAttr,
  centerMeshesOnBed,
} from './geometry';

/** One build plate: separately printed objects in shared plate coordinates. */
export interface PlateInfo {
  /** Slicer plater_id (1-based) or 1 for plain files. */
  id: number;
  /** plater_name when the user named the plate in the slicer. */
  name?: string;
  /** One mesh per printed object (build item). */
  objects: Mesh[];
}

/** Slicer settings extracted from Metadata/project_settings.config. */
export interface SlicerSettings {
  /** Filament type strings, e.g. ["PLA", "PAHT-CF"], indexed like the arrays below. */
  filamentTypes: string[];
  /** Selected build plate surface, e.g. "Textured PEI Plate". */
  bedType?: string;
  /** Bed temperature per filament for the selected plate type, °C. */
  bedTemps?: number[];
  /** Chamber temperature per filament, °C; 0 = uncontrolled. */
  chamberTemps?: number[];
  /** brim_type: auto_brim | no_brim | outer_only | outer_and_inner | brim_ears | painted. */
  brimType?: string;
  /** brim_width in mm, when explicitly set. */
  brimWidth?: number;
  /** Printer model string from the profile, used for chamber inference. */
  printerModel?: string;
}

export interface ProjectInfo {
  plates: PlateInfo[];
  /** Total printed objects across all plates. */
  objectCount: number;
  settings: SlicerSettings;
  fileName: string;
}

/**
 * Resource limits for parsing untrusted uploads. This tool runs entirely in
 * the visitor's browser, so the worst a hostile file can do is hang or OOM
 * their own tab — but that's still a bad experience, so we cap input up front
 * and fail with a clear message instead of freezing. Limits are generous
 * relative to real printable models (tens of MB, well under a million
 * triangles) and only bite pathological or malicious input.
 */
export interface ParseLimits {
  /** Max raw upload size (compressed, on disk), bytes. */
  maxFileBytes: number;
  /** Max total decompressed size across the archive entries we read, bytes. */
  maxUnzippedBytes: number;
  /** Max decompressed size of any single archive entry, bytes. */
  maxEntryBytes: number;
  /** Max triangles in one mesh. */
  maxTriangles: number;
  /** Max vertices in one mesh. */
  maxVertices: number;
}

const MB = 1024 * 1024;
export const DEFAULT_LIMITS: ParseLimits = {
  maxFileBytes: 150 * MB,
  maxUnzippedBytes: 400 * MB,
  maxEntryBytes: 300 * MB,
  maxTriangles: 5_000_000,
  maxVertices: 5_000_000,
};

const mb = (bytes: number) => Math.ceil(bytes / MB);

interface ParsedObject {
  mesh?: Mesh;
  components?: Array<{ objectId: string; path?: string; transform: Transform3MF }>;
}

type ObjectStore = Map<string, ParsedObject>; // key: `${path}#${id}`

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`Invalid 3MF XML: ${err.textContent?.slice(0, 200)}`);
  return doc;
}

function parseMeshElement(meshEl: Element, limits: ParseLimits): Mesh {
  const vertexEls = meshEl.getElementsByTagName('vertex');
  const triEls = meshEl.getElementsByTagName('triangle');
  if (vertexEls.length > limits.maxVertices) {
    throw new Error(
      `Mesh has too many vertices (${vertexEls.length.toLocaleString()}); limit is ` +
        `${limits.maxVertices.toLocaleString()}.`,
    );
  }
  if (triEls.length > limits.maxTriangles) {
    throw new Error(
      `Mesh has too many triangles (${triEls.length.toLocaleString()}); limit is ` +
        `${limits.maxTriangles.toLocaleString()}.`,
    );
  }
  const vertices = new Float32Array(vertexEls.length * 3);
  for (let i = 0; i < vertexEls.length; i++) {
    const v = vertexEls[i];
    // Guard against malformed coordinates: one NaN would poison bounding
    // boxes, plate centering, and the camera framing downstream.
    const x = Number(v.getAttribute('x'));
    const y = Number(v.getAttribute('y'));
    const z = Number(v.getAttribute('z'));
    vertices[i * 3] = Number.isFinite(x) ? x : 0;
    vertices[i * 3 + 1] = Number.isFinite(y) ? y : 0;
    vertices[i * 3 + 2] = Number.isFinite(z) ? z : 0;
  }
  const indices = new Uint32Array(triEls.length * 3);
  for (let i = 0; i < triEls.length; i++) {
    const t = triEls[i];
    indices[i * 3] = Number(t.getAttribute('v1'));
    indices[i * 3 + 1] = Number(t.getAttribute('v2'));
    indices[i * 3 + 2] = Number(t.getAttribute('v3'));
  }
  return { vertices, indices };
}

/** Normalise a zip-internal path referenced from `basePath` (may start with '/'). */
function resolvePath(ref: string, basePath: string): string {
  if (ref.startsWith('/')) return ref.slice(1);
  const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
  return dir + ref;
}

function loadModelFile(
  files: Record<string, Uint8Array>,
  path: string,
  store: ObjectStore,
  limits: ParseLimits,
): Document {
  const data = files[path];
  if (!data) throw new Error(`3MF is missing model file: ${path}`);
  const doc = parseXml(strFromU8(data));
  const objects = doc.getElementsByTagName('object');
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const id = obj.getAttribute('id');
    if (!id) continue;
    const parsed: ParsedObject = {};
    const meshEl = obj.getElementsByTagName('mesh')[0];
    if (meshEl) parsed.mesh = parseMeshElement(meshEl, limits);
    const compEls = obj.getElementsByTagName('component');
    if (compEls.length > 0) {
      parsed.components = [];
      for (let c = 0; c < compEls.length; c++) {
        const el = compEls[c];
        const objectId = el.getAttribute('objectid');
        if (!objectId) continue;
        // Production extension path attribute (any namespace prefix).
        let refPath: string | undefined;
        for (const attr of Array.from(el.attributes)) {
          if (attr.localName === 'path') refPath = attr.value;
        }
        parsed.components.push({
          objectId,
          path: refPath ? resolvePath(refPath, path) : undefined,
          transform: parseTransformAttr(el.getAttribute('transform')),
        });
      }
    }
    store.set(`${path}#${id}`, parsed);
  }
  return doc;
}

function resolveObjectMesh(
  files: Record<string, Uint8Array>,
  store: ObjectStore,
  path: string,
  id: string,
  transform: Transform3MF,
  out: Mesh[],
  limits: ParseLimits,
  depth = 0,
): void {
  if (depth > 16) throw new Error('3MF component nesting too deep (cycle?)');
  const key = `${path}#${id}`;
  if (!store.has(key)) loadModelFile(files, path, store, limits);
  const obj = store.get(key);
  if (!obj) throw new Error(`3MF references missing object id=${id} in ${path}`);
  if (obj.mesh && obj.mesh.indices.length > 0) {
    out.push({ vertices: applyTransform(obj.mesh.vertices, transform), indices: obj.mesh.indices });
  }
  if (obj.components) {
    for (const comp of obj.components) {
      const childPath = comp.path ?? path;
      resolveObjectMesh(
        files,
        store,
        childPath,
        comp.objectId,
        composeTransforms(transform, comp.transform),
        out,
        limits,
        depth + 1,
      );
    }
  }
}

function findRootModelPath(files: Record<string, Uint8Array>): string {
  // Try the .rels file first (spec-correct), then the conventional path.
  const rels = files['_rels/.rels'];
  if (rels) {
    try {
      const doc = parseXml(strFromU8(rels));
      const relEls = doc.getElementsByTagName('Relationship');
      for (let i = 0; i < relEls.length; i++) {
        const type = relEls[i].getAttribute('Type') ?? '';
        if (type.endsWith('/3dmodel')) {
          const target = relEls[i].getAttribute('Target') ?? '';
          const norm = target.startsWith('/') ? target.slice(1) : target;
          if (files[norm]) return norm;
        }
      }
    } catch {
      // fall through to conventional path
    }
  }
  if (files['3D/3dmodel.model']) return '3D/3dmodel.model';
  const any = Object.keys(files).find((k) => k.endsWith('.model'));
  if (any) return any;
  throw new Error('No 3D model found inside the 3MF archive');
}

/** Bed-type names → the project_settings key holding that plate's temps. */
const BED_TYPE_TEMP_KEYS: Array<[RegExp, string]> = [
  [/supertack/i, 'supertack_plate_temp'],
  [/textured/i, 'textured_plate_temp'],
  [/high temp/i, 'hot_plate_temp'],
  [/eng/i, 'eng_plate_temp'],
  [/cool/i, 'cool_plate_temp'],
];
const ANY_PLATE_TEMP_KEYS = [
  'hot_plate_temp',
  'textured_plate_temp',
  'supertack_plate_temp',
  'eng_plate_temp',
  'cool_plate_temp',
];

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const nums = (value as unknown[]).map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : undefined;
}

function extractSlicerSettings(files: Record<string, Uint8Array>): SlicerSettings {
  const raw = files['Metadata/project_settings.config'];
  if (!raw) return { filamentTypes: [] };
  try {
    const cfg = JSON.parse(strFromU8(raw)) as Record<string, unknown>;
    const filamentTypes = Array.isArray(cfg.filament_type)
      ? (cfg.filament_type as unknown[]).map(String)
      : [];

    const bedType = typeof cfg.curr_bed_type === 'string' ? cfg.curr_bed_type : undefined;
    let bedTemps: number[] | undefined;
    const tempKeys: string[] = [];
    if (bedType) {
      for (const [re, key] of BED_TYPE_TEMP_KEYS) {
        if (re.test(bedType)) {
          tempKeys.push(key, `${key}_initial_layer`);
          break;
        }
      }
    }
    tempKeys.push(...ANY_PLATE_TEMP_KEYS);
    for (const key of tempKeys) {
      bedTemps = numberArray(cfg[key]);
      if (bedTemps && bedTemps.some((n) => n > 0)) break;
      bedTemps = undefined;
    }

    const chamberTemps =
      numberArray(cfg.chamber_temperatures) ?? numberArray(cfg.chamber_temperature);

    const brimType = typeof cfg.brim_type === 'string' ? cfg.brim_type : undefined;
    const brimWidthNum = Number(cfg.brim_width);
    const brimWidth = Number.isFinite(brimWidthNum) && brimWidthNum > 0 ? brimWidthNum : undefined;

    let printerModel = typeof cfg.printer_model === 'string' ? cfg.printer_model : undefined;
    if (!printerModel && typeof cfg.printer_settings_id === 'string') {
      // e.g. "<printer model> 0.4 nozzle" — strip the nozzle suffix.
      printerModel = cfg.printer_settings_id.replace(/\s+[\d.]+\s*nozzle.*$/i, '');
    }

    return { filamentTypes, bedType, bedTemps, chamberTemps, brimType, brimWidth, printerModel };
  } catch {
    return { filamentTypes: [] };
  }
}

interface PlateAssignment {
  /** plater_id → plate name (may be empty). */
  names: Map<number, string>;
  /** object_id → plate ids, ordered by instance_id, consumed per build item. */
  queues: Map<string, number[]>;
}

/**
 * Read the slicer's Metadata/model_settings.config plate layout. Each
 * <plate> carries a plater_id plus <model_instance> entries whose object_id
 * matches the root model's build items; duplicate items of one object
 * correspond to instances in instance_id order.
 */
function extractPlateAssignment(files: Record<string, Uint8Array>): PlateAssignment | null {
  const raw = files['Metadata/model_settings.config'];
  if (!raw) return null;
  try {
    const doc = parseXml(strFromU8(raw));
    const names = new Map<number, string>();
    const perObject = new Map<string, Array<{ instanceId: number; plateId: number }>>();
    const plateEls = doc.getElementsByTagName('plate');
    for (let p = 0; p < plateEls.length; p++) {
      const plateEl = plateEls[p];
      let plateId: number | undefined;
      let plateName = '';
      const metaEls = plateEl.children;
      for (let m = 0; m < metaEls.length; m++) {
        const el = metaEls[m];
        if (el.tagName === 'metadata') {
          const key = el.getAttribute('key');
          if (key === 'plater_id') plateId = Number(el.getAttribute('value'));
          if (key === 'plater_name') plateName = el.getAttribute('value') ?? '';
        }
      }
      if (plateId === undefined || !Number.isFinite(plateId)) plateId = p + 1;
      names.set(plateId, plateName);
      const instEls = plateEl.getElementsByTagName('model_instance');
      for (let i = 0; i < instEls.length; i++) {
        let objectId: string | undefined;
        let instanceId = i;
        const instMeta = instEls[i].getElementsByTagName('metadata');
        for (let m = 0; m < instMeta.length; m++) {
          const key = instMeta[m].getAttribute('key');
          const value = instMeta[m].getAttribute('value') ?? '';
          if (key === 'object_id') objectId = value;
          if (key === 'instance_id') instanceId = Number(value);
        }
        if (!objectId) continue;
        (perObject.get(objectId) ?? perObject.set(objectId, []).get(objectId)!).push({
          instanceId,
          plateId,
        });
      }
    }
    if (names.size === 0) return null;
    const queues = new Map<string, number[]>();
    for (const [objectId, list] of perObject) {
      list.sort((a, b) => a.instanceId - b.instanceId);
      queues.set(
        objectId,
        list.map((e) => e.plateId),
      );
    }
    return { names, queues };
  } catch {
    return null;
  }
}

const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** Synthetic plate id for items a plate layout doesn't place on any plate. */
const UNPLACED_PLATE_ID = Number.MAX_SAFE_INTEGER;
/** No printer bed is wider than this; a larger span means multiple areas. */
const MAX_BED_SPAN_MM = 400;
/** Gap between object groups that indicates separate build areas. */
const AREA_GAP_MM = 100;

/**
 * Fallback for files without a plate layout: if objects span far more than
 * any real bed, group them by large XY gaps so side-by-side plate exports
 * don't get simulated (and centered) as one enormous plate.
 */
function splitDistantGroups(meshes: Mesh[]): Mesh[][] {
  const boxes = meshes.map((m) => computeBBox(m));
  const spanX = Math.max(...boxes.map((b) => b.max[0])) - Math.min(...boxes.map((b) => b.min[0]));
  const spanY = Math.max(...boxes.map((b) => b.max[1])) - Math.min(...boxes.map((b) => b.min[1]));
  if (meshes.length < 2 || (spanX <= MAX_BED_SPAN_MM && spanY <= MAX_BED_SPAN_MM)) return [meshes];

  const clusterByAxis = (indices: number[], axis: 0 | 1): number[][] => {
    const sorted = [...indices].sort((a, b) => boxes[a].min[axis] - boxes[b].min[axis]);
    const groups: number[][] = [];
    let current: number[] = [];
    let reach = -Infinity;
    for (const i of sorted) {
      if (current.length > 0 && boxes[i].min[axis] - reach > AREA_GAP_MM) {
        groups.push(current);
        current = [];
      }
      current.push(i);
      reach = Math.max(reach, boxes[i].max[axis]);
    }
    if (current.length > 0) groups.push(current);
    return groups;
  };

  const all = meshes.map((_, i) => i);
  const result: number[][] = [];
  for (const xGroup of clusterByAxis(all, 0)) result.push(...clusterByAxis(xGroup, 1));
  return result.map((group) => group.map((i) => meshes[i]));
}

export function parse3MF(
  buffer: ArrayBuffer,
  fileName: string,
  limits: ParseLimits = DEFAULT_LIMITS,
): ProjectInfo {
  if (buffer.byteLength > limits.maxFileBytes) {
    throw new Error(
      `File is too large (${mb(buffer.byteLength)} MB); limit is ${mb(limits.maxFileBytes)} MB.`,
    );
  }
  // Decompress only the entries we actually read (model/config/rels), and cap
  // both per-entry and total decompressed size to defuse zip bombs. Sizes come
  // from the archive's directory, so an oversized entry is rejected before we
  // spend memory on it. (A crafted header could understate its size; the total
  // cap still bounds the damage.)
  let totalUnzipped = 0;
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      if (!/\.(model|config|rels)$/i.test(file.name)) return false;
      if (file.originalSize > limits.maxEntryBytes) {
        throw new Error(
          `3MF entry "${file.name}" decompresses to ${mb(file.originalSize)} MB; ` +
            `limit is ${mb(limits.maxEntryBytes)} MB.`,
        );
      }
      totalUnzipped += file.originalSize;
      if (totalUnzipped > limits.maxUnzippedBytes) {
        throw new Error(
          `3MF decompresses to more than ${mb(limits.maxUnzippedBytes)} MB ` +
            '(possible zip bomb) — refusing to load.',
        );
      }
      return true;
    },
  });
  const rootPath = findRootModelPath(files);
  const store: ObjectStore = new Map();
  const rootDoc = loadModelFile(files, rootPath, store, limits);

  const modelEl = rootDoc.getElementsByTagName('model')[0];
  const unit = modelEl?.getAttribute('unit') ?? 'millimeter';
  const scale = UNIT_TO_MM[unit] ?? 1;

  const assignment = extractPlateAssignment(files);

  const applyScale = (mesh: Mesh): Mesh => {
    if (scale !== 1) for (let i = 0; i < mesh.vertices.length; i++) mesh.vertices[i] *= scale;
    return mesh;
  };

  // Resolve each build item to one object mesh, assigned to its plate.
  // Duplicate items of one objectid consume that object's instance queue in
  // document order (matching the slicer's instance_id ordering).
  const itemEls = rootDoc.getElementsByTagName('item');
  const allObjects: Mesh[] = [];
  const plateOf: number[] = []; // plate id per object, parallel to allObjects
  const queues = new Map<string, number[]>();
  if (assignment) for (const [k, v] of assignment.queues) queues.set(k, [...v]);
  let matchedCount = 0;
  for (let i = 0; i < itemEls.length; i++) {
    const item = itemEls[i];
    const objectId = item.getAttribute('objectid');
    if (!objectId) continue;
    if (item.getAttribute('printable') === '0') continue;
    const parts: Mesh[] = [];
    resolveObjectMesh(
      files,
      store,
      rootPath,
      objectId,
      parseTransformAttr(item.getAttribute('transform')),
      parts,
      limits,
    );
    if (parts.length === 0) continue;
    const plateId = queues.get(objectId)?.shift();
    if (plateId !== undefined) matchedCount++;
    // An item is one rigidly-connected printed object; merging its
    // component meshes (not other items!) is correct.
    allObjects.push(applyScale(mergeMeshes(parts)));
    plateOf.push(plateId ?? UNPLACED_PLATE_ID);
  }

  // Some files have objects but no build items; fall back to all root meshes.
  if (allObjects.length === 0) {
    for (const [key, obj] of store) {
      if (key.startsWith(`${rootPath}#`) && obj.mesh && obj.mesh.indices.length > 0) {
        allObjects.push(applyScale(obj.mesh));
        plateOf.push(UNPLACED_PLATE_ID);
      }
    }
  }
  if (allObjects.length === 0) throw new Error('The 3MF contains no printable geometry');

  let plates: PlateInfo[];
  if (assignment && matchedCount > 0) {
    if (matchedCount < allObjects.length) {
      console.warn(
        `[warp-sim] ${fileName}: ${allObjects.length - matchedCount} of ${allObjects.length} ` +
          'objects not found in the plate layout — showing them as "Unplaced".',
      );
    }
    const byPlate = new Map<number, Mesh[]>();
    plateOf.forEach((id, i) =>
      (byPlate.get(id) ?? byPlate.set(id, []).get(id)!).push(allObjects[i]),
    );
    plates = [...byPlate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, objects]) => ({
        id,
        name:
          id === UNPLACED_PLATE_ID ? 'Unplaced' : assignment.names.get(id) || undefined,
        objects: centerMeshesOnBed(objects),
      }));
  } else {
    // No usable plate layout (plain 3MF, or a layout we failed to match).
    // If the objects clearly span multiple build areas, split them by gaps
    // instead of pretending they share one enormous plate.
    if (assignment) {
      console.warn(
        `[warp-sim] ${fileName}: plate layout did not match any build item — ` +
          'falling back to geometric grouping.',
      );
    }
    const groups = splitDistantGroups(allObjects);
    plates = groups.map((objects, i) => ({
      id: i + 1,
      name: groups.length > 1 ? `Area ${i + 1}` : undefined,
      objects: centerMeshesOnBed(objects),
    }));
  }

  console.info(
    `[warp-sim] ${fileName}: ${plates.length} plate(s) — ` +
      plates
        .map((p) => `${p.name ?? `Plate ${p.id}`}: ${p.objects.length} object(s)`)
        .join(', '),
  );

  return {
    plates,
    objectCount: allObjects.length,
    settings: extractSlicerSettings(files),
    fileName,
  };
}

/** Binary + ASCII STL fallback so users can drop plain models too. */
export function parseSTL(
  buffer: ArrayBuffer,
  fileName: string,
  limits: ParseLimits = DEFAULT_LIMITS,
): ProjectInfo {
  if (buffer.byteLength > limits.maxFileBytes) {
    throw new Error(
      `File is too large (${mb(buffer.byteLength)} MB); limit is ${mb(limits.maxFileBytes)} MB.`,
    );
  }
  const view = new DataView(buffer);
  const isBinary = (() => {
    if (buffer.byteLength < 84) return false;
    const nTri = view.getUint32(80, true);
    return buffer.byteLength === 84 + nTri * 50;
  })();

  let vertices: Float32Array;
  if (isBinary) {
    const nTri = view.getUint32(80, true);
    if (nTri > limits.maxTriangles) {
      throw new Error(
        `STL has too many triangles (${nTri.toLocaleString()}); limit is ` +
          `${limits.maxTriangles.toLocaleString()}.`,
      );
    }
    vertices = new Float32Array(nTri * 9);
    for (let t = 0; t < nTri; t++) {
      const base = 84 + t * 50 + 12; // skip normal
      for (let c = 0; c < 9; c++) {
        vertices[t * 9 + c] = view.getFloat32(base + c * 4, true);
      }
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const coords: number[] = [];
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      coords.push(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    vertices = new Float32Array(coords);
  }
  if (vertices.length < 9) throw new Error('STL contains no triangles');
  if (vertices.length / 9 > limits.maxTriangles) {
    throw new Error(
      `STL has too many triangles (${Math.floor(vertices.length / 9).toLocaleString()}); ` +
        `limit is ${limits.maxTriangles.toLocaleString()}.`,
    );
  }
  const indices = new Uint32Array(vertices.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  const mesh = centerMeshesOnBed([{ vertices, indices }])[0];
  return {
    plates: [{ id: 1, objects: [mesh] }],
    objectCount: 1,
    settings: { filamentTypes: [] },
    fileName,
  };
}

export function parseProjectFile(
  buffer: ArrayBuffer,
  fileName: string,
  limits: ParseLimits = DEFAULT_LIMITS,
): ProjectInfo {
  if (/\.stl$/i.test(fileName)) return parseSTL(buffer, fileName, limits);
  return parse3MF(buffer, fileName, limits);
}
