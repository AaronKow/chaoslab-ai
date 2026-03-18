# ChaosLab Mobile Expo — iOS/Android 3D World

A fully-featured **React Native + Three.js** 3D world viewer for ChaosLab. Connect your iPhone or Android phone to the orchestrator server and watch actors spawn, move, fight, and chat in a shared 3D world — in real-time.

## Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| **Expo** | 55.0.7 | React Native framework + build tooling |
| **React** | 19.2.4 | UI component framework |
| **React Native** | 0.84.1 | Native runtime (iOS/Android) |
| **Three.js** | 0.183.2 | WebGL 3D rendering library |
| **expo-gl** | 55.0.10 | Low-level WebGL context for React Native |
| **TypeScript** | 5.8.3 | Type safety |

## Features

✅ **Full 3D World Sync** — Real-time polling from orchestrator  
✅ **Actor Rendering** — GLB models with skeleton animation  
✅ **Smooth Movement** — Interpolated position + rotation  
✅ **Health HUD** — Floating labels above each actor  
✅ **Chat Bubbles** — See characters speak in real-time  
✅ **Touch Orbit Camera** — Single-finger drag to rotate, pinch to zoom  
✅ **Combat VFX** — Damage popups, glow rings, movement trails  
✅ **Dark Theme** — Beautiful deep blue UI matching web runtime  

---

## Development Setup

### Prerequisites

- **Node.js** 20+ (LTS)
- **pnpm** 10+
- **Xcode** 15+ (for iOS)
- **Android Studio** (for Android)
- **iPhone/Android device** or simulator

### Install Dependencies

```bash
cd apps/mobile-expo
pnpm install
```

This installs:
- `expo-gl` — WebGL context for React Native
- `three` + `three-stdlib` — 3D rendering + utilities
- TypeScript types for Three.js

### Start Development Server

```bash
pnpm start
```

Output:
```
✓ Expo server running on http://192.168.1.50:8081
To open the app, scan the QR code OR:
  • Press 'i' to open iOS Simulator
  • Press 'a' to open Android Emulator
  • Press 'w' to open web preview
```

---

## Connecting iPhone (Fastest)

### Via Expo Go App

This is the quickest way to test on your physical iPhone:

1. **Install Expo Go** from App Store (free)
2. **In Terminal**, ensure you see:
   ```
   ✓ Expo server running on http://192.168.1.50:8081
   ```
3. **Open Expo Go → Tap camera icon → Scan QR code from terminal**

You should see the app load in seconds.

4. **Enter your orchestrator server URL**:
   - On your Mac: `ifconfig | grep "inet " | grep -v 127`
   - Example: `http://192.168.1.50:8787`
   - Tap **Connect to World**

5. **Interact**:
   - **Spawn** — place active character
   - **Reset World** — clear all actors
   - **Drag** — orbit camera
   - **Pinch** — zoom in/out

### Via Native Build (Production)

To build a standalone native app:

```bash
pnpm run ios
```

Xcode will open. When it finishes building, the app installs on your iPhone.

**For Android**:
```bash
pnpm run android
```

---

## Tech Highlights

### GLView + WebGL Context

The 3D viewport is powered by **expo-gl**:

```typescript
<GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
```

When the GL context is created, we:
1. Initialize a Three.js WebGLRenderer using the Expo GL context
2. Create a scene with lighting, fog, grid
3. Start a render loop that updates each frame

### Three.js Model Loading

Models are fetched from the orchestrator (`/assets/models/*.glb`):

```typescript
const loader = new GLTFLoader();
loader.load(url, (gltf) => {
  const model = SkeletonUtils.clone(gltf.scene); // deep clone for animations
  const mixer = new THREE.AnimationMixer(model);
  // animate...
});
```

**Key detail**: We use `SkeletonUtils.clone()` so each actor gets its own animation state (no conflict between actors).

### Smooth Camera Orbit

Touch inputs control camera position around a target:

```typescript
// Single finger: drag to rotate
// Two fingers: pinch to zoom
const camX = radius * sin(phi) * sin(theta);
const camY = radius * cos(phi);
const camZ = radius * sin(phi) * cos(theta);
camera.position.set(target.x + camX, target.y + camY, target.z + camZ);
```

### HUD Projection

Actor labels, health bars, and chat bubbles are rendered in **React Native** but positioned in **3D space**:

```typescript
const ndc = worldPos.project(camera); // project to NDC
const screenX = (ndc.x * 0.5 + 0.5) * screenWidth;
const screenY = (-ndc.y * 0.5 + 0.5) * screenHeight;
```

This gives the illusion of floating UI over the 3D world.

---

## File Structure

```
apps/mobile-expo/
├── App.tsx                 # Main React Native component (1000+ lines)
├── app.json               # Expo config (SDK version, iOS bundle ID, etc.)
├── package.json           # Dependencies (latest stable versions)
├── tsconfig.json          # TypeScript configuration
├── metro.config.js        # Metro bundler config (enables ESM exports)
└── README.md              # This file
```

### App.tsx Sections

1. **Types** — `Actor`, `WorldState`, `ActorEntity`, `SceneRef`
2. **Clip Matching** — Fuzzy animation clip selection (matches server)
3. **Scene Initialization** — Three.js scene, camera, lighting, ground
4. **World Polling** — Fetch `/api/world` every 350ms
5. **Actor Sync** — Create/update/remove actor Three.js objects
6. **Touch Handling** — PanResponder for camera orbit + pinch zoom
7. **Render Loop** — requestAnimationFrame with smooth interpolation
8. **UI** — GLView + FlatList for chat log + control panel

---

## Runtime Guide

### First Launch

1. **Connect to World** — Tap and enter orchestrator URL (e.g., `http://192.168.1.50:8787`)
2. **Spawn** — Places the active character (set in `/ui/models`) at a random position
3. **Observe** — See real-time sync with web runtime and other clients

### What You See

- **Ground + Grid** — Dark blue arena
- **Glow Rings** — Around each actor (pulsing)
- **Movement Trails** — 18-point line history
- **Labels** — Actor name and health bar
- **Chat Bubbles** — Yellow floating text (expires after 3.6s)
- **Damage Popups** — Yellow "-15" numbers floating up

### Camera Controls

| Gesture | Action |
|---|---|
| Drag (1 finger) | Rotate around target |
| Pinch (2 fingers) | Zoom in/out |
| (none) | Auto-orbit disabled (manual only) |

---

## Debugging

### View Logs

```bash
# In another terminal, watch all Expo logs
expo logs --local
```

### Common Issues

**App crashes on startup**
- Check metro.config.js has `unstable_enablePackageExports: true`
- Restart dev server: `pnpm start`

**Models not loading**
- Ensure orchestrator is running and has models uploaded
- Check `/api/models` in browser to confirm files exist

**Performance is slow**
- Reduce actor count (spawn fewer characters)
- Lower camera resolution (edit renderer.setPixelRatio)
- Close other apps on phone

**Touch camera doesn't respond**
- Ensure GLView has `{...panResponder.panHandlers}`
- Try restarting the app

---

## Performance Tips

1. **Model Count**: Each actor loads a GLB and runs an animation mixer. Keep < 20 actors for 60fps on iPhone 13+.
2. **Animation Clips**: Fuzzy matching searches all clips each frame. Pre-filter if needed.
3. **Label Updates**: HUD labels are throttled to every 80ms.
4. **Polling**: World state fetches every 350ms; increase if server is slow.

---

## Next Steps

- **AR Integration**: Replace `expo-gl` GLView with `expo-camera` + ARKit/ARCore
- **Touch Gestures**: Add double-tap to focus on nearest actor
- **Persistent Settings**: Store server URL in AsyncStorage
- **Multiplayer UI**: Show all connected clients' cameras
- **Command Input**: Add on-screen buttons to send move_to/say/attack

---

## References

- [Expo GL Documentation](https://docs.expo.dev/versions/latest/sdk/gl-view/)
- [Three.js Manual](https://threejs.org/manual/)
- [React Native Docs](https://reactnative.dev/)
- [ChaosLab Main README](../../README.md)
- [Orchestrator MCP Instructions](.../../.github/copilot-instructions.md)
