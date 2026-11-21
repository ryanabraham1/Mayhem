import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { sampleAt, track3D, type Track3D } from "./sim3d.ts";
import { invoke, nativeRead } from "../native";
import { DEFAULT_SEASON, type Season } from "../core/seasons.ts";

/** Robot and field models from AdvantageScope's asset folders (the team's CAD robot, the season field). */
interface Asset {
  kind: "robot" | "field";
  name: string;
  dir: string;
  config: string;
  models: string[];
}

const loader = new GLTFLoader();
const models = new Map<string, Promise<THREE.Group>>();
function model(path: string) {
  if (!models.has(path)) {
    const loading = invoke<ArrayBuffer | number[]>("ascope_model", { path })
      .then((raw) => (raw instanceof ArrayBuffer ? raw : Uint8Array.from(raw).buffer))
      .then((bytes) => new Promise<THREE.Group>((done, fail) => loader.parse(bytes, "", (g) => done(g.scene), fail)));
    // A failed load is not remembered: the next replay tries again instead of failing forever.
    loading.catch(() => models.get(path) === loading && models.delete(path));
    models.set(path, loading);
  }
  return models.get(path)!;
}
let assetList: Promise<Asset[]> | undefined;
const assets = () => {
  if (!assetList) {
    const loading = invoke<Asset[]>("ascope_assets", {});
    loading.catch(() => assetList === loading && (assetList = undefined));
    assetList = loading;
  }
  return assetList;
};

export async function loadTrack3D(path: string) {
  return track3D(await nativeRead(path));
}

const IN = 0.0254;
const axis = (a: string) => (a === "x" ? new THREE.Vector3(1, 0, 0) : a === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1));
/** AdvantageScope's `rotations` list (applied in order) as one quaternion. */
const rotations = (list: { axis: string; degrees: number }[] | undefined) =>
  (list ?? []).reduce((q, r) => new THREE.Quaternion().setFromAxisAngle(axis(r.axis), (r.degrees * Math.PI) / 180).multiply(q), new THREE.Quaternion());

/**
 * CAD and field exports come in as polished metal (the 2026 field: metalness 1, roughness 0.2),
 * which reads as glare and black patches. Make them matte, and on the field deepen the mid greys
 * (the carpet) so robots stand out. The field's staged game pieces are hidden: the simulation logs
 * every piece itself (Sim/Fuel), where it really is.
 */
function matte(root: THREE.Object3D, field: boolean, hide?: RegExp) {
  const seen = new Set<THREE.Material>();
  const hsl = { h: 0, s: 0, l: 0 };
  root.traverse((o) => {
    if (hide && hide.test(o.name)) o.visible = false;
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (seen.has(m) || !(m instanceof THREE.MeshStandardMaterial)) continue;
      seen.add(m);
      m.metalness = Math.min(m.metalness, 0.1);
      m.roughness = Math.max(m.roughness, 0.75);
      m.color.getHSL(hsl);
      if (field && hsl.s < 0.08 && hsl.l > 0.2 && hsl.l < 0.6 && !m.transparent) m.color.setHSL(0.62, 0.06, hsl.l * 0.55);
    }
  });
}

/** One instanced mesh per part of the game piece model, so hundreds of pieces draw in a few calls. */
interface PieceMesh {
  meshes: THREE.InstancedMesh[];
  /** The piece model's own transform (its config rotations and position). */
  base: THREE.Matrix4;
}

/**
 * The season's game piece from the field asset (AdvantageScope's model_N.glb for each entry in
 * `gamePieces`; Fuel in 2026, Algae or Coral in 2025), or a plain ball when the field has none.
 */
async function pieceModel(field: Asset | undefined, name: RegExp): Promise<{ parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[]; base: THREE.Matrix4 }> {
  const config = field ? JSON.parse(field.config) : {};
  const index = Math.max(0, (config.gamePieces ?? []).findIndex((g: { name?: string }) => name.test(g.name ?? "")));
  const piece = config.gamePieces?.[index];
  const file = `model_${index}.glb`;
  if (field && piece && field.models.includes(file)) {
    try {
      const scene = await model(`${field.dir}/${file}`);
      scene.updateMatrixWorld(true);
      const parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) parts.push({ geometry: (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld), material: o.material as THREE.Material });
      });
      matte(scene, false);
      const base = new THREE.Matrix4().compose(new THREE.Vector3(...((piece.position as [number, number, number]) ?? [0, 0, 0])), rotations(piece.rotations), new THREE.Vector3(1, 1, 1));
      if (parts.length) return { parts, base };
    } catch {
      // fall through to a plain ball
    }
  }
  return { parts: [{ geometry: new THREE.SphereGeometry(0.075, 16, 12), material: new THREE.MeshStandardMaterial({ color: 0xf2a20e, roughness: 0.8 }) }], base: new THREE.Matrix4() };
}

function pieceMesh(shape: Awaited<ReturnType<typeof pieceModel>>, capacity: number): PieceMesh {
  const meshes = shape.parts.map((p) => {
    const m = new THREE.InstancedMesh(p.geometry, p.material, Math.max(1, capacity));
    m.count = 0;
    m.frustumCulled = false;
    return m;
  });
  return { meshes, base: shape.base };
}

interface Rig {
  root: THREE.Group;
  components: THREE.Group[];
  /** Every game piece of this run, on the ground and in the air. */
  pieces: PieceMesh;
  /**
   * 2025 runs that log Sim/Coral: coral drawn from its poses (rotation applied) and algae from
   * Sim/Algae. Then Sim/Fuel and Sim/FlyingFuel are not drawn: they repeat these as points.
   */
  posed?: { coral: PieceMesh; algae: PieceMesh };
  /** The robot code's pose estimate, a see-through copy of the robot (AdvantageScope's ghost). */
  estimate?: THREE.Group;
  /** Which samples are drawn now, so pieces are only rewritten when they change. */
  drawn: { fuel?: unknown; flying?: unknown; coral?: unknown; algae?: unknown };
}

/** A robot (base plus articulated components) from an AdvantageScope robot asset. */
async function robotModel(asset: Asset) {
  const config = JSON.parse(asset.config);
  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.quaternion.copy(rotations(config.rotations));
  if (Array.isArray(config.position)) holder.position.set(...(config.position as [number, number, number]));
  root.add(holder);
  holder.add((await model(`${asset.dir}/model.glb`)).clone(true));
  const parts: THREE.Group[] = [];
  const componentFiles = asset.models.filter((m) => /^model_\d+\.glb$/.test(m)).sort((a, b) => Number(a.slice(6, -4)) - Number(b.slice(6, -4)));
  for (const [i, file] of componentFiles.entries()) {
    const group = new THREE.Group();
    const mesh = (await model(`${asset.dir}/${file}`)).clone(true);
    // AdvantageScope: the zeroed rotations and position move the part so its joint sits at the component origin.
    const zeroed = config.components?.[i]?.zeroedPosition ?? [0, 0, 0];
    mesh.quaternion.copy(rotations(config.components?.[i]?.zeroedRotations));
    mesh.position.set(zeroed[0], zeroed[1], zeroed[2]);
    group.add(mesh);
    root.add(group);
    parts.push(group);
  }
  matte(root, false);
  // Keep each mesh's own material; overlay mode swaps the before robot to a see-through ghost.
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.userData.solid = o.material;
  });
  return { root, components: parts };
}

const GHOST = new THREE.MeshBasicMaterial({ color: 0x9a92b8, transparent: true, opacity: 0.35, depthWrite: false });
/** AdvantageScope's default ghost colour. */
const ESTIMATE = new THREE.MeshBasicMaterial({ color: 0x2fd36b, transparent: true, opacity: 0.3, depthWrite: false });
function paint(root: THREE.Object3D, material: THREE.Material | undefined) {
  if (root.userData.paint === material) return;
  root.userData.paint = material;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = material ?? o.userData.solid;
  });
}
const setGhost = (rig: Rig, ghost: boolean) => paint(rig.root, ghost ? GHOST : undefined);

type Shape = Awaited<ReturnType<typeof pieceModel>>;
const pieceMeshes = (rig: Rig) => [...rig.pieces.meshes, ...(rig.posed ? [...rig.posed.coral.meshes, ...rig.posed.algae.meshes] : [])];

async function buildRig(asset: Asset, shape: Shape, track: Track3D, posed?: { coral: Shape; algae: Shape }): Promise<Rig> {
  const robot = await robotModel(asset);
  let estimate: THREE.Group | undefined;
  if (track.estimate.length) {
    estimate = (await robotModel(asset)).root;
    paint(estimate, ESTIMATE);
    estimate.renderOrder = 1;
  }
  return {
    ...robot,
    pieces: pieceMesh(shape, posed ? 0 : track.maxPieces),
    posed: posed && { coral: pieceMesh(posed.coral, track.maxCoral), algae: pieceMesh(posed.algae, track.maxAlgae) },
    estimate,
    drawn: {},
  };
}

const place = new THREE.Matrix4();
const turn = new THREE.Quaternion();
const spot = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);
function finish(pieces: PieceMesh, n: number) {
  for (const m of pieces.meshes) {
    m.count = Math.min(n, m.instanceMatrix.count);
    m.instanceMatrix.needsUpdate = true;
  }
}
function drawPieces(rig: Rig, track: Track3D, t: number, offset: THREE.Vector2) {
  // Before a list's first sample nothing is known yet: draw none of it rather than the future.
  const at = <T extends { t: number }>(list: T[]) => (list.length && t + 1e-6 >= list[0].t ? sampleAt(list, t) : undefined);
  if (rig.posed) {
    const coral = at(track.coral),
      algae = at(track.algae);
    if (rig.drawn.coral === coral && rig.drawn.algae === algae) return;
    rig.drawn = { coral, algae };
    const { coral: cm, algae: am } = rig.posed;
    const v = coral?.pose ?? new Float32Array();
    let n = 0;
    for (let i = 0; i + 6 < v.length; i += 7, n++) {
      // WPILib's quaternion is w, x, y, z; the model's base transform puts its axis on the pose's x.
      place.compose(spot.set(v[i] - offset.x, v[i + 1] - offset.y, v[i + 2]), turn.set(v[i + 4], v[i + 5], v[i + 6], v[i + 3]).normalize(), ONE).multiply(cm.base);
      for (const m of cm.meshes) if (n < m.instanceMatrix.count) m.setMatrixAt(n, place);
    }
    finish(cm, n);
    const xyz = algae?.xyz ?? new Float32Array();
    n = 0;
    for (let i = 0; i + 2 < xyz.length; i += 3, n++) {
      place.makeTranslation(xyz[i] - offset.x, xyz[i + 1] - offset.y, xyz[i + 2]).multiply(am.base);
      for (const m of am.meshes) if (n < m.instanceMatrix.count) m.setMatrixAt(n, place);
    }
    finish(am, n);
    return;
  }
  const fuel = at(track.fuel),
    flying = at(track.flying);
  if (rig.drawn.fuel === fuel && rig.drawn.flying === flying) return;
  rig.drawn = { fuel, flying };
  let n = 0;
  for (const set of [fuel, flying]) {
    if (!set) continue;
    const xyz = set.xyz;
    for (let i = 0; i + 2 < xyz.length; i += 3) {
      place.makeTranslation(xyz[i] - offset.x, xyz[i + 1] - offset.y, xyz[i + 2]).multiply(rig.pieces.base);
      for (const m of rig.pieces.meshes) if (n < m.instanceMatrix.count) m.setMatrixAt(n, place);
      n++;
    }
  }
  finish(rig.pieces, n);
}

function pose(rig: Rig, track: Track3D, t: number, offset: THREE.Vector2) {
  const r = sampleAt(track.robot, t);
  if (r) {
    rig.root.position.set(r.p[0] - offset.x, r.p[1] - offset.y, r.p[2]);
    rig.root.quaternion.set(...r.q);
  }
  track.components.forEach((list, i) => {
    const c = sampleAt(list, t);
    const g = rig.components[i];
    if (c && g) {
      g.position.set(...c.p);
      g.quaternion.set(...c.q);
    }
  });
  const e = rig.estimate && sampleAt(track.estimate, t);
  if (rig.estimate && e) {
    rig.estimate.position.set(e.x - offset.x, e.y - offset.y, 0);
    rig.estimate.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), e.heading);
  }
  drawPieces(rig, track, t, offset);
}

export type View3D = "side" | "overlay";

/** Before and after runs in 3D on one clock: side by side (same camera) or the old run as a ghost. */
export function Replay3D({
  season = DEFAULT_SEASON,
  logs,
  time,
  view,
  estimate = true,
  onCanvas,
}: {
  /** The game whose field model to load. */
  season?: Season;
  logs: { before?: string; after?: string };
  time: number;
  view: View3D;
  /** Draw the pose estimate as a ghost, as AdvantageScope's 3D Field tab does. */
  estimate?: boolean;
  onCanvas?: (canvas: HTMLCanvasElement | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading the 3D field and robot…");
  const state = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    rigs: { before?: Rig; after?: Rig };
    tracks: { before?: Track3D; after?: Track3D };
    offset: THREE.Vector2;
  }>(undefined);
  const timeRef = useRef(time);
  timeRef.current = time;
  const viewRef = useRef(view);
  viewRef.current = view;
  const estimateRef = useRef(estimate);
  estimateRef.current = estimate;
  const key = useMemo(() => `${season.year}|${logs.before}|${logs.after}`, [season.year, logs.before, logs.after]);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setScissorTest(true);
    el.appendChild(renderer.domElement);
    onCanvas?.(renderer.domElement);
    // A clean, matte look (like simfrc): soft even light, no glare, colours kept true.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    const scene = new THREE.Scene();
    // CAD and field materials are physically based: without something to reflect they render black.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    // A dark arena around a lit field.
    scene.background = new THREE.Color(0x15161b);
    scene.fog = new THREE.Fog(0x15161b, 28, 60);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3c3f4a, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.35);
    sun.position.set(3, -5, 12);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe6ff, 0.45);
    fill.position.set(-6, 5, 8);
    scene.add(fill);
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
    camera.up.set(0, 0, 1);
    camera.position.set(-6, -6, 5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    state.current = { renderer, scene, camera, controls, rigs: {}, tracks: {}, offset: new THREE.Vector2() };

    (async () => {
      try {
        const list = await assets();
        const field = list.find((a) => a.kind === "field" && season.advantageScopeField.test(a.name)) ?? list.find((a) => a.kind === "field" && !/FTC/.test(a.name));
        const robot = list.find((a) => a.kind === "robot" && a.dir.includes("userAssets")) ?? list.find((a) => a.kind === "robot");
        if (!field || !robot) throw new Error("Install AdvantageScope and add the team's robot model (tools/sim/cad-to-advantagescope.py) to see 3D replays.");
        const fieldConfig = JSON.parse(field.config);
        const offset = new THREE.Vector2(((fieldConfig.widthInches ?? (season.field.length / IN)) * IN) / 2, ((fieldConfig.heightInches ?? (season.field.width / IN)) * IN) / 2);
        state.current!.offset = offset;
        const fieldModel = (await model(`${field.dir}/model.glb`)).clone(true);
        fieldModel.applyQuaternion(rotations(fieldConfig.rotations));
        if (Array.isArray(fieldConfig.position)) fieldModel.position.set(...(fieldConfig.position as [number, number, number]));
        matte(fieldModel, true, season.simLogsPieces ? season.gamePiece : undefined);
        scene.add(fieldModel);
        const [before, after] = await Promise.all([logs.before ? loadTrack3D(logs.before) : undefined, logs.after ? loadTrack3D(logs.after) : undefined]);
        if (cancelled) return;
        if (!before && !after) throw new Error("These runs did not log a 3D robot pose (/RealOutputs/Sim/RobotPose).");
        state.current!.tracks = { before, after };
        const shape = await pieceModel(field, season.gamePiece);
        // 2025 runs that log every coral's pose (Sim/Coral) draw coral and algae as they really sit.
        const posedRun = (track?: Track3D) => season.year === 2025 && !!track?.coral.length;
        const posed = posedRun(before) || posedRun(after) ? { coral: await pieceModel(field, /coral/i), algae: await pieceModel(field, /algae/i) } : undefined;
        // Those runs log every piece themselves, so the field's staged ones would be drawn twice.
        if (posed) {
          const staged = new Set(((fieldConfig.gamePieces ?? []) as { stagedObjects?: string[] }[]).flatMap((g) => g.stagedObjects ?? []).map((n) => THREE.PropertyBinding.sanitizeNodeName(n)));
          fieldModel.traverse((o) => void (staged.has(o.name) && (o.visible = false)));
        }
        for (const [side, track] of [["before", before], ["after", after]] as const) {
          if (!track) continue;
          const rig = await buildRig(robot, shape, track, posedRun(track) ? posed : undefined);
          if (cancelled) return;
          scene.add(rig.root, ...pieceMeshes(rig));
          if (rig.estimate) scene.add(rig.estimate);
          state.current!.rigs[side] = rig;
        }
        // Start above the robot, looking at it from the middle of the field (never from inside a wall).
        // Where it is now, not where it spawned: opened mid-replay, or after the auto moved it to its
        // start pose, the spawn spot can be across the field and the robot would be out of view.
        const lead = (after ?? before)!;
        const start = sampleAt(lead.robot, timeRef.current) ?? lead.robot[0];
        const at = new THREE.Vector3(start.p[0] - offset.x, start.p[1] - offset.y, 0.4);
        const toCenter = new THREE.Vector3(-at.x, -at.y * 0.4, 0).normalize();
        controls.target.copy(at);
        camera.position.set(at.x + toCenter.x * 3.6, at.y + toCenter.y * 3.6, 3.4);
        setStatus("");
      } catch (e) {
        setStatus(String(e instanceof Error ? e.message : e));
      }
    })();

    let followed: THREE.Vector3 | undefined;
    const render = () => {
      frame = requestAnimationFrame(render);
      const s = state.current!;
      const w = el.clientWidth,
        h = el.clientHeight;
      if (renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.floor(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
      const t = timeRef.current;
      if (s.rigs.before && s.tracks.before) pose(s.rigs.before, s.tracks.before, t, s.offset);
      if (s.rigs.after && s.tracks.after) pose(s.rigs.after, s.tracks.after, t, s.offset);
      // Follow the robot: move the camera with it, keeping the angle the person chose.
      const lead = s.rigs.after?.root ?? s.rigs.before?.root;
      if (lead) {
        const now = lead.position.clone().setZ(0.4);
        if (followed) {
          const delta = now.clone().sub(followed);
          camera.position.add(delta);
          controls.target.add(delta);
        }
        followed = now;
      }
      controls.update();
      const side = viewRef.current === "side" && s.rigs.before && s.rigs.after;
      // Each run's own pieces and pose estimate; overlaid, only the after run's (the before
      // robot is the ghost there, and two sets of pieces in one place would read as one jumble).
      const show = (rig: Rig | undefined, on: boolean, extras = on) => {
        if (!rig) return;
        rig.root.visible = on;
        for (const m of pieceMeshes(rig)) m.visible = extras;
        if (rig.estimate) rig.estimate.visible = extras && estimateRef.current;
      };
      if (side) {
        camera.aspect = w / 2 / h;
        camera.updateProjectionMatrix();
        for (const [i, which] of (["before", "after"] as const).entries()) {
          show(s.rigs.before, which === "before");
          show(s.rigs.after, which === "after");
          setGhost(s.rigs.before!, false);
          renderer.setViewport((i * w) / 2, 0, w / 2, h);
          renderer.setScissor((i * w) / 2, 0, w / 2, h);
          renderer.render(scene, camera);
        }
      } else {
        show(s.rigs.before, true, !s.rigs.after);
        show(s.rigs.after, true);
        if (s.rigs.before) setGhost(s.rigs.before, !!s.rigs.after);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setViewport(0, 0, w, h);
        renderer.setScissor(0, 0, w, h);
        renderer.render(scene, camera);
      }
    };
    render();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      controls.dispose();
      scene.environment?.dispose();
      pmrem.dispose();
      renderer.dispose();
      // Give the GL context back now: WebKit allows only a few at once, and a context left for
      // garbage collection counts against the next replay's.
      renderer.forceContextLoss();
      el.removeChild(renderer.domElement);
      onCanvas?.(null);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-replay-3d" ref={host} aria-label="3D replay (drag to orbit, scroll to zoom)">
      {status && <p className="mx-replay-3d-status">{status}</p>}
      {view === "side" && logs.before && logs.after && !status && (
        <>
          <span className="mx-replay-3d-tag is-left">Before</span>
          <span className="mx-replay-3d-tag is-right">After</span>
        </>
      )}
    </div>
  );
}
