import mehcanincs as m
import api_calls as api
from typing import Dict, Any, Tuple, List
from datetime import datetime, timezone
import math
import time
import numpy as np

AU_METERS = 149_597_870_700.0  # 1 AU in meters

# ---------------------------------------------------------------------------
# Physics helper utilities (intentionally lightweight: NO n-body / perturbations)
# ---------------------------------------------------------------------------

def period_and_mean_motion(a_m: float, mu: float) -> Tuple[float, float]:
    """Return (orbital_period_seconds, mean_motion_rad_s)."""
    T = 2.0 * math.pi * math.sqrt(a_m ** 3 / mu)
    n = math.sqrt(mu / a_m ** 3)
    return T, n

def normalize_angle_rad(theta: float) -> float:
    twopi = 2.0 * math.pi
    return theta % twopi

def anomalies_from_position_sequence(positions: List[List[float]], e: float) -> Tuple[List[float], List[float], List[float]]:
    """Derive true, eccentric, and mean anomalies for a planar ellipse sample.

    Assumes orbit lies in (approximately) a single plane aligned with XY (current simplified case).
    This avoids modifying mechanics code to return nu directly. Adequate for hackathon scope.
    Returns lists of (nu_rad, E_rad, M_rad).
    """
    if e < 0.0 or e >= 1.0:
        return [], [], []
    true_list: List[float] = []
    ecc_list: List[float] = []
    mean_list: List[float] = []
    sqrt_fac = math.sqrt((1 - e) / (1 + e)) if e < 1 else 0.0
    for p in positions:
        x, y = p[0], p[1]
        nu = math.atan2(y, x)
        # E from nu
        if abs(e) < 1e-12:
            E = nu
        else:
            tan_half_nu = math.tan(nu / 2.0)
            # prevent overflow
            try:
                tan_half_E = sqrt_fac * tan_half_nu
                E = 2.0 * math.atan(tan_half_E)
            except Exception:
                E = nu
            E = normalize_angle_rad(E)
        M = E - e * math.sin(E)
        M = normalize_angle_rad(M)
        true_list.append(nu)
        ecc_list.append(E)
        mean_list.append(M)
    return true_list, ecc_list, mean_list

def compute_closest_approach(p1: List[List[float]], p2: List[List[float]]) -> Tuple[int, float]:
    """Return (index, distance_m) of minimum separation for synchronized samples."""
    if not p1 or not p2 or len(p1) != len(p2):
        return -1, float('nan')
    
    try:
        d = lambda a, b: (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2
        imin, dmin = min([(i, d(a,b)) for i, (a,b) in enumerate(zip(p1, p2))], key=lambda x: x[1])
    except ValueError:
            dmin = float('nan')
            imin = -1
    return imin, math.sqrt(dmin) if imin >= 0 else float('nan')


def earth_spin_metadata() -> dict:
    """Return Earth axial tilt + rotation model constants."""
    return {
        "obliquity_deg": 23.439281,          # mean obliquity (approx, J2000)
        "rotation_period_s": 86164.0905,     # sidereal day
        "prime_meridian_rad_at_epoch": 0.0   # reference; front-end can advance linearly
    }


def static_orbit(asteroid: dict):
    # Catalog gives 'a' in AU. Convert to meters for mechanics routine which expects meters.
    try:
        a_au = float(asteroid["a"])
    except (KeyError, TypeError, ValueError):
        return []
    e = float(asteroid.get("e", 0.0) or 0.0)
    i_deg = float(asteroid.get("i", 0.0) or 0.0)
    raan_deg = float(asteroid.get("om", 0.0) or 0.0)
    argp_deg = float(asteroid.get("w", 0.0) or 0.0)
    a_m = a_au * AU_METERS
    pts = m.generate_ellipse_points_shrf(a_m, e, i_deg=i_deg,
                                         raan_deg=raan_deg, argp_deg=argp_deg,
                                         num_points=1000)
    # Provide simple orbital metadata for diagnostics (AU based)
    q_au = a_au * (1 - e)
    Q_au = a_au * (1 + e)
    return {
        "points": pts,
        "orbit_meta": {
            "a_au": a_au,
            "e": e,
            "q_au": q_au,
            "Q_au": Q_au,
            "i_deg": i_deg,
            "raan_deg": raan_deg,
            "argp_deg": argp_deg,
        }
    }

def impact(data):
    """
    Calculate impact effects: crater dimensions, blast radii, casualties, seismic magnitude.
    
    Expected data keys:
    - m: mass (kg)
    - d: diameter (m) 
    - v: velocity (m/s)
    - rho: impactor density (kg/m³)
    - alpha: impact angle (degrees)
    - lat: latitude
    - lon: longitude
    """
    import api_calls as api
    
    # Extract parameters
    mass = float(data.get("m", 0))
    diameter_m = float(data.get("d", 0))
    velocity = float(data.get("v", 0))
    density_impactor = float(data.get("rho", 3000))
    impact_angle = float(data.get("alpha", 45))
    lat = float(data.get("lat", 0))
    lon = float(data.get("lon", 0))
    
    # Get terrain characteristics
    eta, rock_type, elevation = api.get_terrain_characteristics(lat, lon)
    
    # Determine target type based on rock type
    target_type_map = {
        "Unconsolidated sediments": "Unconsolidated sediments",
        "Siliciclastic sedimentary rocks": "Siliciclastic sedimentary rocks",
        "Mixed sedimentary rocks": "Mixed sedimentary rocks",
        "Carbonate sedimentary rocks": "Carbonate sedimentary rocks",
        "Metamorphics": "Metamorphic rocks",
        "Acid/Intermediate/Basic plutonic rocks": "Crystalline rocks",
        "Acid/Intermediate/Basic volcanic rocks": "Crystalline rocks",
        "Pyroclastics": "Mixed sedimentary rocks",
        "Evaporites": "Mixed sedimentary rocks",
    }
    target_type = target_type_map.get(rock_type, "Mixed sedimentary rocks")
    
    # Calculate crater dimensions
    crater_diameter, crater_depth, kinetic_energy, mass_ablation = m.crater_dimensions_advanced(
        mass, velocity, diameter_m,
        density_impactor, impact_angle,
        target_type=target_type
    )
    
    # Calculate damage radii and seismic magnitude
    coefficients_per_radius, seismic_magnitude = m.damage_coefficients_radii(kinetic_energy, eta)
    
    # Calculate tsunami if water impact
    # Check for water impact using coordinate-based detection since terrain API returns empty for water
    tsunami_data = None
    is_water_impact = (
        rock_type == "Water Bodies" or 
        not rock_type or 
        rock_type.strip() == "" or 
        api.is_coordinate_over_water(lat, lon)
    )
    
    if is_water_impact:
        # Get actual ocean depth (elevation is negative for water)
        ocean_depth_m = abs(elevation) if elevation < 0 else 3000.0  # default deep ocean
        
        tsunami_result = m.estimate_tsunami_amplitude(
            kinetic_energy, 
            impact_angle, 
            water_depth_m=ocean_depth_m
        )
        
        # Calculate meaningful coastal impact metrics
        coastal_distances = [50, 100, 200, 500, 1000]  # km from impact
        coastal_amplitudes = {}
        coastal_arrival_times = {}
        
        for dist_km in coastal_distances:
            if dist_km <= tsunami_result["attenuation_km"]:
                # Calculate amplitude at this distance
                r = max(dist_km, 1.0)  # avoid division by zero
                geom_factor = (1.0 / r) ** 0.5
                damp_factor = np.exp(-1e-3 * (r - 1.0))  # mu_km_inv = 1e-3
                amp_at_dist = tsunami_result["source_amplitude_m"] * geom_factor * damp_factor
                
                coastal_amplitudes[dist_km] = max(0.0, amp_at_dist)
                coastal_arrival_times[dist_km] = (dist_km * 1000.0) / tsunami_result["shallow_speed_m_s"] / 3600.0  # hours
        
        # Find maximum meaningful coastal amplitude
        max_coastal_amp = max(coastal_amplitudes.values()) if coastal_amplitudes else 0.0
        min_arrival_time_hrs = min(coastal_arrival_times.values()) if coastal_arrival_times else 0.0
        
        tsunami_data = {
            "source_amplitude_m": tsunami_result["source_amplitude_m"],
            "max_coastal_amplitude_m": max_coastal_amp,
            "min_coastal_arrival_hrs": min_arrival_time_hrs,
            "attenuation_km": tsunami_result["attenuation_km"],
            "shallow_speed_m_s": tsunami_result["shallow_speed_m_s"],
            "ocean_depth_m": ocean_depth_m,
            "coastal_amplitudes": coastal_amplitudes,
            "coastal_arrival_times": coastal_arrival_times
        }
    
    # Build blast zones array: [(radius_m, psi, fatality_rate, injury_rate)]
    blast_zones = []
    for (radius_m, fatality_rate, injury_rate) in coefficients_per_radius:
        # Determine PSI from fatality rate (based on the mapping in damage_coefficients_radii)
        if fatality_rate == 0.001:
            psi = 2.0
        elif fatality_rate == 0.07:
            psi = 5.0
        elif fatality_rate == 0.3:
            psi = 10.0
        elif fatality_rate == 0.7:
            psi = 20.0
        else:
            psi = 0.0
        
        blast_zones.append({
            "psi": psi,
            "radius_m": radius_m,
            "radius_km": radius_m / 1000.0 if radius_m else None,
            "fatality_rate": fatality_rate,
            "injury_rate": injury_rate
        })
    
    # Calculate casualties for each blast zone
    casualties_by_zone = []
    total_deaths = 0
    total_injuries = 0
    
    for zone in blast_zones:
        if zone["radius_km"] and zone["radius_km"] > 0:
            population = api.pop_within_radius_ghs(lat, lon, zone["radius_km"])
            deaths = population * zone["fatality_rate"]
            injuries = population * zone["injury_rate"]
            total_deaths += deaths
            total_injuries += injuries
            casualties_by_zone.append({
                "psi": zone["psi"],
                "radius_km": zone["radius_km"],
                "population": int(population),
                "deaths": int(deaths),
                "injuries": int(injuries)
            })
    
    return {
        "crater": {
            "diameter_m": crater_diameter,
            "diameter_km": crater_diameter / 1000.0,
            "depth_m": crater_depth
        },
        "blast_zones": blast_zones,
        "casualties": {
            "by_zone": casualties_by_zone,
            "total_deaths": int(total_deaths),
            "total_injuries": int(total_injuries)
        },
        "seismic": {
            "magnitude": seismic_magnitude,
            "eta": eta
        },
        "terrain": {
            "rock_type": rock_type,
            "elevation_m": elevation,
            "target_type": target_type
        },
        "impact_energy_j": kinetic_energy,
        "mass_ablation_percent": mass_ablation,
        "tsunami": tsunami_data,
        "location": {
            "lat": lat,
            "lon": lon
        }
    }

async def full_sim(data: dict):
    """Generate raw arrays for asteroid full simulation (no per-point dicts).

    Returns a JSON-serializable dict with ONLY array primitives so the frontend can
    transform as it likes:
    {
       "asteroid_id": str,
       "asteroid_positions": [[x,y,z], ...],
       "asteroid_velocities": [[vx,vy,vz], ...],
       "timestamps": [t0, t1, ...],              # seconds since periapsis
       "earth_position": [x,y,z],                # current heliocentric Earth position (approx)
       "orbit_meta": { a_au, e, q_au, Q_au, i_deg, raan_deg, argp_deg, period_seconds }
    }
    """
    asteroid: Dict[str, Any] = data
    try:
        a_au = float(asteroid.get("a"))
    except (TypeError, ValueError):
        return {"error": "missing_or_invalid_a"}
    e = float(asteroid.get("e", 0.0) or 0.0)
    i_deg = float(asteroid.get("i", 0.0) or 0.0)
    raan_deg = float(asteroid.get("om", 0.0) or 0.0)
    argp_deg = float(asteroid.get("w", 0.0) or 0.0)

    a_m = a_au * AU_METERS
    positions, velocities, times = m.generate_ellipse_timed_points_shrf(
        a_m, e, i_deg=i_deg, raan_deg=raan_deg, argp_deg=argp_deg, num_points=1000
    )

    # Flatten rounding already applied inside mechanics.
    asteroid_positions = [[p[0], p[1], p[2]] for p in positions]
    asteroid_velocities = [[v[0], v[1], v[2]] for v in velocities]
    timestamps = times  # list of floats

    # Orbital metadata (AU based) + period (seconds)
    q_au = a_au * (1 - e)
    Q_au = a_au * (1 + e)
    period_seconds, mean_motion = period_and_mean_motion(a_m, m.mu_Sun)

    # Generate Earth trajectory sampled at SAME time points as asteroid
    earth_positions = []
    earth_velocities = []
    for t in timestamps:
        pos, vel = _earth_position_at_time(t)
        earth_positions.append(pos)
        earth_velocities.append(vel)

    # Keep earth_times as the shared timestamps for consistency
    earth_times = timestamps.copy()

    # Earth orbital parameters
    earth_a_m = AU_METERS
    earth_e = 0.0167
    earth_period_seconds, earth_mean_motion = period_and_mean_motion(earth_a_m, m.mu_Sun)

    # Compute anomalies (simplified planar assumption)
    asteroid_true, asteroid_ecc, asteroid_mean = anomalies_from_position_sequence(asteroid_positions, e)
    earth_true, earth_ecc, earth_mean = anomalies_from_position_sequence(earth_positions, earth_e)

    # Shared normalized progress 0..1 for interpolation convenience
    n_samples = len(timestamps)
    progress = [i / (n_samples - 1) if n_samples > 1 else 0.0 for i in range(n_samples)]

    # Closest approach scan (synchronized samples)
    ca_index, ca_distance = compute_closest_approach(asteroid_positions, earth_positions)

    # Provide epoch reference (POSIX seconds "now") so frontend can map absolute time if desired
    epoch_now = time.time()
    # Absolute timestamps for asteroid = epoch_now + (timestamps since perihelion interpreted as synthetic)
    asteroid_absolute = [epoch_now + t for t in timestamps]
    # Earth now uses the same timestamps as asteroid for synchronization
    earth_absolute = asteroid_absolute.copy()

    # Response (backwards compatible keys preserved + enriched metadata)
    return {
        "epoch": epoch_now,
        "units": {"length": "m", "time": "s"},
        "mu_sun": m.mu_Sun,
        "asteroid_id": str(asteroid.get("spkid") or asteroid.get("id") or "unknown"),
        # Original fields (maintain):
        "asteroid_positions": asteroid_positions,
        "asteroid_velocities": asteroid_velocities,
        "timestamps": timestamps,  # original non-uniform (seconds since periapsis)
        "earth_positions": earth_positions,
        # New / enriched fields:
        "earth_velocities": earth_velocities,
        "progress": progress,  # unified normalized timeline
        "asteroid_absolute_timestamps": asteroid_absolute,
        "earth_absolute_timestamps": earth_absolute,
        "asteroid_orbit": {
            "a_au": a_au,
            "e": e,
            "q_au": q_au,
            "Q_au": Q_au,
            "i_deg": i_deg,
            "raan_deg": raan_deg,
            "argp_deg": argp_deg,
            "period_seconds": period_seconds,
            "mean_motion_rad_s": mean_motion,
            "anomalies": {
                "true_anomaly_rad": asteroid_true,
                "eccentric_anomaly_rad": asteroid_ecc,
                "mean_anomaly_rad": asteroid_mean,
            }
        },
        "earth_orbit": {
            "a_au": 1.0,
            "e": earth_e,
            "period_seconds": earth_period_seconds,
            "mean_motion_rad_s": earth_mean_motion,
            "anomalies": {
                "true_anomaly_rad": earth_true,
                "eccentric_anomaly_rad": earth_ecc,
                "mean_anomaly_rad": earth_mean,
            },
            "spin": earth_spin_metadata(),
        },
        "closest_approach": {
            "index": ca_index,
            "distance_m": ca_distance,
            "progress": progress[ca_index] if ca_index >= 0 else None,
            "asteroid_time_s": timestamps[ca_index] if ca_index >= 0 else None,
            "earth_time_s": timestamps[ca_index] if ca_index >= 0 else None,  # Same as asteroid since synchronized
        },
        # Legacy alias retained for frontend backward compatibility
        "orbit_meta": {
            "a_au": a_au,
            "e": e,
            "q_au": q_au,
            "Q_au": Q_au,
            "i_deg": i_deg,
            "raan_deg": raan_deg,
            "argp_deg": argp_deg,
            "period_seconds": period_seconds,
        }
    }


def _earth_position_at_time(time_since_periapsis_s: float) -> Tuple[List[float], List[float]]:
    """Compute Earth heliocentric position and velocity at a specific time since periapsis.

    Args:
        time_since_periapsis_s: Time in seconds since Earth's periapsis

    Returns:
        ([x, y, z], [vx, vy, vz]) in meters and m/s
    """
    a_m = AU_METERS
    e = 0.0167
    mu = m.mu_Sun

    # Orbital period
    T = 365.256363004 * 86400.0

    # Mean anomaly at this time
    M = 2.0 * math.pi * (time_since_periapsis_s / T)

    # Solve Kepler's equation for eccentric anomaly
    E = M
    for _ in range(8):
        f = E - e * math.sin(E) - M
        fp = 1 - e * math.cos(E)
        E -= f / fp

    # True anomaly
    nu = 2.0 * math.atan2(math.sqrt(1 + e) * math.sin(E / 2.0), math.sqrt(1 - e) * math.cos(E / 2.0))

    # Position in perifocal frame
    r = a_m * (1 - e * math.cos(E))
    x = r * math.cos(nu)
    y = r * math.sin(nu)
    z = 0.0

    # Velocity in perifocal frame
    p = a_m * (1 - e * e)
    h = math.sqrt(mu * p)
    vx_pf = -mu / h * math.sin(nu)
    vy_pf = mu / h * (e + math.cos(nu))
    vz_pf = 0.0

    return ([round(x, 1), round(y, 1), round(z, 1)],
            [round(vx_pf, 1), round(vy_pf, 1), round(vz_pf, 1)])


def _sample_earth_orbit(n: int) -> Tuple[list, list, list]:
    """Sample an approximate Earth orbit (positions, velocities, times) with n samples.

    Simplified: use same eccentric approximation as _earth_current_position_heliocentric
    but spread uniformly in mean anomaly over one sidereal year.
    """
    if n <= 0:
        return [], [], []
    a_m = AU_METERS
    e = 0.0167
    T = 365.256363004 * 86400.0
    positions = []
    velocities = []
    times = []
    mu = m.mu_Sun
    for idx in range(n):
        M = 2.0 * math.pi * (idx / n)
        # Newton solve for E
        E = M
        for _ in range(6):
            f = E - e * math.sin(E) - M
            fp = 1 - e * math.cos(E)
            E -= f / fp
        nu = 2.0 * math.atan2(math.sqrt(1 + e) * math.sin(E / 2.0), math.sqrt(1 - e) * math.cos(E / 2.0))
        r = a_m * (1 - e * math.cos(E))
        x = r * math.cos(nu)
        y = r * math.sin(nu)
        z = 0.0
        # perifocal velocity magnitude components (simplified planar)
        p = a_m * (1 - e * e)
        h = math.sqrt(mu * p)
        vx_pf = -mu / h * math.sin(nu)
        vy_pf = mu / h * (e + math.cos(nu))
        # For planar orbit, perifocal == inertial XY
        positions.append([round(x, 1), round(y, 1), 0.0])
        velocities.append([round(vx_pf, 1), round(vy_pf, 1), 0.0])
        times.append(round(T * (idx / n), 1))
    return positions, velocities, times
