import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../store';
import { createStarfield } from '../utils/starfield.ts';
import {
  AU_SCALED,
  EARTH_RADIUS_SCALED,
  SUN_RADIUS_SCALED,
  createOrbitLine,
  toScaledVector,
  generateEarthOrbit,
  getEarthPosition,
} from '../utils/orbitalMechanics';
import type { TrajectoryPoint } from '../types';
import { analyzeOrbit } from '../utils/orbitDiagnostics';
import { loadAsteroidModel } from '../utils/asteroidModel';

const ASTEROID_ANIMATION_DURATION_MS = 15000;
const EARTH_ANIMATION_DURATION_MS = 15000;
const IDLE_TIME_ACCELERATION = 24 * 3600; // one day of simulated time per rendered second
// (Removed unused rotation axis/quaternion constants after refactor)
const TEMP_ASTEROID_VECTOR = new THREE.Vector3();
const TEMP_EARTH_VECTOR = new THREE.Vector3();
const TEMP_CAMERA_VECTOR = new THREE.Vector3();
const TEMP_LABEL_VECTOR = new THREE.Vector3();
const TEMP_LABEL_TARGET_VECTOR = new THREE.Vector3();

interface LabelMetadata { screenHeightFraction: number; aspectRatio: number; }

function createLabelBillboard(
  text: string,
  color: string,
  screenHeightFraction: number,
  explicitAspectRatio?: number,
  fontScale: number = 1.0,
) {
  const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const scale = Math.min(devicePixelRatio, 3);
  // Measure text first using a temp canvas
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) throw new Error('Could not get measure context');
  const baseFontSize = 220 * fontScale; // high logical px for sharpness, scaled
  measureCtx.font = `${baseFontSize}px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
  const metrics = measureCtx.measureText(text);
  const rawWidth = metrics.width;
  const ascent = metrics.actualBoundingBoxAscent || baseFontSize * 0.8;
  const descent = metrics.actualBoundingBoxDescent || baseFontSize * 0.2;
  const rawHeight = ascent + descent;
  // Padding
  const padX = baseFontSize * 0.25;
  const padY = baseFontSize * 0.25;
  const logicalWidth = Math.ceil(rawWidth + padX * 2);
  const logicalHeight = Math.ceil(rawHeight + padY * 2);
  // Round to power-of-two for better mip behavior (cap at 2048)
  const pow2 = (v: number) => Math.pow(2, Math.min(11, Math.ceil(Math.log2(Math.max(64, v)))));
  const potW = pow2(logicalWidth);
  const potH = pow2(logicalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = potW * scale;
  canvas.height = potH * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get label context');
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, potW, potH);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${baseFontSize}px 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
  // Background subtle glow for contrast
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  const bgRadius = 18;
  const cx = potW / 2; const cy = potH / 2;
  const rectW = rawWidth + padX * 2; const rectH = rawHeight + padY * 2;
  ctx.beginPath();
  ctx.roundRect(cx - rectW / 2, cy - rectH / 2, rectW, rectH, bgRadius);
  ctx.fill();
  // Text
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy + (descent - rawHeight/2) * 0.15); // slight vertical optical tweak

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  texture.needsUpdate = true;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 0.98,
    side: THREE.DoubleSide,
    alphaTest: 0.02,
  });
  const aspect = explicitAspectRatio ?? (rectW / rectH);
  const geometry = new THREE.PlaneGeometry(1, 1); // square; we scale both axes from metadata
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  const metadata: LabelMetadata = { screenHeightFraction: screenHeightFraction, aspectRatio: aspect };
  mesh.userData.label = metadata;
  return mesh;
}

interface LabelEntry {
  mesh: THREE.Mesh;
  targetRef: MutableRefObject<THREE.Object3D | null>;
  offset: THREE.Vector3;
  connector: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  connectorPositions: Float32Array;
  role: 'sun' | 'earth' | 'asteroidOrbit' | 'earthOrbit';
}

function createLabelConnector(color: number, opacity = 0.6) {
  const positions = new Float32Array(6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    linewidth: 4,
    depthTest: true,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  return { line, positions };
}


interface TimelinePoint {
  t: number;
  position: THREE.Vector3;
  timestamp: number;
}

interface TimelineSample {
  position: THREE.Vector3;
  timestamp: number;
}

interface TimelineAnimation {
  timeline: TimelinePoint[];
  durationMs: number;
}

function buildTimeline(points: TrajectoryPoint[]): TimelinePoint[] {
  if (points.length === 0) {
    return [];
  }

  const timestamps = points.map((point, index) => point.timestamp ?? index);
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  const span = last !== first ? last - first : points.length > 1 ? points.length - 1 : 1;

  return points.map((point, index) => {
    const normalized = span !== 0 ? (timestamps[index] - first) / span : 0;
    return {
      t: index === points.length - 1 ? 1 : Math.min(Math.max(normalized, 0), 1),
      position: toScaledVector(point.position),
      timestamp: timestamps[index],
    };
  });
}

function sampleTimeline(
  timeline: TimelinePoint[],
  progress: number,
  target: THREE.Vector3,
): TimelineSample | null {
  if (!timeline.length) return null;
  const clamped = Math.min(Math.max(progress, 0), 1);
  // Binary search by physical time fraction 't'
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timeline[mid].t < clamped) lo = mid + 1; else hi = mid;
  }
  const upperIndex = lo;
  const lowerIndex = Math.max(0, upperIndex - 1);
  const a = timeline[lowerIndex];
  const b = timeline[upperIndex];
  if (!a || !b) return null;
  const span = b.t - a.t || 1;
  const localT = span > 0 ? (clamped - a.t) / span : 0;
  target.lerpVectors(a.position, b.position, localT);
  const ts = a.timestamp + (b.timestamp - a.timestamp) * localT;
  return { position: target, timestamp: ts };
}
// ------------------------------------------------------------
// Scene Component (wrapped so hooks are valid)
// ------------------------------------------------------------
export function Scene() {
  const earthLabelEntryRef = useRef<LabelEntry | null>(null);

  const asteroidAnimationRef = useRef<TimelineAnimation | null>(null);
  const earthAnimationRef = useRef<TimelineAnimation | null>(null);
  const playbackDurationRef = useRef<number>(ASTEROID_ANIMATION_DURATION_MS);
  const playbackProgressRef = useRef<number>(0);
  const isPlaybackPlayingRef = useRef<boolean>(false);
  const lastFrameTimeRef = useRef<number>(0);
  // Global timestamp sync refs
  const globalStartTsRef = useRef<number | null>(null);
  const globalEndTsRef = useRef<number | null>(null);
  const globalSpanRef = useRef<number>(1);
  // Camera roll state (to flatten orbit visually without altering physics)
  const cameraRollAppliedRef = useRef<boolean>(false);

  // MISSING REFS (restored)
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const asteroidMeshRef = useRef<THREE.Mesh | null>(null);
  const earthMeshRef = useRef<THREE.Mesh | null>(null);
  const earthLabelRef = useRef<THREE.Mesh | null>(null);
  const earthLabelCurrentTextRef = useRef<string>('Earth');
  const earthInitialPositionRef = useRef<THREE.Vector3 | null>(null);
  const idleSimulationTimeRef = useRef<number>(0); // seconds accumulator for idle rotation
  const cameraFocusRef = useRef<'sun' | 'earth' | 'asteroid'>('sun');
  // Additional refs (restored)
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const starFieldRef = useRef<THREE.Points | null>(null);
  const sunMeshRef = useRef<THREE.Mesh | null>(null);
  const sunLabelRef = useRef<THREE.Mesh | null>(null);
  const sunLabelEntryRef = useRef<LabelEntry | null>(null);
  const earthOrbitLineRef = useRef<THREE.Line | null>(null);
  const asteroidOrbitLineRef = useRef<THREE.Line | null>(null);
  const asteroidDebugPointsRef = useRef<THREE.Points | null>(null); // will be disabled after confirmation
  const asteroidRawDebugRef = useRef<THREE.Line | null>(null); // removed after normalization removal
  const asteroidOrbitLabelRef = useRef<THREE.Mesh | null>(null);
  const asteroidOrbitLabelConnectorRef = useRef<THREE.Line | null>(null);
  const asteroidOrbitLabelPositionsRef = useRef<Float32Array | null>(null);
  const asteroidHighlightGroupRef = useRef<THREE.Group | null>(null);
  const earthOrbitLabelRef = useRef<THREE.Mesh | null>(null);
  const earthOrbitLabelConnectorRef = useRef<THREE.Line | null>(null);
  const earthOrbitLabelPositionsRef = useRef<Float32Array | null>(null);
  // Toggle to enable verbose orbit diagnostics & trajectory logging
  const ORBIT_DEBUG = false;
  const previewAutoFramedRef = useRef<boolean>(false);
  const previewModeActiveRef = useRef<boolean>(false);
  const labelEntriesRef = useRef<LabelEntry[]>([]);
  const earthFocusOffsetRef = useRef<THREE.Vector3 | null>(null);
  const simulationModeRef = useRef<'preview' | 'full' | null>(null);
  const simulationDataRef = useRef<typeof simulationData | null>(null);

  // Apply axial tilt + spin using backend spin metadata (if present)
  function updateEarthOrientationForTime(mesh: THREE.Mesh | null, absoluteTime?: number) {
    if (!mesh) return;
    const data = simulationDataRef.current;
    const spin = data?.earth_orbit?.spin;
    if (!spin) return; // nothing to do yet
    const epoch = data?.epoch ?? 0;
    const t = (absoluteTime ?? epoch) - epoch;
    const obliquity = THREE.MathUtils.degToRad(spin.obliquity_deg);
    const rotationPeriod = spin.rotation_period_s || 86164.0905;
    const theta = spin.prime_meridian_rad_at_epoch + (2*Math.PI * (t / rotationPeriod));
    const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), obliquity);
    const qSpin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), theta % (Math.PI*2));
    mesh.quaternion.copy(qSpin).premultiply(qTilt);
  }

  const simulationData = useStore((state) => state.simulationData);
  const simulationMode = useStore((state) => state.simulationMode);
  const cameraFocus = useStore((state) => state.cameraFocus);
  const playbackProgress = useStore((state) => state.playbackProgress);
  const isPlaybackPlaying = useStore((state) => state.isPlaybackPlaying);
  const setPlaybackProgress = useStore((state) => state.setPlaybackProgress);
  const setIsPlaybackPlaying = useStore((state) => state.setIsPlaybackPlaying);
  const setSimulationData = useStore((state) => state.setSimulationData);
  const setSimulationMode = useStore((state) => state.setSimulationMode);

  // keep a ref to latest simulationData for animation loop without re-render churn
  useEffect(() => {
    simulationDataRef.current = simulationData;
  }, [simulationData]);

  // Load asteroid model asynchronously when a full simulation is ready (or preview) and id present
  useEffect(() => {
    let cancelled = false;
    async function loadModel() {
      if (!simulationData || !asteroidMeshRef.current) return;
      // Always use a single generic model for all asteroids (user request)
      const id = 'generic';
      try {
        const model = await loadAsteroidModel(id, { scale: 1, fallbackSphere: false });
        if (cancelled) return;
        // Replace existing asteroid mesh geometry/material with loaded model as child
        const parent = asteroidMeshRef.current;
        // Clear previous children (except we keep reference to mesh for positioning)
        while (parent.children.length) parent.remove(parent.children[0]);
        model.position.set(0,0,0);
        parent.add(model);
      } catch {
        // Ignore; fallback sphere already in place
      }
    }
    loadModel();
    return () => { cancelled = true; };
  }, [simulationData]);

  const applyPlaybackProgressValue = useCallback((progress: number) => {
    // Both bodies sampled by normalized progress using backend timestamps for correct Keplerian motion
    const p = Math.min(Math.max(progress, 0), 1);
    if (asteroidAnimationRef.current && asteroidMeshRef.current) {
      const rs = sampleTimeline(asteroidAnimationRef.current.timeline, p, TEMP_ASTEROID_VECTOR);
      if (rs) {
        asteroidMeshRef.current.visible = true;
        asteroidMeshRef.current.position.copy(rs.position);
      }
    } else if (asteroidMeshRef.current) {
      asteroidMeshRef.current.visible = false;
    }
    if (earthAnimationRef.current && earthMeshRef.current) {
      const rs = sampleTimeline(earthAnimationRef.current.timeline, p, TEMP_EARTH_VECTOR);
      if (rs) {
        earthMeshRef.current.position.copy(rs.position);
        updateEarthOrientationForTime(earthMeshRef.current);
      }
    } else if (earthMeshRef.current && earthInitialPositionRef.current) {
      earthMeshRef.current.position.copy(earthInitialPositionRef.current);
      updateEarthOrientationForTime(earthMeshRef.current);
    }
  }, []);

  useEffect(() => {
    playbackProgressRef.current = playbackProgress;
    if (asteroidAnimationRef.current || earthAnimationRef.current) {
      applyPlaybackProgressValue(playbackProgress);
    }
  }, [playbackProgress, applyPlaybackProgressValue]);

  useEffect(() => {
    isPlaybackPlayingRef.current = isPlaybackPlaying;
  }, [isPlaybackPlaying]);

  // Track simulationMode for animation loop (which is created once)
  useEffect(() => {
    simulationModeRef.current = simulationMode as 'preview' | 'full' | null;
    if (simulationMode !== 'preview') {
      // Leaving preview: reset flag so Earth label becomes eligible to show again
      previewModeActiveRef.current = false;
    }
  }, [simulationMode]);

  useEffect(() => {
    if (!canvasRef.current) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      Math.max(EARTH_RADIUS_SCALED * 0.05, 0.01),
      AU_SCALED * 300,
    );
    // Slightly more "edge-on" initial viewpoint so orbit looks more horizontal than vertical
    camera.position.set(AU_SCALED * 2.2, AU_SCALED * 0.35, AU_SCALED * 2.8);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.045;
    controls.minDistance = EARTH_RADIUS_SCALED * 6;
    controls.maxDistance = AU_SCALED * 12;
    controlsRef.current = controls;

    const starField = createStarfield({
      radius: AU_SCALED * 28,
      count: 5200,
      size: Math.max(EARTH_RADIUS_SCALED * 12, 1.4),
    });
    scene.add(starField);
    starFieldRef.current = starField;

    const sunGeometry = new THREE.SphereGeometry(SUN_RADIUS_SCALED, 96, 96);
    const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xfdb813 });
    const sunMesh = new THREE.Mesh(sunGeometry, sunMaterial);
    scene.add(sunMesh);
    sunMeshRef.current = sunMesh;

  const sunLabel = createLabelBillboard('Sun', '#ffffff', 0.075, undefined, 0.85);
    const sunLabelOffset = new THREE.Vector3(
      AU_SCALED * 0.14,
      AU_SCALED * 0.08,
      AU_SCALED * -0.12,
    );
    const { line: sunConnector, positions: sunConnectorPositions } = createLabelConnector(
      0xf8f1e0,
      0.55,
    );
    sunLabel.position.copy(sunMesh.position).add(sunLabelOffset);
    sunConnectorPositions[0] = sunMesh.position.x;
    sunConnectorPositions[1] = sunMesh.position.y;
    sunConnectorPositions[2] = sunMesh.position.z;
    sunConnectorPositions[3] = sunLabel.position.x;
    sunConnectorPositions[4] = sunLabel.position.y;
    sunConnectorPositions[5] = sunLabel.position.z;
    sunConnector.geometry.attributes.position.needsUpdate = true;
    scene.add(sunLabel);
    scene.add(sunConnector);
    sunLabelRef.current = sunLabel;
    const sunEntry: LabelEntry = {
      mesh: sunLabel,
      targetRef: sunMeshRef,
      offset: sunLabelOffset,
      connector: sunConnector,
      connectorPositions: sunConnectorPositions,
      role: 'sun',
    };
    labelEntriesRef.current.push(sunEntry);
    sunLabelEntryRef.current = sunEntry;

    const glowGeometry = new THREE.SphereGeometry(SUN_RADIUS_SCALED * 1.1, 64, 64);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffaa00,
      transparent: true,
      opacity: 0.25,
    });
    const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    scene.add(glowMesh);

    const sunLight = new THREE.PointLight(0xffffff, 2.5, 0);
    scene.add(sunLight);

    const ambientLight = new THREE.AmbientLight(0x40485a, 0.9);
    scene.add(ambientLight);

    const fillLight = new THREE.DirectionalLight(0x8dafff, 0.45);
    fillLight.position.set(AU_SCALED * 3, AU_SCALED * 1.2, AU_SCALED * 1.5);
    scene.add(fillLight);

  // show earth orbit right away, backend updates later
  const earthOrbitPoints_fallback = generateEarthOrbit();
  const earthOrbitLine = createOrbitLine(earthOrbitPoints_fallback, 0x82beff);
    scene.add(earthOrbitLine);
  earthOrbitLineRef.current = earthOrbitLine;
  earthOrbitLine.visible = true;

    const earthGeometry = new THREE.SphereGeometry(EARTH_RADIUS_SCALED, 96, 96);
    const earthMaterial = new THREE.MeshPhongMaterial({
      color: 0xeaf4ff,
      emissive: 0x1b2d4f,
      emissiveIntensity: 0.45,
      specular: 0x4a8fd7,
      shininess: 36,
      transparent: false,
      opacity: 1,
    });
  const earthMesh = new THREE.Mesh(earthGeometry, earthMaterial);
  earthInitialPositionRef.current = new THREE.Vector3();
  earthInitialPositionRef.current = earthOrbitPoints_fallback[0]?.clone() ?? new THREE.Vector3();
  earthMesh.position.copy(earthInitialPositionRef.current);
  // Apply initial idle orbital phase offset so Earth not always at same starting sample
  idleSimulationTimeRef.current = 0; // idle unused now
  updateEarthOrientationForTime(earthMesh, 0);
    scene.add(earthMesh);
    earthMeshRef.current = earthMesh;

  const earthLabel = createLabelBillboard('Earth', '#ffffff', 0.055, undefined, 0.72);
    const earthLabelOffset = new THREE.Vector3(
      AU_SCALED * 0.22,
      AU_SCALED * 0.12,
      AU_SCALED * -0.18,
    );
    const { line: earthConnector, positions: earthConnectorPositions } = createLabelConnector(
      0xdbe9ff,
      0.5,
    );
  earthLabel.position.copy(earthMesh.position).add(earthLabelOffset);
  earthConnectorPositions[0] = earthMesh.position.x;
  earthConnectorPositions[1] = earthMesh.position.y;
  earthConnectorPositions[2] = earthMesh.position.z;
  earthConnectorPositions[3] = earthLabel.position.x;
  earthConnectorPositions[4] = earthLabel.position.y;
  earthConnectorPositions[5] = earthLabel.position.z;
  earthConnector.geometry.attributes.position.needsUpdate = true;
  (earthLabel.material as THREE.MeshBasicMaterial).opacity = 0.92;
    scene.add(earthLabel);
    scene.add(earthConnector);
    earthLabelRef.current = earthLabel;
    const earthEntry: LabelEntry = {
      mesh: earthLabel,
      targetRef: earthMeshRef,
      offset: earthLabelOffset,
      connector: earthConnector,
      connectorPositions: earthConnectorPositions,
      role: 'earth',
    };
    labelEntriesRef.current.push(earthEntry);
    earthLabelEntryRef.current = earthEntry;

    const textureLoader = new THREE.TextureLoader();
    const earthTexturePath = '/textures/earth_daymap.jpg';
    textureLoader.load(
      earthTexturePath,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        earthMaterial.map = texture;
        earthMaterial.needsUpdate = true;
      },
      undefined,
      () => {
        console.warn(`Earth texture not found at ${earthTexturePath}. Add a daymap texture for the planet.`);
      },
    );

    const handleResize = () => {
      if (!cameraRef.current || !rendererRef.current) return;
      const width = window.innerWidth;
      const height = window.innerHeight;
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);

    const handleKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'o') {
        if (asteroidOrbitLineRef.current && simulationData?.orbit_meta) {
          const geom = asteroidOrbitLineRef.current.geometry as THREE.BufferGeometry;
          const pos = geom.getAttribute('position') as THREE.BufferAttribute;
          const pts: THREE.Vector3[] = [];
          for (let i=0;i<pos.count;i++) {
            pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
          }
          const result = analyzeOrbit(pts, simulationData.orbit_meta ?? undefined);
          if (result) {
            console.group('[Asteroid Orbit Diagnostics – press O again to refresh]');
            console.log('Samples:', result.sampleCount);
            console.log('Derived:', result.derived);
            console.log('Meta:', simulationData.orbit_meta);
            console.log('Deltas (abs):', result.deltas);
            console.log('Percent errors:', result.percent);
            console.log('Radial min/max AU:', { q_est: result.rMinAU, Q_est: result.rMaxAU });
            console.groupEnd();
          } else {
            console.warn('[orbit] Not enough points for diagnostics');
          }
        } else {
          console.warn('[orbit] No asteroid orbit line or meta to analyze');
        }
      }
    };
    window.addEventListener('keydown', handleKey);

    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);

      const now = performance.now();
      if (lastFrameTimeRef.current === 0) {
        lastFrameTimeRef.current = now;
      }
      const deltaMs = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;

      if (isPlaybackPlayingRef.current) {
        const duration = playbackDurationRef.current || ASTEROID_ANIMATION_DURATION_MS;
        if (duration > 0) {
          const increment = deltaMs / duration;
          if (increment > 0) {
            const nextProgress = Math.min(playbackProgressRef.current + increment, 1);
            if (nextProgress !== playbackProgressRef.current) {
              playbackProgressRef.current = nextProgress;
              setPlaybackProgress(nextProgress);
            }
            if (nextProgress >= 1) {
              // Auto-loop: rewind and keep playing
              playbackProgressRef.current = 0;
              setPlaybackProgress(0);
              // continue playing (do not flip isPlaybackPlayingRef)
            }
          }
        }
      }

      if (earthAnimationRef.current || asteroidAnimationRef.current) {
        applyPlaybackProgressValue(playbackProgressRef.current);
      } else if (earthMeshRef.current && idleSimulationTimeRef.current >= 0) {
        // No active animated timelines: provide smooth analytic idle drift for Earth.
        const deltaSeconds = deltaMs / 1000;
        const acceleratedDelta = deltaSeconds * IDLE_TIME_ACCELERATION;
        idleSimulationTimeRef.current += acceleratedDelta;
        if (simulationModeRef.current === 'full' && simulationDataRef.current?.earth_trajectory?.length) {
          // If full sim data exists, still gently advance analytically instead of freezing at first sample
          const idlePos = getEarthPosition(idleSimulationTimeRef.current);
          earthMeshRef.current.position.copy(idlePos);
        } else {
          // Pure preview / no backend trajectory: analytic ellipse position
            const idlePos = getEarthPosition(idleSimulationTimeRef.current);
            earthMeshRef.current.position.copy(idlePos);
        }
        earthMeshRef.current.visible = true;
        updateEarthOrientationForTime(earthMeshRef.current);
      }

      if (controlsRef.current) {
        const controls = controlsRef.current;
        if (cameraFocusRef.current === 'earth' && earthMeshRef.current) {
          const earthPos = earthMeshRef.current.position;
          TEMP_CAMERA_VECTOR.copy(earthPos).sub(controls.target);
          controls.target.copy(earthPos);
          if (cameraRef.current) {
            cameraRef.current.position.add(TEMP_CAMERA_VECTOR);
            if (!earthFocusOffsetRef.current) {
              earthFocusOffsetRef.current = new THREE.Vector3();
            }
            earthFocusOffsetRef.current.copy(cameraRef.current.position).sub(earthPos);
          }
        } else if (cameraFocusRef.current === 'asteroid' && asteroidMeshRef.current) {
          const aPos = asteroidMeshRef.current.position;
          TEMP_CAMERA_VECTOR.copy(aPos).sub(controls.target);
          controls.target.copy(aPos);
          if (cameraRef.current) {
            cameraRef.current.position.add(TEMP_CAMERA_VECTOR);
          }
        }
      }

        // Asteroid highlight distance-adaptive (moderate pulsing ring + soft inner disk)
        // Recreate highlight if somehow purged mid-session in full sim
        if (!asteroidHighlightGroupRef.current && simulationModeRef.current === 'full' && asteroidMeshRef.current && sceneRef.current) {
          const g = new THREE.Group();
          const ringGeom = new THREE.RingGeometry(1.2, 2.0, 64); // slightly smaller than previous 1.4/2.3
          const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite:false });
          const ring = new THREE.Mesh(ringGeom, ringMat); ring.rotation.x = Math.PI/2; g.add(ring);
          const diskGeom = new THREE.CircleGeometry(1.1, 48); // reduced from 1.35
          const diskMat = new THREE.MeshBasicMaterial({ color: 0xffe89a, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite:false });
          const disk = new THREE.Mesh(diskGeom, diskMat); disk.rotation.x = Math.PI/2; g.add(disk);
          g.renderOrder = 1200; g.frustumCulled = false;
          asteroidHighlightGroupRef.current = g;
          sceneRef.current.add(g);
        }
        if (asteroidMeshRef.current && asteroidHighlightGroupRef.current && cameraRef.current) {
          asteroidHighlightGroupRef.current.position.copy(asteroidMeshRef.current.position);
          const camDist = cameraRef.current.position.distanceTo(asteroidMeshRef.current.position);
          const distanceScale = THREE.MathUtils.clamp(camDist * 0.022, 3.2, 520); // slightly smaller scaling
          asteroidHighlightGroupRef.current.scale.setScalar(distanceScale);
          const t = (performance.now() * 0.001) % 1;
          const phase = Math.sin(t * Math.PI * 2);
          const ring = asteroidHighlightGroupRef.current.children[0] as THREE.Mesh | undefined;
          const disk = asteroidHighlightGroupRef.current.children[1] as THREE.Mesh | undefined;
          if (ring) {
            const scaleMod = 1 + phase * 0.075; // slightly reduced pulse amplitude
            ring.scale.setScalar(scaleMod);
            const m = ring.material as THREE.MeshBasicMaterial;
            m.opacity = 0.4 + phase * 0.18; // toned down
          }
          if (disk) {
            const dm = disk.material as THREE.MeshBasicMaterial;
            dm.opacity = 0.12 + phase * 0.06;
            disk.scale.setScalar(1 + phase * 0.05);
          }
        }

      if (cameraRef.current) {
        const camera = cameraRef.current;
        const verticalFov = THREE.MathUtils.degToRad(camera.fov);
        labelEntriesRef.current.forEach((entry) => {
          const target = entry.targetRef.current;
          if (!target) return;
          target.getWorldPosition(TEMP_LABEL_TARGET_VECTOR);
          TEMP_LABEL_VECTOR.copy(TEMP_LABEL_TARGET_VECTOR).add(entry.offset);
          entry.mesh.position.copy(TEMP_LABEL_VECTOR);

          const meta = entry.mesh.userData.label as LabelMetadata | undefined;
          if (meta) {
            const distance = TEMP_LABEL_VECTOR.distanceTo(camera.position);
            const viewportHeight = 2 * Math.tan(verticalFov / 2) * distance;
            const desiredHeight = viewportHeight * meta.screenHeightFraction;
            const desiredWidth = desiredHeight * meta.aspectRatio;
            entry.mesh.scale.set(desiredWidth, desiredHeight, 1);
          }

          entry.mesh.quaternion.copy(camera.quaternion);

          const distanceToTarget = camera.position.distanceTo(TEMP_LABEL_TARGET_VECTOR);
          const isPreviewActive = previewModeActiveRef.current && simulationModeRef.current === 'preview';
          const forceHideEarthConnector = isPreviewActive && entry.role === 'earth';
          const hideConnectors = forceHideEarthConnector ||
            (cameraFocusRef.current === 'earth' && !(entry.role === 'asteroidOrbit' || entry.role === 'earthOrbit')) ||
            distanceToTarget < AU_SCALED * (entry.role === 'sun' ? 0.05 : 0.08);
          const hideLabel = (isPreviewActive && entry.role === 'earth') || (hideConnectors && entry.role === 'earth');

          entry.mesh.visible = !hideLabel;

          const positions = entry.connectorPositions;
          if (!hideConnectors) {
            positions[0] = TEMP_LABEL_TARGET_VECTOR.x;
            positions[1] = TEMP_LABEL_TARGET_VECTOR.y;
            positions[2] = TEMP_LABEL_TARGET_VECTOR.z;
            positions[3] = TEMP_LABEL_VECTOR.x;
            positions[4] = TEMP_LABEL_VECTOR.y;
            positions[5] = TEMP_LABEL_VECTOR.z;
            entry.connector.visible = true;
            entry.connector.geometry.attributes.position.needsUpdate = true;
          } else {
            entry.connector.visible = false;
          }
        });
      }

      controls.update();
      renderer.render(scene, camera);
    };

    lastFrameTimeRef.current = performance.now();
    animate();

    return () => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('keydown', handleKey);
      cancelAnimationFrame(animationId);

      controlsRef.current?.dispose();
      controlsRef.current = null;

      if (starFieldRef.current) {
        starFieldRef.current.geometry.dispose();
        const material = starFieldRef.current.material as THREE.PointsMaterial;
        material.map?.dispose();
        material.dispose();
        starFieldRef.current = null;
      }

      if (asteroidMeshRef.current) {
        scene.remove(asteroidMeshRef.current);
        asteroidMeshRef.current.geometry.dispose();
        (asteroidMeshRef.current.material as THREE.Material).dispose();
        asteroidMeshRef.current = null;
      }

      if (earthMeshRef.current) {
        scene.remove(earthMeshRef.current);
        earthMeshRef.current.geometry.dispose();
        const mat = earthMeshRef.current.material;
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else {
          mat.dispose();
        }
        earthMeshRef.current = null;
      }

      if (earthOrbitLineRef.current) {
        scene.remove(earthOrbitLineRef.current);
        earthOrbitLineRef.current.geometry.dispose();
        (earthOrbitLineRef.current.material as THREE.Material).dispose();
        earthOrbitLineRef.current = null;
      }

      labelEntriesRef.current.forEach((entry) => {
        if (entry.mesh.parent) {
          entry.mesh.parent.remove(entry.mesh);
        }
        entry.mesh.geometry.dispose();
        const meshMaterial = entry.mesh.material as THREE.MeshBasicMaterial;
        meshMaterial.map?.dispose();
        meshMaterial.dispose();

        if (entry.connector.parent) {
          entry.connector.parent.remove(entry.connector);
        }
        entry.connector.geometry.dispose();
        entry.connector.material.dispose();
      });
      labelEntriesRef.current = [];
      sunLabelRef.current = null;
      earthLabelRef.current = null;
      sunLabelEntryRef.current = null;
      earthLabelEntryRef.current = null;

      asteroidOrbitLineRef.current?.geometry.dispose();
      (asteroidOrbitLineRef.current?.material as THREE.Material | undefined)?.dispose();
      asteroidOrbitLineRef.current = null;

      asteroidAnimationRef.current = null;
      earthAnimationRef.current = null;

      renderer.dispose();
      rendererRef.current = null;

      scene.clear();
      sceneRef.current = null;
    };
  }, [applyPlaybackProgressValue, setIsPlaybackPlaying, setPlaybackProgress, simulationData]);

  useEffect(() => {
    if (!sceneRef.current) return;

    const ensureEarthLabelText = (desired: string) => {
      const mesh = earthLabelRef.current as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null;
      if (!mesh) return;
      if (earthLabelCurrentTextRef.current === desired) return;
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 512;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0,0,512,512);
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillRect(0,0,512,512);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = (desired.length > 5 ? '110px' : '140px') + ' "Segoe UI", sans-serif';
      ctx.fillText(desired, 256, 256);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mesh.material.map?.dispose();
      mesh.material.map = tex;
      mesh.material.needsUpdate = true;
      earthLabelCurrentTextRef.current = desired;
    };

    const scene = sceneRef.current;

    if (asteroidOrbitLineRef.current) {
      scene.remove(asteroidOrbitLineRef.current);
      asteroidOrbitLineRef.current.geometry.dispose();
      (asteroidOrbitLineRef.current.material as THREE.Material).dispose();
      asteroidOrbitLineRef.current = null;
    }
    [asteroidRawDebugRef, asteroidDebugPointsRef].forEach(ref => {
      if (ref.current) {
        scene.remove(ref.current);
        ref.current.geometry.dispose();
        (ref.current.material as THREE.Material).dispose();
        ref.current = null;
      }
    });
    if (asteroidOrbitLabelRef.current) {
      scene.remove(asteroidOrbitLabelRef.current);
      asteroidOrbitLabelRef.current.geometry.dispose();
      const mat = asteroidOrbitLabelRef.current.material as THREE.MeshBasicMaterial;
      mat.map?.dispose(); mat.dispose();
      asteroidOrbitLabelRef.current = null;
    }
    if (asteroidOrbitLabelConnectorRef.current) {
      scene.remove(asteroidOrbitLabelConnectorRef.current);
  const conn = asteroidOrbitLabelConnectorRef.current;
  asteroidOrbitLabelConnectorRef.current.geometry.dispose();
  (conn.material as THREE.LineBasicMaterial).dispose();
      asteroidOrbitLabelConnectorRef.current = null;
      asteroidOrbitLabelPositionsRef.current = null;
    }

    const ensureAsteroidMesh = () => {
      if (!asteroidMeshRef.current) {
        const geometry = new THREE.SphereGeometry(EARTH_RADIUS_SCALED * 0.3, 24, 24);
        const material = new THREE.MeshBasicMaterial({
          color: 0xffb27d,
        });
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        asteroidMeshRef.current = mesh;
      }
      asteroidMeshRef.current.visible = true;
      if (!scene.children.includes(asteroidMeshRef.current)) {
        scene.add(asteroidMeshRef.current);
      }
    };

    const resetPlayback = () => {
      if (playbackProgressRef.current !== 0) {
        playbackProgressRef.current = 0;
        setPlaybackProgress(0);
      }
      if (isPlaybackPlayingRef.current) {
        isPlaybackPlayingRef.current = false;
        setIsPlaybackPlaying(false);
      }
    };

    const updateEarthBasePosition = () => {
      if (!earthMeshRef.current) return;
      if (simulationData?.earth_trajectory.length) {
        const firstPoint = simulationData.earth_trajectory[0];
        const position = toScaledVector(firstPoint.position);
        earthMeshRef.current.position.copy(position);
  updateEarthOrientationForTime(earthMeshRef.current);
      } else if (earthInitialPositionRef.current) {
        earthMeshRef.current.position.copy(earthInitialPositionRef.current);
  updateEarthOrientationForTime(earthMeshRef.current);
      }
    };

    if (!simulationData) {
      console.log('No simulation data - clearing scene');
      asteroidAnimationRef.current = null;
      earthAnimationRef.current = null;
      playbackDurationRef.current = ASTEROID_ANIMATION_DURATION_MS;
      if (asteroidMeshRef.current) {
        asteroidMeshRef.current.visible = false;
      }
      if (earthMeshRef.current && earthInitialPositionRef.current) {
        earthMeshRef.current.visible = true; // Restore Earth visibility
        earthMeshRef.current.position.copy(earthInitialPositionRef.current);
  updateEarthOrientationForTime(earthMeshRef.current);
      }
      // Remove earthOrbit preview label if present
      if (earthOrbitLabelRef.current) {
        scene.remove(earthOrbitLabelRef.current);
        earthOrbitLabelRef.current.geometry.dispose();
        const m = earthOrbitLabelRef.current.material as THREE.MeshBasicMaterial; m.map?.dispose(); m.dispose();
        earthOrbitLabelRef.current = null;
      }
      if (earthOrbitLabelConnectorRef.current) {
        scene.remove(earthOrbitLabelConnectorRef.current);
        earthOrbitLabelConnectorRef.current.geometry.dispose();
        (earthOrbitLabelConnectorRef.current.material as THREE.LineBasicMaterial).dispose();
        earthOrbitLabelConnectorRef.current = null;
        earthOrbitLabelPositionsRef.current = null;
      }
      labelEntriesRef.current = labelEntriesRef.current.filter(e => e.role !== 'earthOrbit');
      // Restore Earth label visibility
      if (earthLabelEntryRef.current) {
        earthLabelEntryRef.current.mesh.visible = true;
        earthLabelEntryRef.current.connector.visible = true;
      }
      // Restore normal idle animation if coming from preview mode
      if (idleSimulationTimeRef.current < 0) {
        idleSimulationTimeRef.current = 0;
      }
      resetPlayback();
      return;
    }
    
    console.log('Simulation data received:', {
      mode: simulationMode,
      asteroidTrajectoryLength: simulationData?.asteroid_trajectory?.length,
      earthTrajectoryLength: simulationData?.earth_trajectory?.length
    });

    const runOrbitDiagnostics = (points: THREE.Vector3[]) => {
      if (!simulationData?.orbit_meta || points.length < 4) return;
      // Compute distances from origin (assuming heliocentric) in scene units
      const rs = points.map(p => Math.sqrt(p.x*p.x + p.y*p.y + p.z*p.z));
      const rMin = Math.min(...rs);
      const rMax = Math.max(...rs);
      // Convert scene radii back to AU: scene_km = r / SCALE_FACTOR (because toScaledVector ends in km*SCALE_FACTOR)
      // Wait: toScaledVector: meters -> (maybe km) * SCALE_FACTOR => scene_units. So reverse: (scene_units / SCALE_FACTOR) = km.
      // km -> AU by dividing by (AU in km).
      const AU_KM = 149_597_870.7;
      const kmMin = rMin / (1/149600); // since SCALE_FACTOR is 1/149600
      const kmMax = rMax / (1/149600);
      const q_est = kmMin / AU_KM;
      const Q_est = kmMax / AU_KM;
      // Estimate a and e from q & Q: a=(q+Q)/2, e=(Q-q)/(Q+q)
      const a_est = (q_est + Q_est) / 2;
      const e_est = (Q_est - q_est) / (Q_est + q_est);
      const meta = simulationData.orbit_meta;
      if (ORBIT_DEBUG) {
        console.log('[orbit-diagnostics]', {
          meta,
          derived: { a_est, e_est, q_est, Q_est },
          deltas: {
            da: a_est - meta.a_au,
            de: e_est - meta.e,
            dq: q_est - meta.q_au,
            dQ: Q_est - meta.Q_au,
          }
        });
      }
    };

  const asteroidPointsRaw = simulationData.asteroid_trajectory.map(p => p.position);
    // True physical scaling path (meters -> km heuristic -> SCALE_FACTOR) for all modes now
    const asteroidPoints: THREE.Vector3[] = simulationData.asteroid_trajectory.map(p => toScaledVector(p.position));
    if (ORBIT_DEBUG) {
      console.log(`Asteroid trajectory data:`, {
        rawPoints: simulationData.asteroid_trajectory.length,
        scaledPoints: asteroidPoints.length,
        firstRawPoint: simulationData.asteroid_trajectory[0]?.position,
        firstScaledPoint: asteroidPoints[0],
        pointsAreFinite: asteroidPoints.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)),
        someRawPoints: simulationData.asteroid_trajectory.slice(0, 3).map(p => p.position),
        someScaledPoints: asteroidPoints.slice(0, 3),
        allPointsRange: {
          minX: Math.min(...asteroidPoints.map(p => p.x)),
          maxX: Math.max(...asteroidPoints.map(p => p.x)),
          minY: Math.min(...asteroidPoints.map(p => p.y)),
          maxY: Math.max(...asteroidPoints.map(p => p.y)),
          minZ: Math.min(...asteroidPoints.map(p => p.z)),
          maxZ: Math.max(...asteroidPoints.map(p => p.z))
        }
      });
    }
    runOrbitDiagnostics(asteroidPoints);
  // debug point function removed (no-op)

    if (asteroidPoints.length > 1) {
      const asteroidOrbitLine = createOrbitLine(asteroidPoints, 0xff2222);
      asteroidOrbitLine.visible = true;
      asteroidOrbitLine.renderOrder = 1000;
      scene.add(asteroidOrbitLine);
      asteroidOrbitLineRef.current = asteroidOrbitLine;
      if (ORBIT_DEBUG) {
        console.log(`[orbit] asteroid line added (physical scale)`, {
          count: asteroidPoints.length,
          firstScaled: asteroidPoints[0],
          rawSample: asteroidPointsRaw.slice(0,3),
        });
      }
      // Always add asteroid orbit label (preview + full) if not already present
      if (!asteroidOrbitLabelRef.current) {
        const pts = asteroidPoints;
        let anchorPoint = pts[0];
        for (const p of pts) { if (p.z > anchorPoint.z) anchorPoint = p; }
        const box = new THREE.Box3().setFromPoints(pts);
        const size = box.getSize(new THREE.Vector3());
        const extent = size.length()/Math.sqrt(3);
        const anchor = new THREE.Object3D(); anchor.position.copy(anchorPoint); scene.add(anchor);
        const offset = new THREE.Vector3(extent*0.08, extent*0.05, -extent*0.07);
        const orbitLabel = createLabelBillboard('Asteroid Orbit', '#ff2222', 0.042, undefined, 0.62);
        orbitLabel.position.copy(anchorPoint).add(offset);
        const { line: conn, positions } = createLabelConnector(0xff2222, 0.6);
        positions[0]=anchorPoint.x; positions[1]=anchorPoint.y; positions[2]=anchorPoint.z;
        positions[3]=orbitLabel.position.x; positions[4]=orbitLabel.position.y; positions[5]=orbitLabel.position.z;
        conn.geometry.attributes.position.needsUpdate = true;
        scene.add(orbitLabel); scene.add(conn);
        asteroidOrbitLabelRef.current = orbitLabel;
        asteroidOrbitLabelConnectorRef.current = conn;
        asteroidOrbitLabelPositionsRef.current = positions;
        labelEntriesRef.current.push({
          mesh: orbitLabel,
          targetRef: { current: anchor } as React.MutableRefObject<THREE.Object3D>,
          offset,
          connector: conn,
          connectorPositions: positions,
          role: 'asteroidOrbit'
        });
      }
    } else {
      console.warn('[orbit] insufficient asteroid points', asteroidPoints.length);
    }

    // ---------------------------------------------------------
    // Rebuild Earth orbit line from backend data (we removed local generator)
    // ---------------------------------------------------------
    const rebuildEarthOrbitFromTrajectory = () => {
      if (!simulationData?.earth_trajectory?.length) return false;
      const pts = simulationData.earth_trajectory.map(p => toScaledVector(p.position));
      if (!pts.length) return false;
      if (earthOrbitLineRef.current) {
        // Replace geometry
        const geom = new THREE.BufferGeometry();
        const arr = new Float32Array(pts.length * 3);
        for (let i=0;i<pts.length;i++) {
          const v = pts[i];
            arr[i*3] = v.x; arr[i*3+1] = v.y; arr[i*3+2] = v.z;
        }
        geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        // Remove old line object and create a new one via createOrbitLine for consistent material settings
        const scene = sceneRef.current;
        if (scene && earthOrbitLineRef.current.parent === scene) {
          scene.remove(earthOrbitLineRef.current);
        }
        earthOrbitLineRef.current.geometry.dispose();
        (earthOrbitLineRef.current.material as THREE.Material).dispose();
        const newLine = createOrbitLine(pts, 0x82beff);
        newLine.visible = true;
        scene?.add(newLine);
        earthOrbitLineRef.current = newLine;
        return true;
      }
      return false;
    };

    const rebuildEarthOrbitFromMeta = () => {
      const meta = simulationData?.earth_orbit;
      if (!meta) return false;
      const a_au = meta.a_au ?? 1.0;
      const e = meta.e ?? 0.0167;
      const a_m = a_au * 149_597_870_700.0;
      const samples = 720;
      const pts: THREE.Vector3[] = [];
      for (let i=0;i<samples;i++) {
        const nu = (i / samples) * Math.PI * 2;
        const r = a_m * (1 - e*e) / (1 + e * Math.cos(nu));
        // Planar ellipse (ecliptic), z=0
        const x = r * Math.cos(nu);
        const y = r * Math.sin(nu);
        pts.push(toScaledVector({ x, y, z: 0 }));
      }
      if (earthOrbitLineRef.current) {
        const scene = sceneRef.current;
        if (scene && earthOrbitLineRef.current.parent === scene) scene.remove(earthOrbitLineRef.current);
        earthOrbitLineRef.current.geometry.dispose();
        (earthOrbitLineRef.current.material as THREE.Material).dispose();
      }
      const newLine = createOrbitLine(pts, 0x82beff);
      newLine.visible = true;
      sceneRef.current?.add(newLine);
      earthOrbitLineRef.current = newLine;
      return true;
    };

    // Only rebuild once per data load (avoid thrash). If existing line has no points, rebuild.
    let earthLineNeedsBuild = false;
    if (earthOrbitLineRef.current) {
      const posAttr = (earthOrbitLineRef.current.geometry.getAttribute('position') as THREE.BufferAttribute | undefined);
      if (!posAttr || posAttr.count === 0) earthLineNeedsBuild = true;
    } else earthLineNeedsBuild = true;

    if (earthLineNeedsBuild) {
      const success = rebuildEarthOrbitFromTrajectory() || rebuildEarthOrbitFromMeta();
      if (!success) {
        console.warn('[earth-orbit] No data to build Earth orbit line yet');
      }
    }

    // Ensure Earth mesh appears; prefer backend first sample (full mode) else fallback analytic motion
    if (earthMeshRef.current) {
      if (simulationMode === 'full' && simulationData?.earth_trajectory?.length) {
        const firstEarth = simulationData.earth_trajectory[0];
        earthMeshRef.current.position.copy(toScaledVector(firstEarth.position));
        updateEarthOrientationForTime(earthMeshRef.current, simulationData.earth_absolute_timestamps?.[0]);
      } else {
        // fallback idle motion (accelerated) using analytic model
        const idleSeconds = (performance.now() * 0.001) * 86400 * 0.02; // small drift
        earthMeshRef.current.position.copy(getEarthPosition(idleSeconds));
      }
      earthMeshRef.current.visible = true;
    }

    // Auto-frame logic (preview only) — fit both Earth orbit and asteroid points
    if (simulationMode === 'preview' && cameraRef.current && !previewAutoFramedRef.current) {
      const box = new THREE.Box3();
      asteroidPoints.forEach(p=>box.expandByPoint(p));
      if (earthOrbitLineRef.current) {
        const eGeom = earthOrbitLineRef.current.geometry as THREE.BufferGeometry;
        const pos = eGeom.getAttribute('position') as THREE.BufferAttribute;
        const tmp = new THREE.Vector3();
        for (let i=0;i<pos.count;i++) {
          tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
          box.expandByPoint(tmp);
        }
      }
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size); box.getCenter(center);
      const maxDim = Math.max(size.x,size.y,size.z);
      const cam = cameraRef.current;
  const fitDist = maxDim / (2*Math.tan(THREE.MathUtils.degToRad(cam.fov*0.5))) * 1.15;
      cam.position.copy(center.clone().add(new THREE.Vector3(fitDist, fitDist*0.4, fitDist)));
      cam.near = Math.max(fitDist*0.00001, 0.0001);
      cam.far = fitDist*500;
      cam.updateProjectionMatrix();
      if (controlsRef.current) {
        controlsRef.current.target.copy(center);
        controlsRef.current.update();
      }
      previewAutoFramedRef.current = true;
      console.log('[orbit] auto-framed preview camera', { center, size });
    }

  if (simulationMode === 'preview') {
      // Preview: show asteroid orbit line AND Earth orbit path for spatial context.
      // Hide Earth mesh, but repurpose Earth label text to "Earth Orbit" and keep it visible.
      asteroidAnimationRef.current = null;
      earthAnimationRef.current = null;
      playbackDurationRef.current = ASTEROID_ANIMATION_DURATION_MS;
      if (asteroidMeshRef.current) asteroidMeshRef.current.visible = false; // we only show orbit in preview
      if (earthMeshRef.current) earthMeshRef.current.visible = false;
      if (earthOrbitLineRef.current) {
        earthOrbitLineRef.current.visible = true; // always visible in preview
      }
      // Hide base Earth label; create separate Earth Orbit label anchored to orbit center if not present
      if (earthLabelEntryRef.current) {
        earthLabelEntryRef.current.mesh.visible = false;
        earthLabelEntryRef.current.connector.visible = false;
      }
      previewModeActiveRef.current = true;
      if (!earthOrbitLabelRef.current && earthOrbitLineRef.current) {
        const geom = earthOrbitLineRef.current.geometry as THREE.BufferGeometry;
        const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
        const pts: THREE.Vector3[] = [];
        for (let i=0;i<posAttr.count;i++) {
          pts.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
        }
        // choose anchor point on orbit farthest from sun along +Z to avoid overlapping sun label
        let anchorPoint = pts[0];
        for (const p of pts) { if (p.z > anchorPoint.z) anchorPoint = p; }
        const box = new THREE.Box3().setFromPoints(pts);
        const size = box.getSize(new THREE.Vector3());
        const extent = size.length()/Math.sqrt(3);
        const anchor = new THREE.Object3D(); anchor.position.copy(anchorPoint); scene.add(anchor);
        const offset = new THREE.Vector3(extent*0.14, extent*0.09, -extent*0.12);
        const orbitLabel = createLabelBillboard('Earth Orbit', '#ffffff', 0.045, undefined, 0.65);
        orbitLabel.position.copy(anchorPoint).add(offset);
        const { line: conn, positions } = createLabelConnector(0xdbe9ff, 0.5);
        positions[0]=anchorPoint.x; positions[1]=anchorPoint.y; positions[2]=anchorPoint.z;
        positions[3]=orbitLabel.position.x; positions[4]=orbitLabel.position.y; positions[5]=orbitLabel.position.z;
        conn.geometry.attributes.position.needsUpdate = true;
        scene.add(orbitLabel); scene.add(conn);
        earthOrbitLabelRef.current = orbitLabel;
        earthOrbitLabelConnectorRef.current = conn;
        earthOrbitLabelPositionsRef.current = positions;
        labelEntriesRef.current.push({
          mesh: orbitLabel,
          targetRef: { current: anchor } as React.MutableRefObject<THREE.Object3D>,
          offset,
          connector: conn,
          connectorPositions: positions,
          role: 'earthOrbit'
        });
      }
      resetPlayback();
      idleSimulationTimeRef.current = -1; // disable idle anim
      return;
    }

    // Leaving preview: remove debug points & reset auto-frame flag
    [asteroidDebugPointsRef, asteroidRawDebugRef].forEach(ref => {
      if (ref.current) {
        scene.remove(ref.current);
        ref.current.geometry.dispose();
        (ref.current.material as THREE.Material).dispose();
        ref.current = null;
      }
    });
    previewAutoFramedRef.current = false;

    const asteroidTimeline = buildTimeline(simulationData.asteroid_trajectory);
    // Backend timestamps already encode correct Keplerian timing - use them directly without retiming
    if (ORBIT_DEBUG) {
      // Quick diagnostic: check correlation of radius vs progression speed
      let accelNearPeri = 0; let decelNearAp = 0;
      for (let i=1;i<asteroidTimeline.length;i++) {
        const rPrev = asteroidTimeline[i-1].position.length();
        const rCur = asteroidTimeline[i].position.length();
        const dt = asteroidTimeline[i].t - asteroidTimeline[i-1].t;
        if (dt <= 0) continue;
        const dr = rCur - rPrev;
        if (dr < 0) accelNearPeri++; else decelNearAp++;
      }
      console.log('[orbit-debug] asteroid retime stats', { accelSegments: accelNearPeri, decelSegments: decelNearAp });
    }
    // If we are no longer in preview but preview flag still set, clean up preview-only labels
  if (previewModeActiveRef.current && simulationModeRef.current !== 'preview') {
      previewModeActiveRef.current = false;
      if (earthOrbitLabelRef.current) {
        scene.remove(earthOrbitLabelRef.current);
        earthOrbitLabelRef.current.geometry.dispose();
        const mat = earthOrbitLabelRef.current.material as THREE.MeshBasicMaterial; mat.map?.dispose(); mat.dispose();
        earthOrbitLabelRef.current = null;
      }
      if (earthOrbitLabelConnectorRef.current) {
        scene.remove(earthOrbitLabelConnectorRef.current);
        earthOrbitLabelConnectorRef.current.geometry.dispose();
        (earthOrbitLabelConnectorRef.current.material as THREE.LineBasicMaterial).dispose();
        earthOrbitLabelConnectorRef.current = null;
        earthOrbitLabelPositionsRef.current = null;
      }
      labelEntriesRef.current = labelEntriesRef.current.filter(e => e.role !== 'earthOrbit');
      // Force Earth label connector refresh next frame (positions updated below if visible)
      if (earthLabelEntryRef.current && earthMeshRef.current) {
        earthMeshRef.current.getWorldPosition(TEMP_LABEL_TARGET_VECTOR);
        const entry = earthLabelEntryRef.current;
        const positions = entry.connectorPositions;
        const target = TEMP_LABEL_TARGET_VECTOR.clone();
        const labelPos = target.clone().add(entry.offset);
        positions[0]=target.x; positions[1]=target.y; positions[2]=target.z;
        positions[3]=labelPos.x; positions[4]=labelPos.y; positions[5]=labelPos.z;
        entry.connector.geometry.attributes.position.needsUpdate = true;
        entry.mesh.visible = true;
        entry.connector.visible = true;
      }
    }

    if (asteroidTimeline.length > 0) {
      ensureAsteroidMesh();
      asteroidAnimationRef.current = {
        timeline: asteroidTimeline,
        durationMs: ASTEROID_ANIMATION_DURATION_MS,
      };
      // Create / update asteroid highlight (only in full sim)
      if (!asteroidHighlightGroupRef.current) {
        const g = new THREE.Group();
        const ringGeom = new THREE.RingGeometry(1.2, 2.0, 64);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite:false });
        const ring = new THREE.Mesh(ringGeom, ringMat); ring.rotation.x = Math.PI/2; g.add(ring);
        const diskGeom = new THREE.CircleGeometry(1.1, 48);
        const diskMat = new THREE.MeshBasicMaterial({ color: 0xffe89a, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite:false });
        const disk = new THREE.Mesh(diskGeom, diskMat); disk.rotation.x = Math.PI/2; g.add(disk);
        g.renderOrder = 1200; g.frustumCulled = false;
        asteroidHighlightGroupRef.current = g; scene.add(g);
      }
      if (asteroidMeshRef.current && asteroidHighlightGroupRef.current && cameraRef.current) {
        asteroidHighlightGroupRef.current.position.copy(asteroidMeshRef.current.position);
        const camDist = cameraRef.current.position.distanceTo(asteroidMeshRef.current.position);
        const distanceScale = THREE.MathUtils.clamp(camDist * 0.022, 3.2, 520);
        asteroidHighlightGroupRef.current.scale.setScalar(distanceScale);
      }
    } else {
      asteroidAnimationRef.current = null;
      if (asteroidMeshRef.current) {
        asteroidMeshRef.current.visible = false;
      }
      if (asteroidHighlightGroupRef.current) {
        scene.remove(asteroidHighlightGroupRef.current);
        asteroidHighlightGroupRef.current.traverse(obj=>{ if ((obj as THREE.Mesh).isMesh){ (obj as THREE.Mesh).geometry.dispose(); ((obj as THREE.Mesh).material as THREE.Material).dispose(); }});
        asteroidHighlightGroupRef.current = null;
      }
    }

  const earthTimeline = buildTimeline(simulationData.earth_trajectory);
    // Removed dynamic orientation sampling (analytic orbit is canonical)
    if (earthTimeline.length > 0) {
      earthAnimationRef.current = {
        timeline: earthTimeline,
        durationMs: EARTH_ANIMATION_DURATION_MS,
      };
    } else {
      earthAnimationRef.current = null;
      updateEarthBasePosition();
    }

    // Compute global timestamp span (asteroid + earth) for synchronized progress mapping
    const starts: number[] = [];
    const ends: number[] = [];
    if (asteroidAnimationRef.current?.timeline.length) {
      starts.push(asteroidAnimationRef.current.timeline[0].timestamp);
      ends.push(asteroidAnimationRef.current.timeline[asteroidAnimationRef.current.timeline.length-1].timestamp);
    }
    if (earthAnimationRef.current?.timeline.length) {
      starts.push(earthAnimationRef.current.timeline[0].timestamp);
      ends.push(earthAnimationRef.current.timeline[earthAnimationRef.current.timeline.length-1].timestamp);
    }
    if (starts.length && ends.length) {
      const gStart = Math.min(...starts);
      const gEnd = Math.max(...ends);
      globalStartTsRef.current = gStart;
      globalEndTsRef.current = gEnd;
      globalSpanRef.current = Math.max(gEnd - gStart, 1);
    }

    // (Removed previous analytic Earth resampling block; backend or fallback handles Earth path.)

    // Restore Earth visibility for full simulations
    if (earthMeshRef.current) {
      earthMeshRef.current.visible = true;
    }
    // Restore Earth label visibility & text for full simulations
    ensureEarthLabelText('Earth');
    if (earthLabelRef.current) earthLabelRef.current.visible = true;
    if (earthLabelEntryRef.current) {
      earthLabelEntryRef.current.mesh.visible = true;
      earthLabelEntryRef.current.connector.visible = true;
    }

    // Keep visual duration constant, but progress now represents fraction of global physical span
    playbackDurationRef.current = ASTEROID_ANIMATION_DURATION_MS;

    if (playbackProgressRef.current > 1) {
      playbackProgressRef.current = 1;
      setPlaybackProgress(1);
    }

    applyPlaybackProgressValue(playbackProgressRef.current);
    lastFrameTimeRef.current = performance.now();
  }, [simulationData, simulationMode, applyPlaybackProgressValue, setIsPlaybackPlaying, setPlaybackProgress, ORBIT_DEBUG]);

  // Add camera roll shortcut & initial stronger roll to flatten orbit visually (without altering data)
  useEffect(() => {
    const rollCamera = (angleRad: number) => {
      if (!cameraRef.current) return;
      const cam = cameraRef.current;
      // Build a quaternion rotating around view direction
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(dir, angleRad);
      cam.quaternion.premultiply(q);
    };
    // Apply one-time 90 deg roll if not applied
    if (!cameraRollAppliedRef.current && cameraRef.current) {
      rollCamera(Math.PI * 0.5);
      cameraRollAppliedRef.current = true;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'r') {
        rollCamera(Math.PI * 0.5); // incremental 90° roll each press
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    if (!controlsRef.current || !cameraRef.current) return;

    const controls = controlsRef.current;
    const camera = cameraRef.current;
    cameraFocusRef.current = cameraFocus;

    if (cameraFocus === 'sun') {
      controls.enablePan = true;
      controls.target.set(0, 0, 0);
      controls.minDistance = EARTH_RADIUS_SCALED * 6;
      controls.maxDistance = AU_SCALED * 12;
      camera.position.set(AU_SCALED * 2.2, AU_SCALED * 0.8, AU_SCALED * 2.4);
      camera.lookAt(0, 0, 0);
      earthFocusOffsetRef.current = null;
      controls.update();
      if (earthOrbitLineRef.current) {
        earthOrbitLineRef.current.visible = true;
        const material = earthOrbitLineRef.current.material as THREE.LineBasicMaterial;
        material.opacity = 0.68;
      }
      if (earthMeshRef.current) {
        const earthMaterial = earthMeshRef.current.material as THREE.MeshPhongMaterial;
        earthMaterial.color.set(0xf5fcff);
        earthMaterial.emissive.set(0x24406d);
        earthMaterial.emissiveIntensity = 0.63;
        earthMaterial.needsUpdate = true;
      }
      if (sunLabelRef.current) {
        sunLabelRef.current.visible = true;
      }
      if (earthLabelRef.current) {
        earthLabelRef.current.visible = true;
      }
      if (sunLabelEntryRef.current) {
        sunLabelEntryRef.current.connector.visible = true;
      }
      if (earthLabelEntryRef.current) {
        earthLabelEntryRef.current.connector.visible = true;
      }
    } else if (cameraFocus === 'earth' && earthMeshRef.current) {
      const earthPos = earthMeshRef.current.position;
      controls.target.copy(earthPos);
      controls.enablePan = false;
      controls.minDistance = EARTH_RADIUS_SCALED * 1.15;
      controls.maxDistance = EARTH_RADIUS_SCALED * 95;
      const offset = earthFocusOffsetRef.current ?? new THREE.Vector3();
      offset.set(
        EARTH_RADIUS_SCALED * 6.5,
        EARTH_RADIUS_SCALED * 3.2,
        EARTH_RADIUS_SCALED * 6.5,
      );
      earthFocusOffsetRef.current = offset.clone();
      camera.position.copy(earthPos).add(offset);
      camera.lookAt(earthPos);
      controls.update();
      if (earthOrbitLineRef.current) {
        earthOrbitLineRef.current.visible = true;
        const material = earthOrbitLineRef.current.material as THREE.LineBasicMaterial;
        material.opacity = 0.38;
      }
      if (earthMeshRef.current) {
        const earthMaterial = earthMeshRef.current.material as THREE.MeshPhongMaterial;
        earthMaterial.color.set(0xd9ecff);
        earthMaterial.emissive.set(0x101a2f);
        earthMaterial.emissiveIntensity = 0.34;
        earthMaterial.needsUpdate = true;
      }
      if (sunLabelRef.current) {
        sunLabelRef.current.visible = false;
      }
      if (earthLabelRef.current) {
        earthLabelRef.current.visible = true;
      }
      if (sunLabelEntryRef.current) {
        sunLabelEntryRef.current.connector.visible = false;
      }
      if (earthLabelEntryRef.current) {
        earthLabelEntryRef.current.connector.visible = true;
      }
    } else if (cameraFocus === 'asteroid' && asteroidMeshRef.current) {
      const aPos = asteroidMeshRef.current.position;
      controls.target.copy(aPos);
      controls.enablePan = false;
      // Distance heuristics relative to Earth radius scale for consistency
      controls.minDistance = EARTH_RADIUS_SCALED * 0.2;
      controls.maxDistance = AU_SCALED * 2.5;
      const dist = aPos.length();
      // Place camera slightly offset from asteroid along a diagonal vector toward origin for context
      const camOffset = new THREE.Vector3(1, 0.45, 0.9).normalize().multiplyScalar(Math.max(dist * 0.18, EARTH_RADIUS_SCALED * 12));
      camera.position.copy(aPos).add(camOffset);
      camera.lookAt(aPos);
      controls.update();
      // Dim other labels/connectors except asteroid orbit label
      if (sunLabelRef.current) sunLabelRef.current.visible = false;
      if (earthLabelRef.current) earthLabelRef.current.visible = false;
      if (sunLabelEntryRef.current) sunLabelEntryRef.current.connector.visible = false;
      if (earthLabelEntryRef.current) earthLabelEntryRef.current.connector.visible = false;
      // Ensure earth orbit line still provides context at lower opacity
      if (earthOrbitLineRef.current) {
        earthOrbitLineRef.current.visible = true;
        const m = earthOrbitLineRef.current.material as THREE.LineBasicMaterial;
        m.opacity = 0.25;
      }
    }
  }, [cameraFocus]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {simulationMode === 'full' && (
        <div
          style={{
            position: 'absolute',
            top: '1rem',
            right: '1rem',
            display: 'flex',
            gap: '0.5rem',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'rgba(17, 190, 255, 0.9)',
              color: '#001018',
              padding: '0.5rem 0.75rem',
              borderRadius: '4px',
              fontSize: '0.875rem',
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
            }}
          >FULL SIMULATION</div>
          <button
            onClick={() => {
              setSimulationData(null);
              setSimulationMode(null);
            }}
            style={{
              background: 'rgba(220, 53, 69, 0.9)',
              color: '#fff',
              border: 'none',
              padding: '0.5rem 0.75rem',
              borderRadius: '4px',
              fontSize: '0.875rem',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
            }}
          >EXIT</button>
        </div>
      )}
      {simulationMode === 'preview' && (
        <div
          style={{
            position: 'absolute',
            top: '1rem',
            right: '1rem',
            display: 'flex',
            gap: '0.5rem',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'rgba(255, 193, 7, 0.9)',
              color: '#000',
              padding: '0.5rem 0.75rem',
              borderRadius: '4px',
              fontSize: '0.875rem',
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
            }}
          >
            PREVIEW MODE
          </div>
          <button
            onClick={() => {
              setSimulationData(null);
              setSimulationMode(null);
            }}
            style={{
              background: 'rgba(220, 53, 69, 0.9)',
              color: '#fff',
              border: 'none',
              padding: '0.5rem 0.75rem',
              borderRadius: '4px',
              fontSize: '0.875rem',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
            }}
          >
            EXIT
          </button>
        </div>
      )}
    </div>
  );
}

