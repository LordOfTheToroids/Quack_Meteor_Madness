import * as THREE from 'three';

// Astronomical constants
export const AU = 149597870.7; // 1 AU in km
export const EARTH_ORBITAL_RADIUS = 1 * AU; // km
export const EARTH_RADIUS = 6371; // km
export const SUN_RADIUS = 696000; // km
// Use sidereal year for precision, not simple 365.25
export const EARTH_ORBITAL_PERIOD = 365.25636 * 24 * 3600; // seconds (sidereal year)
export const EARTH_ROTATION_PERIOD = 23.9344696 * 3600; // seconds (sidereal day)

export const SCALE_FACTOR = 1 / 149600; // scales 1 AU to roughly 1000 world units while preserving ratios
export const AU_SCALED = AU * SCALE_FACTOR;
export const EARTH_ORBITAL_RADIUS_SCALED = EARTH_ORBITAL_RADIUS * SCALE_FACTOR;
export const EARTH_RADIUS_SCALED = EARTH_RADIUS * SCALE_FACTOR;
export const SUN_RADIUS_SCALED = SUN_RADIUS * SCALE_FACTOR;


//simplified keplerian orbit

// Keplerian elements for Earth (approx J2000 epoch)
// a: semi-major axis (1 AU), e: eccentricity, i: inclination, Ω: longitude of ascending node,
// ω: argument of perihelion, M0: mean anomaly at epoch (simplified approximate).
// Values chosen to give correct orientation relative to ecliptic reference frame.
// Source approximations (J2000): e=0.01671022, i=0.00005 rad, Ω=-11.26064° (converted), ω=102.94719°.
// We'll store in radians.
const EARTH_ECCENTRICITY = 0.01671022;
const EARTH_INCLINATION = THREE.MathUtils.degToRad(0.00005); // ~zero
const EARTH_LONG_ASC_NODE = THREE.MathUtils.degToRad(-11.26064); // Ω
const EARTH_ARG_PERIHELION = THREE.MathUtils.degToRad(102.94719); // ω
// Mean anomaly at J2000 ~ 100.46435° (Earth's mean longitude L minus ω and Ω). We'll approximate.
const EARTH_MEAN_ANOMALY_EPOCH = THREE.MathUtils.degToRad(100.46435 - 102.94719 - (-11.26064));
// Gravitational parameter μ (Sun) not needed explicitly since we use period to derive mean motion.

// Precompute rotation matrix from perifocal to ecliptic frame
function getPerifocalToEclipticMatrix(): THREE.Matrix3 {
  const cosO = Math.cos(EARTH_LONG_ASC_NODE);
  const sinO = Math.sin(EARTH_LONG_ASC_NODE);
  const cosi = Math.cos(EARTH_INCLINATION);
  const sini = Math.sin(EARTH_INCLINATION);
  const cosw = Math.cos(EARTH_ARG_PERIHELION);
  const sinw = Math.sin(EARTH_ARG_PERIHELION);
  // Standard perifocal to inertial (ecliptic) rotation: Rz(Ω) * Rx(i) * Rz(ω)
  // Build full 3x3
  const m11 = cosO * cosw - sinO * sinw * cosi;
  const m12 = -cosO * sinw - sinO * cosw * cosi;
  const m13 = sinO * sini;
  const m21 = sinO * cosw + cosO * sinw * cosi;
  const m22 = -sinO * sinw + cosO * cosw * cosi;
  const m23 = -cosO * sini;
  const m31 = sinw * sini;
  const m32 = cosw * sini;
  const m33 = cosi;
  const mat = new THREE.Matrix3();
  mat.set(m11, m12, m13, m21, m22, m23, m31, m32, m33);
  return mat;
}
const PERIFOCAL_TO_ECLIPTIC = getPerifocalToEclipticMatrix();

export function generateEarthOrbit(numPoints: number = 512): THREE.Vector3[] {
  const a = EARTH_ORBITAL_RADIUS; // km
  const e = EARTH_ECCENTRICITY;
  const n = (2 * Math.PI) / EARTH_ORBITAL_PERIOD; // mean motion rad/s
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < numPoints; i++) {
    const t = (i / numPoints) * EARTH_ORBITAL_PERIOD;
    const M = EARTH_MEAN_ANOMALY_EPOCH + n * t; // mean anomaly
    let E = M; // initial guess
    for (let it = 0; it < 7; it++) { // a few Newton iterations
      const f = E - e * Math.sin(E) - M;
      const fp = 1 - e * Math.cos(E);
      E -= f / fp;
    }
    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    // Perifocal coordinates (PQW frame)
    const x_pf = a * (cosE - e);
    const y_pf = a * Math.sqrt(1 - e * e) * sinE;
    const z_pf = 0;
    const v = new THREE.Vector3(x_pf, y_pf, z_pf); // km in perifocal
    // Rotate to ecliptic frame
    v.applyMatrix3(PERIFOCAL_TO_ECLIPTIC);
    points.push(v.multiplyScalar(SCALE_FACTOR));
  }
  return points;
}

// --- Orientation persistence for Earth orbital plane (so preview can match sampled plane) ---
let EARTH_ORBIT_ORIENTATION_QUAT: THREE.Quaternion | null = null;

function loadPersistedOrientation() {
  if (EARTH_ORBIT_ORIENTATION_QUAT) return;
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem('earthOrbitOrientationQuat');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data.x === 'number') {
      EARTH_ORBIT_ORIENTATION_QUAT = new THREE.Quaternion(data.x, data.y, data.z, data.w);
    }
  } catch { /* ignore */ }
}

export function setEarthOrbitOrientationFromSamples(samples: THREE.Vector3[]): void {
  if (!samples || samples.length < 3) return;
  // Find two non-collinear position vectors (skip duplicates / near-parallel)
  const p0 = samples[0].clone();
  let p1: THREE.Vector3 | null = null;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].distanceTo(p0) > 1e-6) { p1 = samples[i].clone(); break; }
  }
  if (!p1) return;
  const n = new THREE.Vector3().crossVectors(p0, p1);
  if (n.lengthSq() < 1e-10) return; // degenerate
  n.normalize();
  const defaultNormal = new THREE.Vector3(0, 1, 0); // current generated orbit plane normal (x-z plane)
  if (n.distanceTo(defaultNormal) < 1e-6) { return; } // already aligned
  const quat = new THREE.Quaternion().setFromUnitVectors(defaultNormal, n);
  EARTH_ORBIT_ORIENTATION_QUAT = quat;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem('earthOrbitOrientationQuat', JSON.stringify(quat));
    } catch { /* ignore persistence errors */ }
  }
}

export function getEarthOrbitOrientationQuat(): THREE.Quaternion | null {
  if (!EARTH_ORBIT_ORIENTATION_QUAT) loadPersistedOrientation();
  return EARTH_ORBIT_ORIENTATION_QUAT ? EARTH_ORBIT_ORIENTATION_QUAT.clone() : null;
}

/**
 * Calculate Earth position at given time (simplified circular orbit)
 * @param time - Current simulation time in seconds
 * @returns Position vector in km
 */

export function getEarthPosition(time: number): THREE.Vector3 {
  const a = EARTH_ORBITAL_RADIUS; // km
  const e = EARTH_ECCENTRICITY;
  const n = (2 * Math.PI) / EARTH_ORBITAL_PERIOD; // mean motion
  const M = EARTH_MEAN_ANOMALY_EPOCH + n * (time % EARTH_ORBITAL_PERIOD);
  let E = M;
  for (let it = 0; it < 7; it++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    E -= f / fp;
  }
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const x_pf = a * (cosE - e);
  const y_pf = a * Math.sqrt(1 - e * e) * sinE;
  const pos = new THREE.Vector3(x_pf, y_pf, 0);
  pos.applyMatrix3(PERIFOCAL_TO_ECLIPTIC);
  return pos.multiplyScalar(SCALE_FACTOR);
}


// Create orbit line from trajectory points
 
export function createOrbitLine(
  points: THREE.Vector3[],
  color: number = 0xffffff
): THREE.Line {
  // Use Line (not LineLoop) and DO NOT duplicate first point to avoid center spoke artifacts when points already represent full trajectory.
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 1.0,
    linewidth: 1,
    depthTest: false,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  line.renderOrder = 999;
  return line;
}

export function toScaledVector({ x, y, z }: { x: number; y: number; z: number }): THREE.Vector3 {
  // Updated heuristic: backend points are in meters (1 AU ≈ 1.496e11 m).
  // If max magnitude > 5e8 treat as meters and convert to km.
  const maxAbs = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  const assumeMeters = maxAbs > 5e8; // > 500,000 km improbable for near-Earth raw km but normal in meters
  const factor = assumeMeters ? 1 / 1000 : 1; // m -> km
  return new THREE.Vector3(x * factor, y * factor, z * factor).multiplyScalar(SCALE_FACTOR);
}

// thick orbit tube for debugging
export function createThickOrbitMesh(points: THREE.Vector3[], color: number = 0xffffff): THREE.Mesh | null {
  if (points.length < 2) return null;
  // Ensure loop continuity
  const loop = points[0].distanceTo(points[points.length - 1]) > 0.0001 ? [...points, points[0].clone()] : points;
  const curve = new THREE.CatmullRomCurve3(loop, true, 'catmullrom', 0.0);
  const tubularSegments = Math.min(Math.max(loop.length * 4, 128), 4096);
  const tubeRadius = EARTH_RADIUS_SCALED * 0.15; // fairly fat for visibility
  const geometry = new THREE.TubeGeometry(curve, tubularSegments, tubeRadius, 12, true);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 997;
  mesh.frustumCulled = false;
  return mesh;
}
