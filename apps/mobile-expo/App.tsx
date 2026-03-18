import { StatusBar } from "expo-status-bar";
import { ExpoWebGLRenderingContext, GLView } from "expo-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  PanResponder,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as THREE from "three";
import { GLTFLoader, SkeletonUtils } from "three-stdlib";

// ─── Types ───────────────────────────────────────────────────────────────────

type Actor = {
  actorId: string;
  modelName: string;
  name?: string;
  position: [number, number, number];
  movementSpeed?: number;
  currentAnimation?: string;
  facingYaw?: number;
  health?: number;
  lastChat?: string;
};

type ChatMsg = { actorId: string; text: string; at: number };
type CombatEvent = Record<string, unknown>;

type WorldState = {
  actors: Actor[];
  chats: ChatMsg[];
  combatEvents: CombatEvent[];
};

type LabelData = {
  actorId: string;
  name: string;
  health: number;
  chat?: string;
  chatExpiresAt: number;
  x: number;
  y: number;
  visible: boolean;
};

// ─── Animation clip matching (mirrors server.js) ─────────────────────────────

const CLIP_KEYWORDS: Record<string, string[]> = {
  "idle loop": ["idle"],
  "walk loop": ["walk"],
  "sprint loop": ["sprint", "run"],
  "hit chest": ["hit chest", "hit_chest", "chest"],
  "hit knockback rm": ["knockback"],
  "fighting right jab": ["right jab", "jab right"],
  "fighting left jab": ["left jab", "jab left"],
  defend: ["defend", "block", "guard"],
  dizzy: ["dizzy", "stun"],
  "jump start": ["jump start", "jump_start"],
  "jump land": ["jump land", "land"],
  "dance loop": ["dance"],
  backflip: ["backflip", "back flip"],
  meditate: ["meditate", "meditation"],
};

const normClip = (v: string) => String(v || "").trim().toLowerCase();

const findBestClip = (
  clips: THREE.AnimationClip[],
  requested: string
): THREE.AnimationClip | null => {
  if (!clips.length) return null;
  const wanted = normClip(requested);
  if (!wanted) return null;
  const exact = clips.find((c) => normClip(c.name) === wanted);
  if (exact) return exact;
  const keys = CLIP_KEYWORDS[wanted] || [wanted];
  return (
    clips.find((c) => {
      const n = normClip(c.name);
      return keys.some((k) => n.includes(k));
    }) ?? null
  );
};

// ─── Actor entity (Three.js objects for one spawned actor) ───────────────────

type ActorEntity = {
  actorId: string;
  root: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  clips: THREE.AnimationClip[];
  clipActions: Map<string, THREE.AnimationAction>;
  currentClipName: string;
  glow: THREE.Mesh;
  trail: { line: THREE.Line; points: THREE.Vector3[] };
  targetPosition: THREE.Vector3;
  targetYaw: number;
  targetSpeed: number;
  requestedAnimation: string;
  lastChat: string;
  chatExpiresAt: number;
  lastHealth: number;
};

// ─── Scene ref (all Three.js state, lives outside React state) ───────────────

type SceneRef = {
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
  gl: ExpoWebGLRenderingContext | null;
  actorEntities: Map<string, ActorEntity>;
  modelCache: Map<string, Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>>;
  pendingCreates: Map<string, Promise<ActorEntity>>;
  combatCursor: number;
  glowT: number;
  loader: GLTFLoader;
  // orbit camera
  theta: number; // horizontal angle
  phi: number; // vertical angle
  radius: number;
  target: THREE.Vector3;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const toVec3 = (pos?: [number, number, number] | null) =>
  new THREE.Vector3(Number(pos?.[0] ?? 0), Number(pos?.[1] ?? 0), Number(pos?.[2] ?? 0));

const normalizeAngle = (a: number) => {
  let n = Number(a) || 0;
  while (n > Math.PI) n -= Math.PI * 2;
  while (n < -Math.PI) n += Math.PI * 2;
  return n;
};

const turnToward = (cur: number, tgt: number, step: number) => {
  const delta = normalizeAngle(tgt - cur);
  if (Math.abs(delta) <= step) return normalizeAngle(tgt);
  return normalizeAngle(cur + Math.sign(delta) * step);
};

const fitToHeight = (obj: THREE.Object3D, h: number) => {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.y < 0.0001) return;
  obj.scale.multiplyScalar(h / size.y);
  const boxAfter = new THREE.Box3().setFromObject(obj);
  obj.position.y += 0.02 - boxAfter.min.y;
};

const makeFallback = () => {
  const g = new THREE.Group();
  g.add(
    Object.assign(
      new THREE.Mesh(
        new THREE.CapsuleGeometry(0.28, 1.0, 4, 10),
        new THREE.MeshStandardMaterial({ color: 0x7ec8ff, emissive: 0x114677, emissiveIntensity: 0.36 })
      ),
      { position: new THREE.Vector3(0, 0.8, 0) }
    )
  );
  return g;
};

const makeGlowRing = () => {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.62, 28),
    new THREE.MeshBasicMaterial({ color: 0x7de3ff, transparent: true, opacity: 0.72, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  return ring;
};

const makeTrail = () => {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 18; i++) points.push(new THREE.Vector3(0, 0.04, 0));
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0x8fe8ff, transparent: true, opacity: 0.52 });
  return { line: new THREE.Line(geo, mat), points };
};

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SERVER = "http://localhost:8787";
const POLL_MS = 350;
const POLL_IDLE_MS = 900;
const LABEL_UPDATE_INTERVAL_MS = 80;
const LABEL_WIDTH = 130;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState("");
  const [chats, setChats] = useState<ChatMsg[]>([]);
  const [labels, setLabels] = useState<LabelData[]>([]);
  const [sceneSize, setSceneSize] = useState({ w: 1, h: 1 });

  const sceneSizeRef = useRef({ w: 1, h: 1 });
  const serverUrlRef = useRef(serverUrl);
  const sessionIdRef = useRef<string | null>(null);
  const worldRef = useRef<WorldState>({ actors: [], chats: [], combatEvents: [] });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLabelUpdate = useRef(0);

  useEffect(() => { serverUrlRef.current = serverUrl; }, [serverUrl]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  const sceneRef = useRef<SceneRef>({
    renderer: null,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(56, 1, 0.1, 120),
    clock: new THREE.Clock(),
    gl: null,
    actorEntities: new Map(),
    modelCache: new Map(),
    pendingCreates: new Map(),
    combatCursor: 0,
    glowT: 0,
    loader: new GLTFLoader(),
    theta: Math.PI / 4,
    phi: Math.PI / 4,
    radius: 14,
    target: new THREE.Vector3(0, 1.3, 0),
  });

  // ── Session ────────────────────────────────────────────────────────────────

  const connectShared = async () => {
    try {
      setConnecting(true);
      setStatus("Connecting…");
      const res = await fetch(`${serverUrlRef.current}/api/session/shared`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessionId(data.sessionId);
      setStatus(`Connected · ${data.sessionId.slice(0, 8)}…`);
      schedulePoll(data.sessionId, POLL_MS);
    } catch (e) {
      setStatus(`Failed: ${String(e)}`);
    } finally {
      setConnecting(false);
    }
  };

  const disconnectSession = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setSessionId(null);
    setStatus("Disconnected");
    setChats([]);
    setLabels([]);
    worldRef.current = { actors: [], chats: [], combatEvents: [] };
    const s = sceneRef.current;
    s.actorEntities.forEach((e) => removeEntity(s, e));
    s.actorEntities.clear();
    s.combatCursor = 0;
  };

  const spawnActive = async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const res = await fetch(`${serverUrlRef.current}/api/scene/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("Spawned active character");
    } catch (e) {
      setStatus(`Spawn failed: ${String(e)}`);
    }
  };

  const resetWorld = async () => {
    try {
      await fetch(`${serverUrlRef.current}/api/world/reset`, { method: "POST" });
      setStatus("World reset");
    } catch (e) {
      setStatus(`Reset failed: ${String(e)}`);
    }
  };

  // ── World polling ──────────────────────────────────────────────────────────

  const schedulePoll = useCallback((sid: string, delay: number) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => doPoll(sid), delay);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doPoll = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`${serverUrlRef.current}/api/world?sessionId=${sid}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: WorldState = await res.json();
      worldRef.current = data;
      setChats([...(data.chats ?? [])].slice(-8).reverse());
      syncActors(data);
      schedulePoll(sid, POLL_MS);
    } catch {
      schedulePoll(sid, POLL_IDLE_MS);
    }
  }, [schedulePoll]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

  // ── Actor entity management ────────────────────────────────────────────────

  const loadModel = (modelName: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> => {
    const s = sceneRef.current;
    if (s.modelCache.has(modelName)) return s.modelCache.get(modelName)!;
    const ext = modelName.split(".").pop()?.toLowerCase();
    if (ext !== "glb" && ext !== "gltf") {
      const p = Promise.resolve({ scene: makeFallback(), animations: [] as THREE.AnimationClip[] });
      s.modelCache.set(modelName, p);
      return p;
    }
    const url = `${serverUrlRef.current}/assets/models/${encodeURIComponent(modelName)}`;
    const p = new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve) => {
      s.loader.load(
        url,
        (gltf) => resolve({ scene: gltf.scene as THREE.Group, animations: gltf.animations ?? [] }),
        undefined,
        () => resolve({ scene: makeFallback(), animations: [] })
      );
    });
    s.modelCache.set(modelName, p);
    return p;
  };

  const playClip = (entity: ActorEntity, requested: string) => {
    if (!entity.mixer || !entity.clips.length) return;
    const clip = findBestClip(entity.clips, requested) ?? findBestClip(entity.clips, "idle loop");
    if (!clip || entity.currentClipName === clip.name) return;
    const next = entity.clipActions.get(clip.name) ?? entity.mixer.clipAction(clip);
    entity.clipActions.set(clip.name, next);
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.2).play();
    if (entity.currentClipName) entity.clipActions.get(entity.currentClipName)?.fadeOut(0.2);
    entity.currentClipName = clip.name;
  };

  const createEntity = async (actor: Actor): Promise<ActorEntity> => {
    const s = sceneRef.current;
    const asset = await loadModel(actor.modelName);
    const model = SkeletonUtils.clone(asset.scene) as THREE.Group;
    fitToHeight(model, 1.8);

    const root = new THREE.Group();
    root.add(model);
    const glow = makeGlowRing();
    root.add(glow);
    root.position.copy(toVec3(actor.position));
    root.rotation.y = Number(actor.facingYaw ?? 0);
    s.scene.add(root);

    const trail = makeTrail();
    trail.line.frustumCulled = false;
    s.scene.add(trail.line);

    const mixer = asset.animations.length ? new THREE.AnimationMixer(model) : null;
    const clipActions = new Map<string, THREE.AnimationAction>();
    if (mixer) asset.animations.forEach((c) => clipActions.set(c.name, mixer.clipAction(c)));

    const entity: ActorEntity = {
      actorId: actor.actorId,
      root,
      mixer,
      clips: asset.animations,
      clipActions,
      currentClipName: "",
      glow,
      trail,
      targetPosition: toVec3(actor.position),
      targetYaw: Number(actor.facingYaw ?? 0),
      targetSpeed: Number(actor.movementSpeed ?? 1),
      requestedAnimation: normClip(actor.currentAnimation ?? "idle loop"),
      lastChat: "",
      chatExpiresAt: 0,
      lastHealth: Number(actor.health ?? 100),
    };
    playClip(entity, "idle loop");
    return entity;
  };

  const removeEntity = (s: SceneRef, entity: ActorEntity) => {
    s.scene.remove(entity.root);
    s.scene.remove(entity.trail.line);
    entity.mixer?.stopAllAction();
  };

  const syncActors = useCallback((world: WorldState) => {
    const s = sceneRef.current;
    const actors = world.actors ?? [];
    const nextIds = new Set(actors.map((a) => a.actorId));

    for (const actor of actors) {
      if (!actor?.actorId) continue;
      let entity = s.actorEntities.get(actor.actorId);
      if (!entity) {
        if (!s.pendingCreates.has(actor.actorId)) {
          const creation = createEntity(actor)
            .then((created) => {
              if (s.actorEntities.has(actor.actorId)) {
                removeEntity(s, created);
                return s.actorEntities.get(actor.actorId)!;
              }
              s.actorEntities.set(actor.actorId, created);
              return created;
            })
            .finally(() => s.pendingCreates.delete(actor.actorId));
          s.pendingCreates.set(actor.actorId, creation);
        }
        continue; // entity not ready yet; will be updated next poll
      }
      entity.targetPosition.copy(toVec3(actor.position)).setY(0);
      if (Number.isFinite(actor.facingYaw)) entity.targetYaw = Number(actor.facingYaw);
      entity.targetSpeed = Number(actor.movementSpeed ?? 1);
      entity.requestedAnimation = normClip(actor.currentAnimation ?? "idle loop");
      playClip(entity, entity.requestedAnimation);
      if (actor.lastChat && actor.lastChat !== entity.lastChat) {
        entity.lastChat = actor.lastChat;
        entity.chatExpiresAt = performance.now() + 3600;
      }
      if (entity.lastHealth !== Number(actor.health ?? 100)) {
        entity.lastHealth = Number(actor.health ?? 100);
      }
    }

    for (const [id, entity] of s.actorEntities.entries()) {
      if (!nextIds.has(id)) {
        removeEntity(s, entity);
        s.actorEntities.delete(id);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Three.js scene init (called once when GL context is ready) ────────────

  const onContextCreate = useCallback(async (gl: ExpoWebGLRenderingContext) => {
    const s = sceneRef.current;
    s.gl = gl;

    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    s.renderer = new THREE.WebGLRenderer({
      // @ts-ignore — expo-gl context is not a standard HTMLCanvas context
      context: gl,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    s.renderer.setSize(w, h, false);
    s.renderer.setPixelRatio(1);
    s.renderer.outputColorSpace = THREE.SRGBColorSpace;

    s.camera.aspect = w / h;
    s.camera.updateProjectionMatrix();

    // Environment
    s.scene.fog = new THREE.Fog(0x0c1729, 12, 48);
    s.scene.add(new THREE.HemisphereLight(0x8fc8ff, 0x0a1120, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(6, 14, 8);
    s.scene.add(key);

    // Ground
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(22, 64),
      new THREE.MeshStandardMaterial({
        color: 0x0f2137,
        metalness: 0.1,
        roughness: 0.9,
        emissive: 0x072244,
        emissiveIntensity: 0.36,
      })
    );
    ground.rotation.x = -Math.PI / 2;
    s.scene.add(ground);

    // Grid
    const grid = new THREE.GridHelper(40, 40, 0x4ca4ff, 0x1f4268);
    grid.position.y = 0.005;
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    s.scene.add(grid);

    // Render loop
    const loop = () => {
      requestAnimationFrame(loop);
      const delta = Math.min(s.clock.getDelta(), 0.05);
      const now = performance.now();
      s.glowT += delta;

      for (const entity of s.actorEntities.values()) {
        // Smooth position
        const toTgt = entity.targetPosition.clone().sub(entity.root.position);
        toTgt.y = 0;
        const dist = toTgt.length();
        const step = Math.max(0.2, entity.targetSpeed) * delta;
        entity.root.position.y = 0;
        if (dist > 0.0001) {
          if (step >= dist) {
            entity.root.position.copy(entity.targetPosition).setY(0);
          } else {
            entity.root.position.addScaledVector(toTgt.normalize(), step);
            entity.root.position.y = 0;
          }
        }

        // Smooth rotation
        entity.root.rotation.y = turnToward(entity.root.rotation.y, entity.targetYaw, 5.5 * delta);

        // Glow pulse
        (entity.glow.material as THREE.MeshBasicMaterial).opacity =
          0.5 + 0.22 * Math.sin(s.glowT * 2.8);

        // Trail
        entity.trail.points.unshift(entity.root.position.clone().setY(0.04));
        entity.trail.points.pop();
        entity.trail.line.geometry.setFromPoints(entity.trail.points);

        // Animation
        entity.mixer?.update(delta);
      }

      // Camera
      const camX = s.radius * Math.sin(s.phi) * Math.sin(s.theta);
      const camY = s.radius * Math.cos(s.phi);
      const camZ = s.radius * Math.sin(s.phi) * Math.cos(s.theta);
      s.camera.position.set(s.target.x + camX, s.target.y + camY, s.target.z + camZ);
      s.camera.lookAt(s.target);

      s.renderer!.render(s.scene, s.camera);
      gl.endFrameEXP(); // required by expo-gl

      // Update HUD labels (throttled)
      if (now - lastLabelUpdate.current > LABEL_UPDATE_INTERVAL_MS) {
        lastLabelUpdate.current = now;
        const { w: sw, h: sh } = sceneSizeRef.current;
        const next: LabelData[] = [];
        const actors = worldRef.current.actors ?? [];
        for (const entity of s.actorEntities.values()) {
          const actor = actors.find((a) => a.actorId === entity.actorId);
          const pos = entity.root.position.clone().add(new THREE.Vector3(0, 2.1, 0));
          const ndc = pos.project(s.camera);
          const x = (ndc.x * 0.5 + 0.5) * sw;
          const y = (-ndc.y * 0.5 + 0.5) * sh;
          const visible =
            ndc.z < 1 && ndc.x > -1.05 && ndc.x < 1.05 && ndc.y > -1.05 && ndc.y < 1.05;
          next.push({
            actorId: entity.actorId,
            name: actor?.name ?? entity.actorId,
            health: Math.max(0, Math.min(100, Number(actor?.health ?? 100))),
            chat: now < entity.chatExpiresAt ? entity.lastChat : undefined,
            chatExpiresAt: entity.chatExpiresAt,
            x,
            y,
            visible,
          });
        }
        setLabels(next);
      }
    };
    loop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Touch-based orbit controls ─────────────────────────────────────────────

  const lastTouch = useRef<{ x: number; y: number } | null>(null);
  const lastPinch = useRef<number | null>(null);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const t = e.nativeEvent.touches;
          if (t.length === 1) {
            lastTouch.current = { x: t[0].pageX, y: t[0].pageY };
            lastPinch.current = null;
          } else if (t.length === 2) {
            const dx = t[0].pageX - t[1].pageX;
            const dy = t[0].pageY - t[1].pageY;
            lastPinch.current = Math.sqrt(dx * dx + dy * dy);
            lastTouch.current = null;
          }
        },
        onPanResponderMove: (e) => {
          const s = sceneRef.current;
          const t = e.nativeEvent.touches;
          if (t.length === 1 && lastTouch.current) {
            s.theta -= (t[0].pageX - lastTouch.current.x) * 0.005;
            s.phi = Math.max(0.1, Math.min(Math.PI * 0.46, s.phi + (t[0].pageY - lastTouch.current.y) * 0.005));
            lastTouch.current = { x: t[0].pageX, y: t[0].pageY };
          } else if (t.length === 2 && lastPinch.current !== null) {
            const dx = t[0].pageX - t[1].pageX;
            const dy = t[0].pageY - t[1].pageY;
            const pinchDist = Math.sqrt(dx * dx + dy * dy);
            s.radius = Math.max(3, Math.min(30, s.radius + (lastPinch.current - pinchDist) * 0.06));
            lastPinch.current = pinchDist;
          }
        },
        onPanResponderRelease: () => {
          lastTouch.current = null;
          lastPinch.current = null;
        },
      }),
    []
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />

      {/* 3D Viewport */}
      <View
        style={styles.viewport}
        onLayout={(e) => {
          const { width: w, height: h } = e.nativeEvent.layout;
          sceneSizeRef.current = { w, h };
          setSceneSize({ w, h });
        }}
        {...panResponder.panHandlers}
      >
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />

        {/* Actor HUD labels */}
        {labels.map((label) =>
          label.visible ? (
            <View
              key={label.actorId}
              pointerEvents="none"
              style={[
                styles.labelWrap,
                { left: label.x - LABEL_WIDTH / 2, top: label.y - 110 },
              ]}
            >
              {label.chat ? (
                <View style={styles.chatBubble}>
                  <Text style={styles.chatBubbleText} numberOfLines={3}>
                    {label.chat}
                  </Text>
                </View>
              ) : null}
              <View style={styles.actorTag}>
                <Text style={styles.actorTagText}>{label.name}</Text>
              </View>
              <View style={styles.hpTrack}>
                <View
                  style={[
                    styles.hpFill,
                    {
                      width: `${label.health}%` as any,
                      backgroundColor:
                        label.health > 60 ? "#77ff9b" : label.health > 30 ? "#ffcf5a" : "#ff5f66",
                    },
                  ]}
                />
              </View>
              <Text style={styles.hpText}>{Math.round(label.health)} HP</Text>
            </View>
          ) : null
        )}

        {/* Viewport hint */}
        {!sessionId && (
          <View style={styles.hint} pointerEvents="none">
            <Text style={styles.hintText}>Connect to start the world</Text>
          </View>
        )}
      </View>

      {/* Control panel */}
      <View style={styles.panel}>
        {!sessionId ? (
          <>
            <TextInput
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              placeholder="http://your-server:8787"
              placeholderTextColor="#8d8f98"
            />
            <Pressable
              onPress={connectShared}
              disabled={connecting || !serverUrl.startsWith("http")}
              style={[styles.btn, (connecting || !serverUrl.startsWith("http")) && styles.btnDisabled]}
            >
              <Text style={styles.btnText}>{connecting ? "Connecting…" : "Connect to World"}</Text>
            </Pressable>
          </>
        ) : (
          <View style={styles.row}>
            <Pressable onPress={spawnActive} style={[styles.btn, styles.btnFlex]}>
              <Text style={styles.btnText}>Spawn</Text>
            </Pressable>
            <Pressable onPress={resetWorld} style={[styles.btn, styles.btnFlex, styles.btnSecondary]}>
              <Text style={styles.btnSecondaryText}>Reset World</Text>
            </Pressable>
            <Pressable onPress={disconnectSession} style={[styles.btn, styles.btnFlexSm, styles.btnSecondary]}>
              <Text style={styles.btnSecondaryText}>✕</Text>
            </Pressable>
          </View>
        )}
        {status ? <Text style={styles.statusText}>{status}</Text> : null}
        {sessionId ? (
          <Text style={styles.hintSmall}>Drag to orbit · Pinch to zoom</Text>
        ) : null}
      </View>

      {/* Chat log */}
      {chats.length > 0 && (
        <View style={styles.chatLog}>
          <Text style={styles.chatLogHeader}>Chat</Text>
          <FlatList
            data={chats}
            keyExtractor={(item, i) => `${item.at}-${i}`}
            renderItem={({ item }) => (
              <Text style={styles.chatLogRow} numberOfLines={1}>
                <Text style={styles.chatLogActor}>{item.actorId}: </Text>
                {item.text}
              </Text>
            )}
            style={{ maxHeight: 80 }}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#05070b" },
  viewport: { flex: 1, position: "relative", backgroundColor: "#091224" },

  // HUD
  labelWrap: {
    position: "absolute",
    width: LABEL_WIDTH,
    alignItems: "center",
  },
  chatBubble: {
    backgroundColor: "rgba(255, 254, 228, 0.95)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 3,
    maxWidth: LABEL_WIDTH,
    borderColor: "rgba(18, 36, 60, 0.28)",
    borderWidth: 1,
  },
  chatBubbleText: { color: "#12243c", fontSize: 11, lineHeight: 15 },
  actorTag: {
    backgroundColor: "rgba(0,0,0,0.58)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderColor: "rgba(148,213,255,0.45)",
    borderWidth: 1,
  },
  actorTagText: { color: "#e8f4ff", fontSize: 11, fontWeight: "600" },
  hpTrack: {
    width: 80,
    height: 6,
    backgroundColor: "rgba(11,22,38,0.84)",
    borderRadius: 999,
    marginTop: 3,
    overflow: "hidden",
    borderColor: "rgba(175,205,240,0.35)",
    borderWidth: 1,
  },
  hpFill: { height: "100%", borderRadius: 999 } as any,
  hpText: { color: "#dff1ff", fontSize: 9, marginTop: 2 },

  hint: {
    position: "absolute",
    bottom: 16,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.52)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  hintText: { color: "#9cadc9", fontSize: 13 },

  // Panel
  panel: {
    backgroundColor: "rgba(14,24,40,0.95)",
    borderTopColor: "#28456f",
    borderTopWidth: 1,
    padding: 12,
    gap: 8,
  },
  input: {
    backgroundColor: "#0c1a2e",
    borderColor: "#28456f",
    borderWidth: 1,
    borderRadius: 8,
    color: "#e5eeff",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  row: { flexDirection: "row", gap: 8 },
  btn: {
    backgroundColor: "#9fe870",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  btnFlex: { flex: 1 },
  btnFlexSm: { flex: 0, paddingHorizontal: 14 },
  btnDisabled: { opacity: 0.45 },
  btnSecondary: { backgroundColor: "#1e334f" },
  btnText: { color: "#07120a", fontWeight: "700", fontSize: 14 },
  btnSecondaryText: { color: "#e5eeff", fontWeight: "700", fontSize: 14 },
  statusText: { color: "#9dd2ff", fontSize: 12 },
  hintSmall: { color: "#4a6a90", fontSize: 11 },

  // Chat log
  chatLog: {
    backgroundColor: "rgba(9,18,36,0.97)",
    borderTopColor: "#1d3558",
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chatLogHeader: { color: "#62d8ff", fontSize: 11, fontWeight: "700", marginBottom: 4 },
  chatLogRow: { color: "#c8d8f0", fontSize: 11, lineHeight: 16 },
  chatLogActor: { color: "#62d8ff", fontWeight: "700" },
});


const SERVER_BASE_URL = "http://localhost:8787";

type Command = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [commands, setCommands] = useState<Command[]>([]);
  const [serverUrl, setServerUrl] = useState(SERVER_BASE_URL);
  const [loading, setLoading] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canStartSession = useMemo(
    () => !loading && !sessionId && serverUrl.startsWith("http"),
    [loading, sessionId, serverUrl],
  );

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
      }
    };
  }, []);

  const startSession = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${serverUrl}/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: "ios-sim" }),
      });
      const data = await response.json();
      setSessionId(data.sessionId);
      setCursor(0);
      setCommands([]);
      schedulePoll(data.sessionId, 0, 200);
    } finally {
      setLoading(false);
    }
  };

  const schedulePoll = (nextSessionId: string, since: number, delayMs: number) => {
    pollingRef.current = setTimeout(() => pollCommands(nextSessionId, since), delayMs);
  };

  const pollCommands = async (activeSessionId: string, since: number) => {
    try {
      const response = await fetch(
        `${serverUrl}/commands?sessionId=${activeSessionId}&since=${since}&timeout=5000`,
      );
      const data = await response.json();

      if (Array.isArray(data.commands) && data.commands.length > 0) {
        setCommands((current) => [...data.commands, ...current].slice(0, 30));
        setCursor(data.nextSince);
        for (const command of data.commands) {
          await fetch(`${serverUrl}/ack`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-session-id": activeSessionId,
            },
            body: JSON.stringify({ commandId: command.id, status: "ok" }),
          });
        }
        schedulePoll(activeSessionId, data.nextSince, 350);
      } else {
        setCursor(data.nextSince ?? since);
        schedulePoll(activeSessionId, data.nextSince ?? since, 800);
      }
    } catch {
      schedulePoll(activeSessionId, since, 1500);
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <Text style={styles.title}>ChaosLab AR Pilot (HTTP)</Text>
      <Text style={styles.subtitle}>Session + command polling scaffold for iOS AR app</Text>

      <TextInput
        value={serverUrl}
        onChangeText={setServerUrl}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        placeholder="https://your-orchestrator.example.com"
        placeholderTextColor="#8d8f98"
      />

      <Pressable disabled={!canStartSession} onPress={startSession} style={styles.button}>
        {loading ? <ActivityIndicator color="#05070b" /> : <Text style={styles.buttonText}>Start Session</Text>}
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.label}>Session ID</Text>
        <Text style={styles.value}>{sessionId ?? "Not started"}</Text>
        <Text style={styles.label}>Cursor</Text>
        <Text style={styles.value}>{cursor}</Text>
      </View>

      <Text style={styles.sectionTitle}>Latest Commands</Text>
      <FlatList
        data={commands}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <View style={styles.commandRow}>
            <Text style={styles.commandTitle}>#{item.id} {item.type}</Text>
            <Text style={styles.commandPayload}>{JSON.stringify(item.payload)}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No commands yet.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#05070b",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    color: "#eff2ff",
    fontSize: 22,
    fontWeight: "700",
  },
  subtitle: {
    color: "#98a2b3",
    marginTop: 4,
    marginBottom: 14,
  },
  input: {
    borderWidth: 1,
    borderColor: "#252a35",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#e4e6ee",
    marginBottom: 10,
  },
  button: {
    backgroundColor: "#9fe870",
    borderRadius: 10,
    height: 46,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 14,
  },
  buttonText: {
    color: "#05070b",
    fontWeight: "700",
  },
  card: {
    backgroundColor: "#0f1219",
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  label: {
    color: "#98a2b3",
    fontSize: 12,
    marginTop: 2,
  },
  value: {
    color: "#e4e6ee",
    fontSize: 13,
  },
  sectionTitle: {
    color: "#eff2ff",
    fontWeight: "600",
    marginBottom: 8,
  },
  commandRow: {
    backgroundColor: "#0f1219",
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  commandTitle: {
    color: "#9fe870",
    fontWeight: "600",
  },
  commandPayload: {
    color: "#c0c5d3",
    fontSize: 12,
    marginTop: 4,
  },
  empty: {
    color: "#98a2b3",
    textAlign: "center",
    marginTop: 16,
  },
});
