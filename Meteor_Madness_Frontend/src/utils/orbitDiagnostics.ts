import * as THREE from 'three';

export interface OrbitMetaLike {
  a_au: number; // semi-major axis (AU)
  e: number;    // eccentricity
  q_au: number; // perihelion distance (AU)
  Q_au: number; // aphelion distance (AU)
}

interface DerivedOrbit {
  a_au: number;
  e: number;
  q_au: number;
  Q_au: number;
}

export interface OrbitDiagnosticsResult {
  derived: DerivedOrbit;
  deltas: { da: number; de: number; dq: number; dQ: number };
  percent: { a_pct: number; e_pct: number; q_pct: number; Q_pct: number };
  sampleCount: number;
  rMinAU: number;
  rMaxAU: number;
}

// SCALE_FACTOR inverse assumptions (same as orbitalMechanics): 1 scene unit = (SCALE_FACTOR * km). We reverse using provided constant.
const SCALE_FACTOR = 1/149600; // must match orbitalMechanics
const AU_KM = 149_597_870.7;

export function analyzeOrbit(points: THREE.Vector3[], meta?: OrbitMetaLike): OrbitDiagnosticsResult | null {
  if (!points || points.length < 4) return null;
  // Distances in scene units -> km -> AU
  const rs = points.map(p => p.length());
  const rMin = Math.min(...rs);
  const rMax = Math.max(...rs);
  const kmMin = rMin / SCALE_FACTOR; // since scene = km * SCALE_FACTOR
  const kmMax = rMax / SCALE_FACTOR;
  const q_au = kmMin / AU_KM;
  const Q_au = kmMax / AU_KM;
  const a_au = (q_au + Q_au) / 2;
  const e = (Q_au - q_au) / (Q_au + q_au);
  const derived: DerivedOrbit = { a_au, e, q_au, Q_au };
  if (!meta) {
    return {
      derived,
      deltas: { da: 0, de: 0, dq: 0, dQ: 0 },
      percent: { a_pct: 0, e_pct: 0, q_pct: 0, Q_pct: 0 },
      sampleCount: points.length,
      rMinAU: q_au,
      rMaxAU: Q_au,
    };
  }
  const deltas = {
    da: derived.a_au - meta.a_au,
    de: derived.e - meta.e,
    dq: derived.q_au - meta.q_au,
    dQ: derived.Q_au - meta.Q_au,
  };
  const percent = {
    a_pct: (deltas.da / meta.a_au) * 100,
    e_pct: meta.e !== 0 ? (deltas.de / meta.e) * 100 : 0,
    q_pct: (deltas.dq / meta.q_au) * 100,
    Q_pct: (deltas.dQ / meta.Q_au) * 100,
  };
  return { derived, deltas, percent, sampleCount: points.length, rMinAU: q_au, rMaxAU: Q_au };
}
