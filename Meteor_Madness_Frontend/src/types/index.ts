export interface Asteroid {
  id: string;
  name: string;
  diameter: number; // km
  density: number; // kg/m³
  velocity?: number; // km/s
  mass?: number; // kg
}

export interface AsteroidDetails extends Asteroid {
  albedo?: number;
  rotation_period?: number;
  spectral_type?: string;
  // Orbital properties from NEO database
  H?: number; // Absolute magnitude
  e?: number; // Eccentricity  
  a?: number; // Semi-major axis (AU)
  per?: number; // Orbital period (years)
  i?: number; // Inclination (degrees)
  om?: number; // Longitude of ascending node (degrees)
  w?: number; // Argument of periapsis (degrees)
}

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface TrajectoryPoint {
  position: Vector3D;
  timestamp?: number; // Unix timestamp or relative time (optional for previews)
  velocity?: Vector3D; // present in full simulation mode
}

export interface ImpactLocation {
  latitude: number;
  longitude: number;
}

export interface SimulationData {
  asteroid_id: string;
  asteroid_trajectory: TrajectoryPoint[];
  earth_trajectory: TrajectoryPoint[];
  // Enriched physics fields from backend full simulation (optional for backward compatibility)
  epoch?: number; // POSIX seconds the backend used as reference
  units?: { length: string; time: string };
  mu_sun?: number; // solar GM
  progress?: number[]; // unified 0..1 timeline samples
  asteroid_absolute_timestamps?: number[];
  earth_absolute_timestamps?: number[];
  asteroid_orbit?: {
    a_au: number; e: number; q_au: number; Q_au: number; i_deg: number; raan_deg: number; argp_deg: number;
    period_seconds: number; mean_motion_rad_s: number;
    anomalies?: { true_anomaly_rad: number[]; eccentric_anomaly_rad: number[]; mean_anomaly_rad: number[] };
  };
  earth_orbit?: {
    a_au: number; e: number; period_seconds: number; mean_motion_rad_s: number;
    anomalies?: { true_anomaly_rad: number[]; eccentric_anomaly_rad: number[]; mean_anomaly_rad: number[] };
    spin?: { obliquity_deg: number; rotation_period_s: number; prime_meridian_rad_at_epoch: number };
  };
  closest_approach?: { index: number; distance_m: number; progress?: number; asteroid_time_s?: number; earth_time_s?: number };
  impact_estimate?: {
    will_impact: boolean;
    impact_time?: number;
    impact_location?: ImpactLocation;
    crater?: { radius_m: number };
    casualties?: number;
  };
  orbit_meta?: {
    a_au: number;
    e: number;
    q_au: number;
    Q_au: number;
    i_deg: number;
    raan_deg: number;
    argp_deg: number;
    period_seconds?: number;
  };
}

export interface AsteroidListResponse {
  asteroids: Asteroid[];
  total: number;
  limit: number;
  offset: number;
}

export type SimulationMode = 'preview' | 'full';

export type ViewMode = 'basic' | 'scientific' | 'decision';

export type SceneView = 'space' | 'impactMap';

export interface ImpactParameters {
  diameterKm: number;      // asteroid diameter used for impact effects
  massKg: number;          // mass override (if user wants to tweak from derived mass)
  entryAngleDeg: number;   // angle from horizontal (0 = grazing, 90 = vertical)
  entryVelocityKms: number;// km/s at top of atmosphere (approx)
}

export interface SimulationJobResponse {
  job_id: string;
  status?: string;
  message?: string;
}
