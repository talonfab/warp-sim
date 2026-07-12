import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Mesh, computeBBox, subdivideMesh } from '../lib/geometry';
import { vertexRiskField } from '../lib/simulation';
import { PlateObjectResult } from '../lib/plateSim';
import { riskColor } from '../lib/colors';

interface Props {
  /** The plate's objects — stable across filament switches (keys the camera framing). */
  objects: Mesh[];
  /** Per-object simulation results for the active filament, parallel to `objects`. */
  parts: PlateObjectResult[];
}

interface SceneRefs {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  group: THREE.Group | null;
  /**
   * Objects the camera was last framed for. Lives with the scene, not in a
   * component ref: the camera is recreated whenever the scene is (e.g.
   * StrictMode's dev double-mount), and a marker that outlived it would skip
   * framing the fresh camera — leaving it at the origin and the viewport
   * blank on first load.
   */
  framedObjects: Mesh[] | null;
  raf: number;
}

const SURFACE_LIGHT = 0xf9f9f7;
const SURFACE_DARK = 0x0d0d0d;

export default function Viewer3D({ objects, parts }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const refs = useRef<SceneRefs | null>(null);

  // Refine large faces so the risk gradient can actually paint across them.
  // Keyed on the plate's objects so filament switches reuse the subdivision.
  const displayMeshes = useMemo(() => {
    return objects.map((mesh) => {
      const box = computeBBox(mesh);
      const diag = Math.hypot(
        box.max[0] - box.min[0],
        box.max[1] - box.min[1],
        box.max[2] - box.min[2],
      );
      return subdivideMesh(mesh, Math.max(diag / 48, 1));
    });
  }, [objects]);

  // One-time scene setup.
  useEffect(() => {
    const container = containerRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const applyBg = () => scene.background = new THREE.Color(dark.matches ? SURFACE_DARK : SURFACE_LIGHT);
    applyBg();
    dark.addEventListener('change', applyBg);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.up.set(0, 0, 1); // printer coordinates: z is up
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(120, -180, 220);
    scene.add(dir);

    const bedGrid = new THREE.GridHelper(256, 16, 0x898781, 0xc3c2b7);
    bedGrid.rotation.x = Math.PI / 2; // GridHelper lies in xz; rotate into xy
    scene.add(bedGrid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const state: SceneRefs = {
      renderer,
      scene,
      camera,
      controls,
      group: null,
      framedObjects: null,
      raf: 0,
    };
    refs.current = state;

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const animate = () => {
      state.raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      dark.removeEventListener('change', applyBg);
      controls.dispose();
      renderer.dispose();
      // dispose() alone does not release the WebGL context; browsers cap
      // live contexts (~16) and silently fail creation past it, which shows
      // up as a blank viewport after enough re-mounts (StrictMode doubles
      // them in dev). Force the loss so re-mounting never exhausts the pool.
      renderer.forceContextLoss();
      container.removeChild(renderer.domElement);
      refs.current = null;
    };
  }, []);

  // Rebuild the meshes whenever the plate or the active simulation changes.
  useEffect(() => {
    const state = refs.current;
    if (!state) return;

    if (state.group) {
      state.scene.remove(state.group);
      for (const child of state.group.children) {
        const m = child as THREE.Mesh;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      state.group = null;
    }

    const group = new THREE.Group();
    const unionBox = new THREE.Box3();
    parts.forEach((part, i) => {
      const displayMesh = displayMeshes[i];
      if (!displayMesh || displayMesh.vertices.length === 0) return;
      const risk = vertexRiskField(displayMesh, part.grid, part.result);
      const colors = new Float32Array(displayMesh.vertices.length);
      for (let v = 0; v < risk.length; v++) {
        const [r, g, b] = riskColor(risk[v]);
        colors[v * 3] = r / 255;
        colors[v * 3 + 1] = g / 255;
        colors[v * 3 + 2] = b / 255;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(displayMesh.vertices, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      // A single non-finite vertex would poison the union box and leave the
      // camera pointing at NaN — skip such objects from framing.
      const bb = geometry.boundingBox!;
      if (Number.isFinite(bb.min.x) && Number.isFinite(bb.max.x)) unionBox.union(bb);

      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.05,
        roughness: 0.65,
        side: THREE.DoubleSide,
      });
      group.add(new THREE.Mesh(geometry, material));
    });
    state.scene.add(group);
    state.group = group;

    // Frame the plate only when the plate itself changes, so switching
    // filaments doesn't reset the user's camera.
    if (state.framedObjects !== objects && !unionBox.isEmpty()) {
      state.framedObjects = objects;
      const sphere = unionBox.getBoundingSphere(new THREE.Sphere());
      if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
      const dist = sphere.radius * 2.6 + 10;
      state.camera.position.set(
        sphere.center.x + dist * 0.7,
        sphere.center.y - dist * 0.7,
        sphere.center.z + dist * 0.55,
      );
      state.controls.target.copy(sphere.center);
      state.controls.update();
    }
  }, [objects, displayMeshes, parts]);

  return <div ref={containerRef} className="viewer" aria-label="3D warp risk heatmap" />;
}
