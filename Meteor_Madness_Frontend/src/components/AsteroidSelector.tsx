import { useEffect, useState, useCallback, useMemo, useRef, type ChangeEvent } from "react";
import { useStore } from "../store";
import { fetchAsteroids, simulateAsteroid, pollSimulationReport } from "../services/api";
import type { SimulationData, SimulationJobResponse, ViewMode } from "../types";

function isSimulationData(
  result: SimulationData | SimulationJobResponse,
): result is SimulationData {
  return (result as SimulationData).asteroid_trajectory !== undefined;
}

const ASTEROID_PAGE_SIZE = 200;

const clampLatitude = (value: number) => Math.max(Math.min(value, 90), -90);
const wrapLongitude = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;

export function AsteroidSelector() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [hasMoreAsteroids, setHasMoreAsteroids] = useState(true);
  const [asteroidOffset, setAsteroidOffset] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [showStats, setShowStats] = useState(false);
  const [showMitigationOptions, setShowMitigationOptions] = useState(false);
  const [showCustomImpactPanel, setShowCustomImpactPanel] = useState(true); // Always show on impact map

  const {
    asteroids,
    selectedAsteroidId,
    asteroidDetails,
    isSimulating,
    simulationMode,
  simulationData,
    simulationJobId,
    viewMode,
    activeScene,
    setAsteroids,
    setSelectedAsteroidId,
    setAsteroidDetails,
    setSimulationData,
    setIsSimulating,
    setSimulationMode,
    setSimulationJobId,
    setViewMode,
    setActiveScene,
    setPlaybackProgress,
    setIsPlaybackPlaying,
    impactParameters,
    setImpactParameters,
    setShouldRunSimulation,
    customImpactLatitude,
    customImpactLongitude,
    setCustomImpactLocation,
  } = useStore();

  // Prevent duplicate initial loads (StrictMode double mount) & rapid re-fetch loops
  const initialLoadRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const loadAsteroids = useCallback(
    async (append: boolean = false) => {
      if (inFlightRef.current) return; // Coalesce concurrent requests
      const task = (async () => {
        try {
          setLoading(true);
          setError(null);
          const offset = append ? asteroidOffset : 0;
          const response = await fetchAsteroids(ASTEROID_PAGE_SIZE, offset);
          // add mass estimates for UI
          const augmented = response.asteroids.map(a => {
            if (!a.mass && a.diameter > 0) {
              const assumedDensity = a.density && a.density > 0 ? a.density : 2500; // kg/m^3 typical stony asteroid
              try {
                const radiusM = (a.diameter * 1000) / 2;
                const volumeM3 = (4 / 3) * Math.PI * radiusM ** 3;
                const estMass = volumeM3 * assumedDensity;
                return { ...a, mass: estMass };
              } catch {
                return a;
              }
            }
            return a;
          });
          response.asteroids = augmented; // mutate local response object (safe, not reused externally)
          const nextOffset = response.offset + response.asteroids.length;
          if (append) {
            const existingIds = new Set(asteroids.map((a) => a.id));
            const merged = [
              ...asteroids,
              ...response.asteroids.filter((a) => !existingIds.has(a.id)),
            ];
            setAsteroids(merged);
            setHasMoreAsteroids(nextOffset < response.total);
          } else {
            // Only overwrite if list actually differs to reduce re-renders
            if (asteroids.length === 0 || asteroids[0].id !== response.asteroids[0]?.id) {
              setAsteroids(response.asteroids);
            }
            setHasMoreAsteroids(response.asteroids.length + response.offset < response.total);
          }
          setAsteroidOffset(nextOffset);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load asteroids");
        } finally {
          setLoading(false);
          inFlightRef.current = null;
        }
      })();
      inFlightRef.current = task;
      await task;
    },
    [asteroidOffset, asteroids, setAsteroids],
  );

  useEffect(() => {
    if (!initialLoadRef.current) {
      initialLoadRef.current = true;
      // Only auto-load if we truly have nothing cached
      if (asteroids.length === 0) {
        loadAsteroids();
      }
    }
  }, [asteroids.length, loadAsteroids]);

  useEffect(() => {
    if (viewMode !== 'scientific' && viewMode !== 'decision') {
      setShowStats(false);
    }
    if (viewMode !== 'decision') {
      setShowMitigationOptions(false);
    }
  }, [viewMode]);

  useEffect(() => {
    if (activeScene === 'impactMap') {
      setShowCustomImpactPanel(true); // Always show on impact map
    } else {
      setShowCustomImpactPanel(false);
    }
  }, [activeScene]);

  useEffect(() => {
    setShowStats(false);
    setShowMitigationOptions(false);
    setShowCustomImpactPanel(false);
  }, [selectedAsteroidId]);

  const stats = useMemo(() => {
    if (!asteroidDetails) return null;

    const diameterKm = asteroidDetails.diameter;
    if (!Number.isFinite(diameterKm) || diameterKm <= 0) {
      return null;
    }

    const radiusMeters = (diameterKm * 1000) / 2;
    const volume = (4 / 3) * Math.PI * Math.pow(radiusMeters, 3);

    const rawDensity = asteroidDetails.density;
    const density = Number.isFinite(rawDensity) && rawDensity > 0 ? rawDensity : null;

    const suppliedMass = asteroidDetails.mass;
    const mass = Number.isFinite(suppliedMass) && suppliedMass && suppliedMass > 0
      ? suppliedMass
      : density
        ? density * volume
        : null;

    const velocityKmPerS = asteroidDetails.velocity;
    const velocity = Number.isFinite(velocityKmPerS) && velocityKmPerS && velocityKmPerS > 0
      ? velocityKmPerS * 1000
      : null;

    const kineticEnergy = mass && velocity ? 0.5 * mass * velocity * velocity : null;
    const momentum = mass && velocity ? mass * velocity : null;
    const surfaceGravity = mass ? (6.6743e-11 * mass) / (radiusMeters * radiusMeters) : null;
    
    // Additional computed values
    const escapeVelocity = mass && radiusMeters ? Math.sqrt(2 * 6.6743e-11 * mass / radiusMeters) : null;
    const surfaceArea = radiusMeters ? 4 * Math.PI * radiusMeters * radiusMeters : null;
    const rotationalKE = mass && radiusMeters && asteroidDetails.rotation_period 
      ? 0.4 * mass * radiusMeters * radiusMeters * Math.pow((2 * Math.PI) / (asteroidDetails.rotation_period * 3600), 2) 
      : null;
    const albedo = asteroidDetails.albedo || null;
    const absoluteMagnitude = asteroidDetails.H || null;
    const orbitalPeriod = asteroidDetails.per ? asteroidDetails.per * 365.25 * 24 * 3600 : null; // Convert from years to seconds
    const semimajorAxis = asteroidDetails.a ? asteroidDetails.a * 1.496e11 : null; // Convert AU to meters
    const eccentricity = asteroidDetails.e || null;

    return {
      diameterKm,
      radiusMeters,
      volume,
      density,
      mass,
      velocity,
      kineticEnergy,
      momentum,
      surfaceGravity,
      escapeVelocity,
      surfaceArea,
      rotationalKE,
      albedo,
      absoluteMagnitude,
      orbitalPeriod,
      semimajorAxis,
      eccentricity,
    };
  }, [asteroidDetails]);

  const energyMegatons = useMemo(() => {
    if (!stats?.kineticEnergy) return null;
    return stats.kineticEnergy / 4.184e15;
  }, [stats]);

  const mitigationInsights = useMemo(() => {
    if (!stats) return [];

    const entries: { title: string; detail: string }[] = [];

    if (stats.momentum) {
      entries.push({
        title: 'Kinetic Impactor',
        detail: `Match at least ${stats.momentum.toExponential(2)} kg·m/s of momentum to achieve a centimetre-per-second scale deflection.`,
      });
    } else {
      entries.push({
        title: 'Kinetic Impactor',
        detail: 'need mass and velocity data to size impactor.',
      });
    }

    if (stats.mass) {
      const gentleAcceleration = 1e-5; // m/s² target drift
      const requiredForce = stats.mass * gentleAcceleration;
      entries.push({
        title: 'Gravity Tractor',
        detail: `Maintain ≈${(requiredForce / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} kN of continuous thrust for months to impart a ${gentleAcceleration.toExponential(2)} m/s² tug.`,
      });
    } else {
      entries.push({
        title: 'Gravity Tractor',
        detail: 'Mass unknown — refine composition models before sizing long-duration tractor craft.',
      });
    }

    if (energyMegatons) {
      entries.push({
        title: 'Standoff Nuclear Burst',
        detail: `Any detonation must exceed ${energyMegatons.toLocaleString('en-US', { maximumFractionDigits: 1 })} Mt TNT equivalent to rival the object’s kinetic energy.`,
      });
    } else {
      entries.push({
        title: 'Standoff Nuclear Burst',
        detail: 'Kinetic energy not yet computed — collect mass and velocity data to benchmark nuclear yield requirements.',
      });
    }

    // laser ablation thrust calc
    if (stats.mass && stats.radiusMeters) {
      // 1MW laser, 25% coupling, 3km/s exhaust
      const power = 1_000_000; // W
      const coupling = 0.25; // fraction to ablation kinetic/latent
      const effectivePower = power * coupling;
      const exhaustVelocity = 3000; // m/s
      // Thrust = P / ve (if all to kinetic of plume)
      const thrust = effectivePower / exhaustVelocity; // N
      const accel = thrust / stats.mass; // m/s^2
      // Delta-v over 1 year of continuous operation
      const dvYear = accel * 365.25 * 86400; // m/s
      entries.push({
        title: 'Laser Ablation',
        detail: `1MW laser could give ~${dvYear.toFixed(2)} m/s Δv over a year. depends on surface composition.`
      });
    } else {
      entries.push({
        title: 'Laser Ablation',
        detail: 'Need mass (or density & size) to approximate cumulative Δv from sustained surface sublimation (plume recoil).' 
      });
    }

    return entries;
  }, [stats, energyMegatons]);

  const isImpactView = activeScene === 'impactMap';
  const { diameterKm, massKg, entryAngleDeg, entryVelocityKms } = impactParameters;
  const derivedDiameterKm = asteroidDetails?.diameter && asteroidDetails.diameter > 0 ? asteroidDetails.diameter : null;
  const isDiameterOverridden = derivedDiameterKm != null && Math.abs(diameterKm - derivedDiameterKm) > 1e-6;
  const effectiveDiameterKm = isDiameterOverridden ? diameterKm : (derivedDiameterKm ?? diameterKm);
  const latitudeDisplay = customImpactLatitude ?? simulationData?.impact_estimate?.impact_location?.latitude ?? 0;
  const longitudeDisplay = customImpactLongitude ?? simulationData?.impact_estimate?.impact_location?.longitude ?? 0;

  // microStats was unused and removed to clean up the component

  const handleDiameterChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value); if (Number.isNaN(value)) return;
    setImpactParameters({ diameterKm: Math.max(0.01, Math.min(50, value)) });
  };
  const adoptAsteroidDiameter = () => {
    if (derivedDiameterKm) {
      setImpactParameters({ diameterKm: derivedDiameterKm });
    }
  };
  const clearDiameterOverride = () => {
    if (derivedDiameterKm) {
      // Snap back to asteroid diameter
      setImpactParameters({ diameterKm: derivedDiameterKm });
    } else {
      setImpactParameters({ diameterKm: 0.15 });
    }
  };
  const handleMassChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value); if (Number.isNaN(value)) return;
    setImpactParameters({ massKg: Math.max(0, Math.min(1e15, value)) });
  };
  const handleAngleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value); if (Number.isNaN(value)) return;
    setImpactParameters({ entryAngleDeg: Math.max(5, Math.min(90, value)) });
  };
  const handleVelocityChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value); if (Number.isNaN(value)) return;
    setImpactParameters({ entryVelocityKms: Math.max(5, Math.min(72, value)) });
  };

  // Auto-fill from asteroid when selected (one-time per selection unless user overrides)
  useEffect(() => {
    if (!asteroidDetails) return;
  const updated: Partial<typeof impactParameters> = {};
    if (asteroidDetails.diameter && asteroidDetails.diameter > 0 && (!diameterKm || Math.abs(diameterKm - 0.15) < 1e-6)) {
      updated.diameterKm = asteroidDetails.diameter;
    }
    if (asteroidDetails.mass && asteroidDetails.mass > 0 && massKg === 0) {
      updated.massKg = asteroidDetails.mass;
    }
    if (Object.keys(updated).length) {
      setImpactParameters(updated);
    }
  }, [asteroidDetails, diameterKm, massKg, setImpactParameters, impactParameters]);

  const handleLatitudeInput = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (Number.isNaN(value)) return;
    const clamped = clampLatitude(value);
    setCustomImpactLocation(clamped, customImpactLongitude ?? 0);
  };

  const handleLongitudeInput = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (Number.isNaN(value)) return;
    const wrapped = wrapLongitude(value);
    setCustomImpactLocation(customImpactLatitude ?? 0, wrapped);
  };

  const handleAsteroidSelect = async (asteroidId: string) => {
    // deselect
    if (!asteroidId) {
      setSelectedAsteroidId(null);
      setAsteroidDetails(null);
      setSimulationData(null);
      setSimulationMode(null);
      setSimulationJobId(null);
      setPlaybackProgress(0);
      setIsPlaybackPlaying(false);
      return;
    }

    // Reset simulation related state
    setError(null);
    setSimulationData(null);
    setSimulationMode(null);
    setSimulationJobId(null);
    setPlaybackProgress(0);
    setIsPlaybackPlaying(false);
  setSelectedAsteroidId(asteroidId);

    // Find asteroid in cached list
    const cached = asteroids.find(a => a.id === asteroidId);
    if (!cached) {
      // not in cache, show error
      setError("Asteroid not found in cache");
      setAsteroidDetails(null);
      return;
    }

    // calc mass if missing
    let mass = cached.mass;
    if ((!mass || mass <= 0) && cached.density > 0 && cached.diameter > 0) {
      try {
        const radiusM = (cached.diameter * 1000) / 2;
        const volumeM3 = (4 / 3) * Math.PI * radiusM ** 3;
        mass = volumeM3 * cached.density; // density expected kg/m^3
      } catch {
        // ignore
      }
    }

    setAsteroidDetails({ ...cached, mass });
    setIsPickerOpen(false);

    // run preview sim
    try {
      setIsSimulating(true);
      setSimulationMode('preview');
      const result = await simulateAsteroid(asteroidId, 'preview');
      if (isSimulationData(result)) {
        setSimulationData(result);
        setPlaybackProgress(0);
        setIsPlaybackPlaying(false);
      }
    } catch (e) {
      // just log it, whatever
      console.warn('Auto preview failed', e);
      setSimulationMode(null);
    } finally {
      setIsSimulating(false);
    }
  };

  // debounce search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(searchTerm), 180);
    return () => clearTimeout(h);
  }, [searchTerm]);

  const filteredAsteroids = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return asteroids;
    return asteroids.filter((a) =>
      a.name.toLowerCase().includes(term) || a.id.toLowerCase().includes(term),
    );
  }, [asteroids, debouncedSearch]);

  const renderDetails = (mode: ViewMode) => {
    if (!asteroidDetails) return null;

    const safeDiameter = Number.isFinite(asteroidDetails.diameter) ? asteroidDetails.diameter : 0;
    const base = (
      <>
        <p><strong>Name:</strong> {asteroidDetails.name}</p>
        <p><strong>ID:</strong> {asteroidDetails.id}</p>
        {safeDiameter > 0 && (
          <p><strong>Diameter:</strong> {safeDiameter.toFixed(2)} km</p>
        )}
      </>
    );

    if (mode === 'basic') {
      return (
        <>
          {base}
          {asteroidDetails.mass !== undefined && asteroidDetails.mass > 0 && (
            <p><strong>Mass:</strong> {asteroidDetails.mass.toExponential(2)} kg</p>
          )}
          {asteroidDetails.velocity !== undefined && Number.isFinite(asteroidDetails.velocity) && (
            <p><strong>Velocity:</strong> {asteroidDetails.velocity.toFixed(2)} km/s</p>
          )}

        </>
      );
    }

    return (
      <>
        {base}
        {asteroidDetails.density !== undefined && asteroidDetails.density > 0 && (
          <p><strong>Density:</strong> {asteroidDetails.density.toLocaleString('en-US', { maximumFractionDigits: 0 })} kg/m³</p>
        )}
        {asteroidDetails.mass !== undefined && asteroidDetails.mass > 0 && (
          <p><strong>Mass:</strong> {asteroidDetails.mass.toExponential(2)} kg</p>
        )}
        {asteroidDetails.velocity !== undefined && Number.isFinite(asteroidDetails.velocity) && (
          <p><strong>Velocity:</strong> {asteroidDetails.velocity.toFixed(2)} km/s</p>
        )}
        {asteroidDetails.albedo !== undefined && Number.isFinite(asteroidDetails.albedo) && (
          <p><strong>Albedo:</strong> {asteroidDetails.albedo.toFixed(3)}</p>
        )}
        {asteroidDetails.rotation_period !== undefined && Number.isFinite(asteroidDetails.rotation_period) && (
          <p><strong>Rotation Period:</strong> {asteroidDetails.rotation_period.toFixed(2)} h</p>
        )}
        {asteroidDetails.spectral_type && (
          <p><strong>Spectral Type:</strong> {asteroidDetails.spectral_type}</p>
        )}
      </>
    );
  };

  const handleFullSimulation = async () => {
    if (!selectedAsteroidId) return;

    try {
      setIsSimulating(true);
      setError(null);
      setSimulationData(null);
      setSimulationMode('full');
      const result = await simulateAsteroid(selectedAsteroidId, 'full');

      if ('job_id' in result) {
        setSimulationJobId(result.job_id);
        const simulationData = await pollSimulationReport(result.job_id, {
          interval: 2000,
          timeout: 180_000,
        });
        setSimulationData(simulationData);
        setSimulationJobId(null);
        setPlaybackProgress(0);
        setIsPlaybackPlaying(true);
      } else if (isSimulationData(result)) {
        // server sent data immediately
        setSimulationData(result);
        setSimulationJobId(null);
        setPlaybackProgress(0);
        setIsPlaybackPlaying(true);
      } else {
        throw new Error('Unexpected response from full simulation');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run full simulation");
      setSimulationMode(null);
      setSimulationJobId(null);
      setPlaybackProgress(0);
      setIsPlaybackPlaying(false);
    } finally {
      setIsSimulating(false);
    }
  };

  const handleSwitchToImpactMap = () => {
    setActiveScene('impactMap');
  };

  const handleReturnToSpace = () => {
    setActiveScene('space');
  };

  const statsPanel = showStats ? (
    <div className="data-panel stats-panel" role="region" aria-live="polite">
      <h4>Astrodynamics Snapshot</h4>
      {stats ? (
        <ul className="metric-list">
          <li>
            <strong>Diameter:</strong> {stats.diameterKm.toLocaleString('en-US', { maximumFractionDigits: 2 })} km
          </li>
          <li>
            <strong>Volume:</strong> {stats.volume ? (stats.volume / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'} km³
          </li>
          <li>
            <strong>Mass:</strong> {stats.mass ? `${stats.mass.toExponential(2)} kg` : 'Awaiting density / mass data'}
          </li>
          {(stats.density || (stats.mass && stats.volume)) && (
          <li>
            <strong>Density:</strong> {stats.density ? `${stats.density.toLocaleString('en-US', { maximumFractionDigits: 0 })} kg/m³` : stats.mass && stats.volume ? `${(stats.mass / stats.volume).toLocaleString('en-US', { maximumFractionDigits: 0 })} kg/m³` : '—'}
            {!stats.density && stats.mass && stats.volume && (
              <span className="secondary-reading"> (calculated from mass/volume)</span>
            )}
          </li>
          )}
          {(stats.velocity || (stats.semimajorAxis && stats.mass)) && (
          <li>
            <strong>Orbital Velocity:</strong> {stats.velocity ? `${(stats.velocity / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} km/s` : stats.semimajorAxis ? `${Math.sqrt(1.327e20 / stats.semimajorAxis / 1000).toFixed(1)} km/s` : '—'}
            {!stats.velocity && stats.semimajorAxis && (
              <span className="secondary-reading"> (orbital avg)</span>
            )}
          </li>
          )}
          {stats.momentum && (
          <li>
            <strong>Momentum:</strong> {stats.momentum.toExponential(2)} kg·m/s
          </li>
          )}
          {stats.kineticEnergy && (
          <li>
            <strong>Kinetic Energy:</strong> {stats.kineticEnergy.toExponential(2)} J
            {energyMegatons && (
              <span className="secondary-reading"> (~{energyMegatons.toLocaleString('en-US', { maximumFractionDigits: 2 })} Mt)</span>
            )}
          </li>
          )}
          <li>
            <strong>Surface Gravity:</strong> {stats.surfaceGravity ? `${stats.surfaceGravity.toFixed(3)} m/s²` : 'Needs mass estimate'}
            {stats.surfaceGravity && (
              <span className="secondary-reading"> ({(stats.surfaceGravity / 9.81).toFixed(2)}× Earth gravity)</span>
            )}
          </li>
          <li>
            <strong>Escape Velocity:</strong> {stats.escapeVelocity ? `${(stats.escapeVelocity / 1000).toFixed(2)} km/s` : 'Needs mass estimate'}
          </li>
          <li>
            <strong>Surface Area:</strong> {stats.surfaceArea ? `${(stats.surfaceArea / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })} km²` : 'Calculated from diameter'}
          </li>
          {stats.rotationalKE && (
            <li>
              <strong>Rotational Energy:</strong> {stats.rotationalKE.toExponential(2)} J
              <span className="secondary-reading"> (spin energy)</span>
            </li>
          )}
          {stats.albedo && (
            <li>
              <strong>Albedo:</strong> {stats.albedo.toFixed(3)}
              <span className="secondary-reading"> ({(stats.albedo * 100).toFixed(1)}% reflectivity)</span>
            </li>
          )}
          {stats.absoluteMagnitude && (
            <li>
              <strong>Absolute Magnitude:</strong> H = {stats.absoluteMagnitude.toFixed(1)}
              <span className="secondary-reading"> (brightness at 1 AU)</span>
            </li>
          )}
          {stats.orbitalPeriod && (
            <li>
              <strong>Orbital Period:</strong> {(stats.orbitalPeriod / (365.25 * 24 * 3600)).toFixed(2)} years
            </li>
          )}
          {stats.semimajorAxis && (
            <li>
              <strong>Semi-major Axis:</strong> {(stats.semimajorAxis / 1.496e11).toFixed(3)} AU
            </li>
          )}
          {stats.eccentricity && (
            <li>
              <strong>Eccentricity:</strong> {stats.eccentricity.toFixed(4)}
              <span className="secondary-reading"> ({stats.eccentricity < 0.1 ? 'nearly circular' : stats.eccentricity < 0.5 ? 'elliptical' : 'highly elliptical'})</span>
            </li>
          )}
        </ul>
      ) : (
        <div className="metric-placeholder">
          <p><strong>Select an asteroid to view:</strong></p>
          <ul style={{margin: '0.5rem 0', paddingLeft: '1.2rem', fontSize: '0.9rem', color: '#bbb'}}>
            <li>Physical properties (size, mass, density)</li>
            <li>Orbital characteristics (period, eccentricity)</li>
            <li>Energy calculations (kinetic, rotational)</li>
            <li>Surface conditions (gravity, escape velocity)</li>
            <li>Optical properties (albedo, magnitude)</li>
          </ul>
        </div>
      )}
    </div>
  ) : null;

  const mitigationPanel = showMitigationOptions ? (
    <div className="data-panel mitigation-panel" role="region" aria-live="polite">
      <h4>Mitigation Strategies</h4>
      <ul className="insight-list">
        {mitigationInsights.map((item) => (
          <li key={item.title}>
            <span className="insight-title">{item.title}</span>
            <span className="insight-detail">{item.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  const customImpactPanel = showCustomImpactPanel ? (
    <div className="data-panel custom-impact-panel" role="region" aria-live="polite">
      <h4>Custom Impact Setup</h4>
      <button
        type="button"
        onClick={() => {
          if (customImpactLatitude != null && customImpactLongitude != null) {
            console.log('impact button clicked:', { 
              lat: customImpactLatitude, 
              lng: customImpactLongitude,
              parameters: impactParameters
            });
            
            // Navigate to impact map and signal it should run simulation
            setActiveScene('impactMap');
            setShouldRunSimulation(true);
          } else {
            console.warn('no coordinates set');
          }
        }}
        disabled={customImpactLatitude == null || customImpactLongitude == null}
        style={{
          width: '100%',
          padding: '10px 16px',
          marginBottom: '16px',
          fontSize: '14px',
          fontWeight: 600,
          color: '#fff',
          background: 'linear-gradient(135deg, rgba(180, 40, 40, 0.85) 0%, rgba(140, 30, 30, 0.9) 100%)',
          border: '1px solid rgba(200, 60, 60, 0.5)',
          borderRadius: '6px',
          cursor: customImpactLatitude != null && customImpactLongitude != null ? 'pointer' : 'not-allowed',
          opacity: customImpactLatitude != null && customImpactLongitude != null ? 1 : 0.5,
          transition: 'all 0.2s ease'
        }}
        onMouseEnter={(e) => {
          if (customImpactLatitude != null && customImpactLongitude != null) {
            e.currentTarget.style.background = 'linear-gradient(135deg, rgba(200, 50, 50, 0.9) 0%, rgba(160, 35, 35, 0.95) 100%)';
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'linear-gradient(135deg, rgba(180, 40, 40, 0.85) 0%, rgba(140, 30, 30, 0.9) 100%)';
        }}
      >
        Simulate Impact
      </button>
      <div className="slider-group">
        <div className="slider-control">
          <label htmlFor="diameter-slider">
            <span>Diameter {isDiameterOverridden && <em style={{fontStyle:'normal',color:'#ffb347'}} title="User override active">(override)</em>}</span>
            <span>{effectiveDiameterKm.toFixed(2)} km</span>
          </label>
          <input
            id="diameter-slider"
            type="range"
            min={0.01}
            max={50}
            step={0.01}
            value={diameterKm}
            onChange={handleDiameterChange}
          />
          <div className="override-buttons" style={{display:'flex',gap:'0.5rem',marginTop:'0.4rem'}}>
            <button type="button" onClick={adoptAsteroidDiameter} disabled={!derivedDiameterKm} style={{flex:1}}>
              Adopt Source
            </button>
            <button type="button" onClick={clearDiameterOverride} style={{flex:1}}>
              Reset
            </button>
          </div>
        </div>
        <div className="slider-control">
          <label htmlFor="mass-slider">
            <span>Mass (override)</span>
            <span>{massKg > 0 ? massKg.toExponential(2) : stats?.mass ? stats.mass.toExponential(2) : '—'} kg</span>
          </label>
          <input
            id="mass-slider"
            type="range"
            min={0}
            max={1e15}
            step={1e9}
            value={massKg}
            onChange={handleMassChange}
          />
        </div>
        <div className="slider-control">
          <label htmlFor="angle-slider">
            <span>Entry Angle</span>
            <span>{entryAngleDeg.toFixed(0)}°</span>
          </label>
          <input
            id="angle-slider"
            type="range"
            min={5}
            max={90}
            step={1}
            value={entryAngleDeg}
            onChange={handleAngleChange}
          />
        </div>
        <div className="slider-control">
          <label htmlFor="velocity-slider">
            <span>Entry Velocity</span>
            <span>{entryVelocityKms.toFixed(1)} km/s</span>
          </label>
          <input
            id="velocity-slider"
            type="range"
            min={5}
            max={72}
            step={0.1}
            value={entryVelocityKms}
            onChange={handleVelocityChange}
          />
        </div>
      </div>
      <div className="coordinate-readout">
        <label htmlFor="impact-latitude">
          Latitude (°)
          <input
            id="impact-latitude"
            type="number"
            min={-90}
            max={90}
            step={0.1}
            value={(latitudeDisplay ?? 0).toFixed(2)}
            onChange={handleLatitudeInput}
          />
        </label>
        <label htmlFor="impact-longitude">
          Longitude (°)
          <input
            id="impact-longitude"
            type="number"
            min={-180}
            max={180}
            step={0.1}
            value={(longitudeDisplay ?? 0).toFixed(2)}
            onChange={handleLongitudeInput}
          />
        </label>
      </div>
      <p className="panel-footnote">Tap the map or drag the marker to update the strike location with real-world coordinates.</p>
    </div>
  ) : null;

  const simulationStatusPanel = simulationMode === 'full' ? (
    <div className="info">
      {simulationJobId
        ? <>Full sim in progress — job <strong>{simulationJobId}</strong>.</>
        : 'Full simulation ready.'}
    </div>
  ) : null;

  if (isImpactView) {
    return (
      <div className="asteroid-selector impact-mode">
        <div className="selector-header">
          <img className="brand-mark" src="/Quack_Meteor.png" alt="Quack Meteor" />
          <div>
            <h2>Impact Planner</h2>
            <p>Configure Earth impact scenarios.</p>
          </div>
        </div>
        {error && <div className="error">{error}</div>}

        <div className="impact-mode-dashboard">
          <div className="impact-mode-actions">
            <button
              type="button"
              className="panel-toggle return-btn"
              onClick={handleReturnToSpace}
            >
              Return to 3D View
            </button>
            {/* Custom Impact Setup now shown by default on impact map */}
            {viewMode === 'decision' && (
              <button
                type="button"
                className="panel-toggle mitigation-btn"
                onClick={() => setShowMitigationOptions((prev) => !prev)}
                disabled={!asteroidDetails}
                aria-expanded={showMitigationOptions}
              >
                {showMitigationOptions ? 'Hide Mitigation Options' : 'Mitigation Playbook'}
              </button>
            )}
            {viewMode === 'decision' && !showMitigationOptions && (
              <p className="info warning mitigation-note" style={{marginTop:'0.5rem', maxWidth:'340px'}}>
                Mitigation Playbook (kinetic, gravity tractor, laser ablation, nuclear) is descriptive only for now — interactive parameter simulation coming soon.
              </p>
            )}
          </div>

          {/* Quick Stats moved to map overlay */}
        </div>

        {customImpactPanel}
        {statsPanel}
        {mitigationPanel}
        {simulationStatusPanel}
      </div>
    );
  }

  return (
    <div className="asteroid-selector">
      <div className="selector-header layout-with-stats">
        <img className="brand-mark" src="/Quack_Meteor.png" alt="Quack Meteor" />
        <div className="selector-head-main">
          <h2>Mission Console</h2>
          <p>Choose the desired mode:</p>
          <div className="mode-toggle" role="group" aria-label="Display mode" style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
            {(
              [
                { label: 'Basic', value: 'basic' },
                { label: 'Scientific', value: 'scientific' },
                { label: 'Mitigation', value: 'decision' },
              ] as { label: string; value: ViewMode }[]
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={viewMode === option.value ? 'active' : ''}
                onClick={() => setViewMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {(viewMode === 'scientific' || viewMode === 'decision') && (
            <div className="inline-stats-actions">
              <button
                type="button"
                className="panel-toggle stats-btn"
                onClick={() => setShowStats((prev) => !prev)}
                disabled={!asteroidDetails}
                aria-expanded={showStats}
              >
                {showStats ? 'Hide Mission Stats' : 'Show Mission Stats'}
              </button>
            </div>
          )}
        </div>
      </div>

      {showStats && (viewMode === 'scientific' || viewMode === 'decision') && (
        <div
          className="side-stats-panel"
          style={{
            position: 'fixed',
            top: '1rem',
            left: '24rem',
            width: '300px',
            maxHeight: 'calc(100vh - 2rem)',
            overflowY: 'auto',
            background: 'rgba(10,22,34,0.82)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            border: '1px solid rgba(90,140,200,0.35)',
            boxShadow: '0 4px 14px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04) inset',
            padding: '0.85rem 0.9rem 1rem 0.9rem',
            borderRadius: '10px',
            zIndex: 1200,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem'
          }}
        >
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'0.35rem'}}>
            <h4 style={{margin:0, fontSize:'0.95rem', letterSpacing:'0.5px', color:'#d9edff'}}>Mission Stats</h4>
            <button
              type="button"
              onClick={() => setShowStats(false)}
              style={{
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#eaf6ff',
                fontSize: '0.65rem',
                padding: '0.3rem 0.55rem',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >CLOSE</button>
          </div>
          <div style={{flex:1}}>
            {statsPanel}
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="picker-trigger">
        <button
          type="button"
          className="open-picker-btn"
          onClick={() => {
            if (!asteroids.length && !loading) {
              void loadAsteroids(false);
            }
            setIsPickerOpen(true);
          }}
          disabled={loading}
        >
          {selectedAsteroidId && asteroidDetails
            ? `Current selection: ${asteroidDetails.name}`
            : "Choose an asteroid"}
        </button>
        <p className="picker-hint">2,000+ catalogue entries, search or scroll to pick your target.</p>
      </div>

      {isPickerOpen && (
        <div 
          className="asteroid-picker-overlay" 
          role="dialog" 
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setIsPickerOpen(false);
            }
          }}
        >
          <div className="asteroid-picker">
            <div className="picker-header">
              <div>
                <h3>Select an Asteroid</h3>
                <p>Tap an entry to load its dossier.</p>
              </div>
              <button
                type="button"
                className="close-picker-btn"
                onClick={() => setIsPickerOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="picker-search">
              <input
                type="search"
                placeholder="Search by name or ID"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                aria-label="Search asteroids"
              />
            </div>

            <div className="picker-list" role="listbox" aria-label="Asteroid catalog">
              {filteredAsteroids.map((asteroid) => (
                <button
                  key={asteroid.id}
                  type="button"
                  className={`picker-item ${selectedAsteroidId === asteroid.id ? "selected" : ""}`}
                  onClick={() => handleAsteroidSelect(asteroid.id)}
                >
                  <span className="picker-item-name">{asteroid.name}</span>
                  <span className="picker-item-meta">
                    <span title="Asteroid ID">#{asteroid.id}</span>
                    {asteroid.diameter > 0 && (
                      <span>{asteroid.diameter.toFixed(1)} km</span>
                    )}
                    {asteroid.mass && asteroid.mass > 0 && (
                      <span title="Estimated Mass">{asteroid.mass.toExponential(2)} kg</span>
                    )}
                  </span>
                </button>
              ))}
              {!filteredAsteroids.length && (
                <p className="picker-empty">No asteroids match that search yet.</p>
              )}
            </div>

            <div className="picker-footer">
              {hasMoreAsteroids ? (
                <button
                  type="button"
                  className="load-more-btn"
                  onClick={() => void loadAsteroids(true)}
                  disabled={loading}
                >
                  {loading ? "Loading manifest..." : "Load more asteroids"}
                </button>
              ) : (
                <span className="catalog-complete">Full catalog cached.</span>
              )}
              <button
                type="button"
                className="close-picker-btn secondary"
                onClick={() => setIsPickerOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {asteroidDetails && (
        <div className="asteroid-details">
          <h3>Details</h3>
          {renderDetails(viewMode)}
        </div>
      )}

      <div className="action-buttons">
        <button
          className="plot-orbit-btn"
          onClick={handleFullSimulation}
          disabled={!selectedAsteroidId || isSimulating || loading}
        >
          {isSimulating && simulationMode === 'full' ? "Running Full Sim..." : "Run Full Simulation"}
        </button>
        <button
          className="map-2d-btn prominent"
          onClick={handleSwitchToImpactMap}
          style={{
            marginTop: '0.85rem',
            padding: '0.85rem 1.1rem',
            fontWeight: 600,
            background: 'linear-gradient(135deg, #1d3b64 0%, #255b8f 60%, #2f7ab8 100%)',
            color: '#f2f9ff',
            border: '1px solid #2a6ea3',
            boxShadow: '0 2px 6px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.04) inset',
            letterSpacing: '0.4px',
            borderRadius: '6px',
            position: 'relative'
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.filter = 'brightness(1.15)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.filter = 'none'; }}
        >
          Open Impact Map
        </button>
        {viewMode === 'decision' && (
          <>
            <button
              type="button"
              className="panel-toggle mitigation-btn"
              onClick={() => setShowMitigationOptions((prev) => !prev)}
              disabled={!asteroidDetails}
              aria-expanded={showMitigationOptions}
              style={{
                backgroundColor: '#f39c12',
                color: '#fff',
                borderColor: '#e67e22',
                marginTop: '0.5rem',
                padding: '0.75rem 1rem',
                fontWeight: 600,
                borderRadius: '6px'
              }}
            >
              {showMitigationOptions ? 'Hide Mitigation' : 'Mitigation Playbook'}
            </button>
            {!asteroidDetails && (
              <p className="info" style={{marginTop:'0.5rem', fontSize:'0.85rem', color:'#ffcc80', opacity:0.9}}>
                💡 Select an asteroid first to unlock mitigation strategies
              </p>
            )}
          </>
        )}
      </div>

      {/* statsPanel now optionally floated in header; mitigate panel still inline below */}
      {mitigationPanel}
      {simulationStatusPanel}
    </div>
  );
}
