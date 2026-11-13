import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Recording } from "../core/analysis.ts";
import { parseWPILog } from "../core/wpilog.ts";
import { invoke, nativeRead } from "../native";

/** Robot and field models from AdvantageScope's asset folders (the team's CAD robot, the season field). */
interface Asset {
  kind: "robot" | "field";
  name: string;
  dir: string;
  config: string;
  models: string[];
}
interface Pose3 {
  t: number;
  p: [number, number, number];
  q: [number, number, number, number];
}
/** What the 3D replay draws from one simulation log. */
export interface Track3D {
  robot: Pose3[];
  components: Pose3[][];
  /** Shots in flight: per sample time, the positions of every piece in the air. */
  flying: { t: number; points: [number, number, number][] }[];
  duration: number;
}

const loader = new GLTFLoader();
const models = new Map<string, Promise<THREE.Group>>();
function model(path: string) {
  if (!models.has(path))
    models.set(
      path,
      invoke<ArrayBuffer | number[]>("ascope_model", { path })
        .then((raw) => (raw instanceof ArrayBuffer ? raw : Uint8Array.from(raw).buffer))
        .then((bytes) => new Promise<THREE.Group>((done, fail) => loader.parse(bytes, "", (g) => done(g.scene), fail))),
    );
  return models.get(path)!;
}
let assetList: Promise<Asset[]> | undefined;
const assets = () => (assetList ??= invoke<Asset[]>("ascope_assets", {}));

/** Pose channels `<prefix>/x … /qz` sampled into a time series. */
function poses(rec: Recording, prefix: string): Pose3[] {
  const ch = (k: string) => rec.channels.find((c) => c.name === `${prefix}/${k}`);
  const [x, y, z, qw, qx, qy, qz] = ["x", "y", "z", "qw", "qx", "qy", "qz"].map(ch);
  if (!x || !y) return [];
  const at = (c: Recording["channels"][number] | undefined, i: number, fallback: number) => (c && typeof c.samples[i]?.value === "number" ? (c.samples[i].value as number) : fallback);
  return x.samples.map((s, i) => ({ t: s.time, p: [s.value as number, at(y, i, 0), at(z, i, 0)], q: [at(qx, i, 0), at(qy, i, 0), at(qz, i, 0), at(qw, i, 1)] }));
}

export function track3D(rec: Recording): Track3D | undefined {
  const robot = poses(rec, "/RealOutputs/Sim/RobotPose");
  if (!robot.length) return undefined;
  const components: Pose3[][] = [];
  for (let i = 0; ; i++) {
    const c = poses(rec, `/RealOutputs/Sim/Components/${i}`);
    if (!c.length) break;
    components.push(c);
  }
  // Pieces in flight: element i's x/y/z channels, gathered per sample time.
  const flyingX = rec.channels.filter((c) => /^\/RealOutputs\/Sim\/FlyingFuel\/\d+\/x$/.test(c.name));
  const byTime = new Map<number, [number, number, number][]>();
  for (const cx of flyingX) {
    const base = cx.name.slice(0, -2);
    const cy = rec.channels.find((c) => c.name === `${base}/y`),
      cz = rec.channels.find((c) => c.name === `${base}/z`);
    cx.samples.forEach((s, i) => {
      const key = Math.round(s.time * 50) / 50;
      const list = byTime.get(key) ?? [];
      list.push([s.value as number, (cy?.samples[i]?.value as number) ?? 0, (cz?.samples[i]?.value as number) ?? 0]);
      byTime.set(key, list);
    });
  }
  const flying = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, points]) => ({ t, points }));
  return { robot, components, flying, duration: robot[robot.length - 1].t };
}

export async function loadTrack3D(path: string) {
  return track3D(parseWPILog(await nativeRead(path), path.split("/").pop() ?? path));
}

const sampleAt = <T extends { t: number }>(list: T[], t: number): T | undefined => {
  let lo = 0,
    hi = list.length - 1;
  if (hi < 0) return undefined;
  if (t <= list[0].t) return list[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return list[lo];
};

const IN = 0.0254;

/**
 * CAD and field exports come in as polished metal (the 2026 field: metalness 1, roughness 0.2),
 * which reads as glare and black patches. Make them matte, and on the field deepen the mid greys
 * (the carpet) so robots stand out. The field's staged game pieces are hidden: they would not move
 * as the simulated robot picks pieces up.
 */
function matte(root: THREE.Object3D, field: boolean) {
  const seen = new Set<THREE.Material>();
  const hsl = { h: 0, s: 0, l: 0 };
  root.traverse((o) => {
    if (field && /Fuel/i.test(o.name)) o.visible = false;
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

interface Rig {
  root: THREE.Group;
  components: THREE.Group[];
  fuel: THREE.InstancedMesh;
}

/** A robot (base plus articulated components) from an AdvantageScope robot asset. */
async function buildRobot(asset: Asset): Promise<Rig> {
  const config = JSON.parse(asset.config);
  const root = new THREE.Group();
  const base = (await model(`${asset.dir}/model.glb`)).clone(true);
  const parts: THREE.Group[] = [];
  root.add(base);
  const componentFiles = asset.models.filter((m) => /^model_\d+\.glb$/.test(m)).sort((a, b) => Number(a.slice(6, -4)) - Number(b.slice(6, -4)));
  for (const [i, file] of componentFiles.entries()) {
    const group = new THREE.Group();
    const mesh = (await model(`${asset.dir}/${file}`)).clone(true);
    // AdvantageScope: the zeroed position moves the part so its joint sits at the component origin.
    const zeroed = config.components?.[i]?.zeroedPosition ?? [0, 0, 0];
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
  const fuel = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 12, 8), new THREE.MeshStandardMaterial({ color: 0xf2c200 }), 64);
  fuel.count = 0;
  return { root, components: parts, fuel };
}

const GHOST = new THREE.MeshBasicMaterial({ color: 0x9a92b8, transparent: true, opacity: 0.35, depthWrite: false });
function setGhost(rig: Rig, ghost: boolean) {
  if (rig.root.userData.ghost === ghost) return;
  rig.root.userData.ghost = ghost;
  rig.root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = ghost ? GHOST : o.userData.solid;
  });
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
  const f = sampleAt(track.flying, t);
  const m = new THREE.Matrix4();
  const points = f && Math.abs(f.t - t) < 0.06 ? f.points.slice(0, 64) : [];
  points.forEach((p, i) => rig.fuel.setMatrixAt(i, m.makeTranslation(p[0] - offset.x, p[1] - offset.y, p[2])));
  rig.fuel.count = points.length;
  rig.fuel.instanceMatrix.needsUpdate = true;
}

export type View3D = "side" | "overlay";

/** Before and after runs in 3D on one clock: side by side (same camera) or the old run as a ghost. */
export function Replay3D({
  logs,
  time,
  view,
  onCanvas,
}: {
  logs: { before?: string; after?: string };
  time: number;
  view: View3D;
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
  const key = useMemo(() => `${logs.before}|${logs.after}`, [logs.before, logs.after]);

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
        const field = list.find((a) => a.kind === "field" && /2026FRCField/.test(a.name)) ?? list.find((a) => a.kind === "field" && !/FTC/.test(a.name));
        const robot = list.find((a) => a.kind === "robot" && a.dir.includes("userAssets")) ?? list.find((a) => a.kind === "robot");
        if (!field || !robot) throw new Error("Install AdvantageScope and add the team's robot model (tools/sim/cad-to-advantagescope.py) to see 3D replays.");
        const fieldConfig = JSON.parse(field.config);
        const offset = new THREE.Vector2(((fieldConfig.widthInches ?? 651.22) * IN) / 2, ((fieldConfig.heightInches ?? 317.7) * IN) / 2);
        state.current!.offset = offset;
        const fieldModel = (await model(`${field.dir}/model.glb`)).clone(true);
        for (const r of fieldConfig.rotations ?? []) {
          const axis = r.axis === "x" ? new THREE.Vector3(1, 0, 0) : r.axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
          fieldModel.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, (r.degrees * Math.PI) / 180));
        }
        if (Array.isArray(fieldConfig.position)) fieldModel.position.set(...(fieldConfig.position as [number, number, number]));
        matte(fieldModel, true);
        scene.add(fieldModel);
        const [before, after] = await Promise.all([logs.before ? loadTrack3D(logs.before) : undefined, logs.after ? loadTrack3D(logs.after) : undefined]);
        if (cancelled) return;
        if (!before && !after) throw new Error("These runs did not log a 3D robot pose (/RealOutputs/Sim/RobotPose).");
        state.current!.tracks = { before, after };
        if (before) {
          const rig = await buildRobot(robot);
          scene.add(rig.root, rig.fuel);
          state.current!.rigs.before = rig;
        }
        if (after) {
          const rig = await buildRobot(robot);
          scene.add(rig.root, rig.fuel);
          state.current!.rigs.after = rig;
        }
        // Start above the robot, looking at it from the middle of the field (never from inside a wall).
        const start = (after ?? before)!.robot[0];
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
      const show = (rig: Rig | undefined, on: boolean) => {
        if (rig) rig.root.visible = rig.fuel.visible = on;
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
        show(s.rigs.before, true);
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
