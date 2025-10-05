import type {
  AsteroidDetails,
  AsteroidListResponse,
  SimulationData,
  SimulationJobResponse,
  SimulationMode,
} from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
const DEFAULT_POLL_INTERVAL = 2000;
const DEFAULT_POLL_TIMEOUT = 120_000;

interface PollOptions {
  interval?: number;
  timeout?: number;
}

/**
 * Fetch a paginated list of asteroids
 */

// Fetch list: start = offset index, limit = page size
export async function fetchAsteroids(limit: number = 200, offset: number = 0): Promise<AsteroidListResponse>  {
  const response = await fetch(`${API_BASE_URL}/asteroids?start=${offset}&limit=${limit}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch asteroids: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetch detailed information for a specific asteroid
 */
export async function fetchAsteroidDetails(id: string): Promise<AsteroidDetails> {
  const response = await fetch(`${API_BASE_URL}/asteroids/${id}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch asteroid details: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Kick off an asteroid simulation. Preview mode returns static trajectories immediately,
 * full mode starts an async job which must be polled until completion.
 */
export async function simulateAsteroid(
  id: string,
  mode: SimulationMode = 'preview',
): Promise<SimulationData | SimulationJobResponse> {
  const response = await fetch(`${API_BASE_URL}/simulate/${id}?preview=${mode === 'preview'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to simulate asteroid: ${response.statusText}`);
  }
  if (mode === 'preview') {
    const rawData = await response.json();
    // Convert raw matrix format [[x,y,z], [x,y,z], ...] to TrajectoryPoint format
    if (rawData.asteroid_trajectory && Array.isArray(rawData.asteroid_trajectory)) {
      const trajectoryPoints = rawData.asteroid_trajectory.map((point: number[]) => ({
        position: {
          x: point[0],
          y: point[1],
          z: point[2]
        }
      }));
      return {
        asteroid_id: id,
        asteroid_trajectory: trajectoryPoints,
        earth_trajectory: [],
        orbit_meta: rawData.orbit_meta
      };
    }
    return rawData;
  }

  const job: SimulationJobResponse = await response.json();
  if (!job.job_id) {
    throw new Error('Simulation job response missing jobId');
  }

  return job;
}

/**
 * Fetch simulation report by job ID (for async simulations)
 */
export async function fetchSimulationReport(jobId: string): Promise<Response> {
  return fetch(`${API_BASE_URL}/reports/${jobId}`);
}

export async function pollSimulationReport(
  jobId: string,
  { interval = DEFAULT_POLL_INTERVAL, timeout = DEFAULT_POLL_TIMEOUT }: PollOptions = {},
): Promise<SimulationData> {
  const start = Date.now();

  while (true) {
    const response = await fetchSimulationReport(jobId);

    if (response.status === 202) {
      // Still processing; continue polling
      await new Promise((resolve) => setTimeout(resolve, interval));
    } else if (response.ok) {
      const raw = await response.json();
      // Detect new raw full-sim format (asteroid_positions + asteroid_velocities + timestamps)
      if (raw.asteroid_positions && raw.asteroid_velocities && raw.timestamps) {
        const traj = raw.asteroid_positions.map((p: number[], idx: number) => {
          const v = raw.asteroid_velocities[idx];
          return {
            position: { x: p[0], y: p[1], z: p[2] },
            velocity: v ? { x: v[0], y: v[1], z: v[2] } : undefined,
            timestamp: raw.timestamps[idx]
          };
        });
        const earthPositions = raw.earth_positions || [];
        const earthVelocities = raw.earth_velocities || [];
        const earthTraj = earthPositions.map((p: number[], idx: number) => {
          const v = earthVelocities[idx];
          return {
            position: { x: p[0], y: p[1], z: p[2] },
            velocity: v ? { x: v[0], y: v[1], z: v[2] } : undefined,
            timestamp: raw.timestamps[idx]
          };
        });
        const simulation: SimulationData = {
          asteroid_id: raw.asteroid_id || 'unknown',
          asteroid_trajectory: traj,
            earth_trajectory: earthTraj,
            orbit_meta: raw.orbit_meta,
            epoch: raw.epoch,
            units: raw.units,
            mu_sun: raw.mu_sun,
            progress: raw.progress,
            asteroid_absolute_timestamps: raw.asteroid_absolute_timestamps,
            earth_absolute_timestamps: raw.earth_absolute_timestamps,
            asteroid_orbit: raw.asteroid_orbit,
            earth_orbit: raw.earth_orbit,
            closest_approach: raw.closest_approach
        };
        return simulation;
      }
      return raw;
    } else {
      throw new Error(`Failed to fetch simulation report: ${response.statusText}`);
    }

    if (Date.now() - start > timeout) {
      throw new Error('Timed out while waiting for simulation report');
    }
  }
}

/**
 * Simulate impact effects with custom parameters
 */
export interface ImpactParameters {
  m: number;        // mass in kg
  d: number;        // diameter in meters
  v: number;        // velocity in m/s
  rho: number;      // density in kg/m³
  alpha: number;    // impact angle in degrees
  lat: number;      // latitude
  lon: number;      // longitude
}

export interface BlastZone {
  psi: number;
  radius_m: number | null;
  radius_km: number | null;
  fatality_rate: number;
  injury_rate: number;
}

export interface CasualtyZone {
  psi: number;
  radius_km: number;
  population: number;
  deaths: number;
  injuries: number;
}

export interface ImpactSimulationResult {
  crater: {
    diameter_m: number;
    diameter_km: number;
    depth_m: number;
  };
  blast_zones: BlastZone[];
  casualties: {
    by_zone: CasualtyZone[];
    total_deaths: number;
    total_injuries: number;
  };
  seismic: {
    magnitude: number;
    eta: number;
  };
  terrain: {
    rock_type: string;
    elevation_m: number;
    target_type: string;
  };
  tsunami: {
    source_amplitude_m: number;
    max_coastal_amplitude_m?: number;
    min_coastal_arrival_hrs?: number;
    attenuation_km: number;
    shallow_speed_m_s: number;
    ocean_depth_m?: number;
    coastal_amplitudes?: Record<number, number>;
    coastal_arrival_times?: Record<number, number>;
  } | null;
  impact_energy_j: number;
  mass_ablation_percent: number;
  location: {
    lat: number;
    lon: number;
  };
}

export async function simulateImpact(params: ImpactParameters): Promise<ImpactSimulationResult> {
  const response = await fetch(`${API_BASE_URL}/simulate_impact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  
  if (!response.ok) {
    throw new Error(`Failed to simulate impact: ${response.statusText}`);
  }
  
  return response.json();
}
