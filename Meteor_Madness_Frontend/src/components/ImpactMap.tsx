import { useStore } from '../store';
import L, { type LeafletMouseEvent } from 'leaflet';
import { useRef, useState, useEffect, useCallback } from 'react';
import { simulateImpact, type ImpactSimulationResult } from '../services/api';

// Info icon component with legend popup
function InfoIcon() {
  const [showLegend, setShowLegend] = useState(false);
  
  return (
    <div style={{position:'relative'}}>
      <button
        onClick={() => setShowLegend(!showLegend)}
        style={{
          background: 'rgba(59, 130, 246, 0.8)',
          border: 'none',
          borderRadius: '50%',
          width: '20px',
          height: '20px',
          color: '#fff',
          fontSize: '13px',
          fontWeight: 'bold',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'serif',
          fontStyle: 'italic',
          padding: 0,
          lineHeight: 1
        }}
        title="Impact zone legend"
      >
        i
      </button>
      {showLegend && (
        <div style={{
          position: 'fixed',
          top: '50%',
          right: '315px',
          transform: 'translateY(-50%)',
          background: 'rgba(0,0,0,0.9)',
          color: '#fff',
          padding: '12px',
          borderRadius: '8px',
          fontSize: '11px',
          lineHeight: '1.4',
          minWidth: '280px',
          zIndex: 10001,
          border: '1px solid rgba(255,255,255,0.2)',
          backdropFilter: 'blur(8px)'
        }}>
          <div style={{fontWeight:'bold',marginBottom:'8px'}}>Impact Zone Legend</div>
          <div style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'4px'}}>
            <div style={{width:'12px',height:'12px',background:'#dc2626',borderRadius:'50%'}}></div>
            <span>Red Zone/Crater: complete destruction. Total vaporization at impact site. Nothing survives.</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'4px'}}>
            <div style={{width:'12px',height:'12px',background:'#8b5cf6',borderRadius:'50%'}}></div>
            <span>20psi zone: near-complete destruction. Most buildings collapse, reinforced concrete breaks, and fires are widespread. Most do not survive.</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'4px'}}>
            <div style={{width:'12px',height:'12px',background:'#ec4899',borderRadius:'50%'}}></div>
            <span>10psi zone: Severe structural failure. Reinforced concrete and steel buildings partially collapse, debris and pressure waves cause massive casualties. High risk for living beings.</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'4px'}}>
            <div style={{width:'12px',height:'12px',background:'#fbbf24',borderRadius:'50%'}}></div>
            <span>5psi zone: Moderate to heavy damage. Wooden houses and weak structures fail, vehicles overturned, widespread injuries. Can be lethal.</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
            <div style={{width:'12px',height:'12px',background:'#fb923c',borderRadius:'50%'}}></div>
            <span>2psi zone: light structural damage. Windows shatter, minor wall cracks, debris injuries common. Possible danger.</span>
          </div>
          <button
            onClick={() => setShowLegend(false)}
            style={{
              position: 'absolute',
              top: '6px',
              right: '8px',
              background: 'transparent',
              border: 'none',
              color: '#fff',
              fontSize: '14px',
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function clampLat(v: number) { return Math.max(Math.min(v, 90), -90); }
function wrapLng(v: number) { return ((v + 180) % 360 + 360) % 360 - 180; }

export function ImpactMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const { 
    customImpactLatitude, 
    customImpactLongitude, 
    simulationData, 
    setCustomImpactLocation, 
    impactParameters,
    shouldRunSimulation,
    setShouldRunSimulation,
    impactSimulationResult,
    setImpactSimulationResult
  } = useStore();
  const pulseRef = useRef<HTMLDivElement | null>(null);
  const lastClickRef = useRef<{ lat: number; lng: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [displayLat, setDisplayLat] = useState<number | null>(null);
  const [displayLng, setDisplayLng] = useState<number | null>(null);
  const settingRef = useRef(false);
  
  // Impact simulation state
  const [impactResult, setImpactResult] = useState<ImpactSimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const impactCirclesRef = useRef<L.Circle[]>([]);
  const hasSimulatedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const initLat = clampLat(customImpactLatitude ?? simulationData?.impact_estimate?.impact_location?.latitude ?? 0);
    const initLng = wrapLng(customImpactLongitude ?? simulationData?.impact_estimate?.impact_location?.longitude ?? 0);
    const map = L.map(containerRef.current, {
      center: [initLat, initLng],
      zoom: 2,
      minZoom: 2,
      worldCopyJump: true,
      attributionControl: false,
    });
    
    // Create custom pane for markers with high z-index
    const markerPane = map.createPane('impactMarkers');
    markerPane.style.zIndex = '10000';
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 8 }).addTo(map)
      .on('load', () => {
        setReady(true);
        console.log('🗺️ Map loaded and ready');
      });
    map.on('click', (e: LeafletMouseEvent) => {
      const normLat = clampLat(e.latlng.lat);
      const normLng = wrapLng(e.latlng.lng);
      settingRef.current = true;
      setCustomImpactLocation(normLat, normLng);
      setDisplayLat(normLat);
      setDisplayLng(normLng);
      settingRef.current = false;
      // Recenter softly
      map.flyTo([normLat, normLng], Math.max(map.getZoom(), 3), { animate: true });
      // Trigger pulse
      lastClickRef.current = { lat: normLat, lng: normLng };
      if (pulseRef.current) {
        // Convert geo to approximate container percentages
        const xPct = ((normLng + 180) / 360) * 100; // 0..100
        const yPct = (1 - (normLat + 90) / 180) * 100; // invert so north at top
        pulseRef.current.style.setProperty('--pulse-x', `${xPct}%`);
        pulseRef.current.style.setProperty('--pulse-y', `${yPct}%`);
        pulseRef.current.classList.remove('active');
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        pulseRef.current.offsetWidth;
        pulseRef.current.classList.add('active');
      }
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // We intentionally do not re-run initialization when simulationData impact location changes; later effect handles marker sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const latRaw = customImpactLatitude ?? simulationData?.impact_estimate?.impact_location?.latitude ?? 0;
    const lngRaw = customImpactLongitude ?? simulationData?.impact_estimate?.impact_location?.longitude ?? 0;
    const lat = clampLat(latRaw);
    const lng = wrapLng(lngRaw);
    setDisplayLat(lat);
    setDisplayLng(lng);
    if (!markerRef.current) {
      // Custom impact location marker with bright dot style
      const icon = L.divIcon({
        className: 'impact-marker',
        html: '<div class="impact-marker-core"></div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });
      markerRef.current = L.marker([lat, lng], { 
        draggable: true, 
        icon,
        pane: 'impactMarkers' // Use custom high-z-index pane
      }).addTo(map);
      
      // Debug marker creation with slight delay to ensure DOM is updated
      setTimeout(() => {
        const markerEl = markerRef.current?.getElement();
        console.log(' Marker created at:', { lat, lng });
        console.log(' Marker element:', markerEl);
        if (markerEl) {
          const styles = window.getComputedStyle(markerEl);
          console.log(' Marker styles:', {
            display: styles.display,
            visibility: styles.visibility,
            opacity: styles.opacity,
            zIndex: styles.zIndex,
            position: styles.position,
            transform: styles.transform,
            width: styles.width,
            height: styles.height
          });
          console.log('📦 Marker innerHTML:', markerEl.innerHTML);
          console.log('📍 Marker in DOM:', document.body.contains(markerEl));
        } else {
          console.error('❌ Marker element not found!');
        }
      }, 100);
      
      markerRef.current.on('dragend', () => {
        if (!markerRef.current) return;
        const pos = markerRef.current.getLatLng();
        const dLat = clampLat(pos.lat);
        const dLng = wrapLng(pos.lng);
        settingRef.current = true;
        setCustomImpactLocation(dLat, dLng);
        setDisplayLat(dLat);
        setDisplayLng(dLng);
        settingRef.current = false;
        if (Math.abs(pos.lat - dLat) > 1e-9 || Math.abs(pos.lng - dLng) > 1e-9) {
          markerRef.current!.setLatLng([dLat, dLng]);
        }
        // Pulse on drag release
        lastClickRef.current = { lat: dLat, lng: dLng };
        if (pulseRef.current) {
          const xPct = ((dLng + 180) / 360) * 100;
          const yPct = (1 - (dLat + 90) / 180) * 100;
          pulseRef.current.style.setProperty('--pulse-x', `${xPct}%`);
          pulseRef.current.style.setProperty('--pulse-y', `${yPct}%`);
          pulseRef.current.classList.remove('active');
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          pulseRef.current.offsetWidth;
          pulseRef.current.classList.add('active');
        }
      });
    } else {
      const current = markerRef.current.getLatLng();
      if (Math.abs(current.lat - lat) > 1e-9 || Math.abs(current.lng - lng) > 1e-9) {
        markerRef.current.setLatLng([lat, lng]);
      }
    }
  }, [customImpactLatitude, customImpactLongitude, simulationData, setCustomImpactLocation]);

  const handleSimulateImpact = useCallback(async () => {
    if (!displayLat || !displayLng || !mapRef.current) return;
    
    setIsSimulating(true);
    try {
      // Calculate diameter in meters from kilometers
      const diameterM = impactParameters.diameterKm * 1000;
      
      // Call backend API
      const result = await simulateImpact({
        m: impactParameters.massKg || 1e12, // fallback mass
        d: diameterM,
        v: impactParameters.entryVelocityKms * 1000, // convert km/s to m/s
        rho: 3000, // typical stony asteroid density
        alpha: impactParameters.entryAngleDeg,
        lat: displayLat,
        lon: displayLng,
      });
      
      setImpactResult(result);
      setImpactSimulationResult(result);
      
      // Debug tsunami data
      console.log(' Impact simulation result:', {
        hasTsunami: !!result.tsunami,
        tsunamiData: result.tsunami,
        terrain: result.terrain.rock_type,
        isWater: result.terrain.rock_type === 'Water Bodies',
        tsunamiKeys: result.tsunami ? Object.keys(result.tsunami) : [],
        sourceAmplitude: result.tsunami?.source_amplitude_m,
        fullResult: result
      });
      
      if (result.terrain.rock_type === 'Water Bodies') {
        console.warn(' WATER IMPACT but tsunami data:', result.tsunami);
      }
      
      // Remove old circles
      impactCirclesRef.current.forEach(circle => circle.remove());
      impactCirclesRef.current = [];
      
      // Draw impact circles with animation
      const map = mapRef.current;
      
      // Color mapping: 20psi=purple, 10psi=magenta, 5psi=yellow, 2psi=orange, crater=red
      const colorMap: Record<number, string> = {
        20: '#8b5cf6',  // purple
        10: '#ec4899',  // magenta/pink
        5: '#fbbf24',   // yellow
        2: '#fb923c',   // orange
      };
      
      // Sort zones by PSI descending so larger circles are drawn first
      const zones = [...result.blast_zones].sort((a, b) => (b.psi || 0) - (a.psi || 0));
      
      // Draw blast zones
      zones.forEach((zone, index) => {
        if (zone.radius_m && zone.radius_m > 0) {
          const circle = L.circle([displayLat, displayLng], {
            radius: zone.radius_m,
            color: colorMap[zone.psi] || '#94a3b8',
            fillColor: colorMap[zone.psi] || '#94a3b8',
            fillOpacity: 0.15,
            weight: 2,
            opacity: 0,
          }).addTo(map);
          
          // Animate circle appearance with delay
          setTimeout(() => {
            circle.setStyle({ opacity: 0.6 });
          }, index * 200);
          
          impactCirclesRef.current.push(circle);
        }
      });
      
      // Draw crater (red circle, smallest, drawn last so it's on top)
      if (result.crater.diameter_m > 0) {
        const craterCircle = L.circle([displayLat, displayLng], {
          radius: result.crater.diameter_m / 2,
          color: '#dc2626',
          fillColor: '#dc2626',
          fillOpacity: 0.3,
          weight: 3,
          opacity: 0,
        }).addTo(map);
        
        // Animate crater appearance last
        setTimeout(() => {
          craterCircle.setStyle({ opacity: 0.8 });
        }, zones.length * 200);
        
        impactCirclesRef.current.push(craterCircle);
      }
      
      // Zoom to fit all circles
      if (impactCirclesRef.current.length > 0) {
        const group = L.featureGroup(impactCirclesRef.current);
        map.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 10 });
      }
      
      console.log(' Impact simulation complete:', result);
    } catch (error) {
      console.error(' Impact simulation failed:', error);
    } finally {
      setIsSimulating(false);
    }
  }, [displayLat, displayLng, impactParameters, setImpactSimulationResult]);

  // Watch for simulation trigger from red button
  useEffect(() => {
    if (shouldRunSimulation && ready && displayLat != null && displayLng != null) {
      console.log(' Running simulation triggered by red button');
      setShouldRunSimulation(false); // Reset flag
      handleSimulateImpact();
    }
  }, [shouldRunSimulation, ready, displayLat, displayLng, handleSimulateImpact, setShouldRunSimulation]);

  return (
    <div className="impact-map-wrapper">
      <div ref={containerRef} className="impact-map-container" />
      <div ref={pulseRef} className="impact-pulse-layer" />
      {!ready && (
        <div className="map-loading-indicator">
          <span className="spinner" /> Loading map…
        </div>
      )}
      {/* Quick Stats overlay on left side of map */}
      {ready && (
        <div style={{
          position: 'absolute',
          top: 8,
          left: 8,
          background: 'rgba(0,0,0,0.75)',
          color: '#ffffff',
          fontSize: 12,
          padding: '10px 14px',
          borderRadius: 8,
          lineHeight: 1.5,
          backdropFilter: 'blur(6px)',
          zIndex: 1000,
          minWidth: 200,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <div style={{borderBottom: '2px solid rgba(59,130,246,0.5)', paddingBottom: 6, marginBottom: 8}}>
            <strong style={{fontSize: 14, color: '#60a5fa'}}> Impact Parameters</strong>
          </div>
          <div style={{display: 'grid', gap: 8, fontSize: 11.5}}>
            <div style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0'}}>
              <span style={{opacity: 0.8}}>Diameter:</span>
              <strong style={{color: '#fbbf24'}}>{impactParameters.diameterKm.toFixed(2)} km</strong>
            </div>
            <div style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0'}}>
              <span style={{opacity: 0.8}}>Mass:</span>
              <strong style={{color: '#fbbf24'}}>{impactParameters.massKg > 0 ? impactParameters.massKg.toExponential(2) + ' kg' : 'Auto'}</strong>
            </div>
            <div style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0'}}>
              <span style={{opacity: 0.8}}>Velocity:</span>
              <strong style={{color: '#fbbf24'}}>{impactParameters.entryVelocityKms.toFixed(1)} km/s</strong>
            </div>
            <div style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0'}}>
              <span style={{opacity: 0.8}}>Entry Angle:</span>
              <strong style={{color: '#fbbf24'}}>{impactParameters.entryAngleDeg}° from horizon</strong>
            </div>
          </div>
        </div>
      )}
      {ready && displayLat != null && displayLng != null && (
        <div style={{position:'absolute',bottom:8,right:8,background:'rgba(0,0,0,0.75)',color:'#ffffff',fontSize:12,padding:'10px 14px',borderRadius:8,lineHeight:1.5,backdropFilter:'blur(6px)',zIndex:1000,maxWidth:300,boxShadow:'0 4px 12px rgba(0,0,0,0.4)',border:'1px solid rgba(255,255,255,0.1)'}}>
          <strong style={{fontSize:13}}>Impact Coordinates</strong><br/>
          <div style={{marginTop:4}}>
            Lat: {displayLat.toFixed(4)}°<br/>
            Lon: {displayLng.toFixed(4)}°
          </div>
          {impactResult && (
            <>
              <hr style={{margin:'8px 0',border:'none',borderTop:'1px solid rgba(255,255,255,0.25)'}} />
              <strong style={{fontSize:13}}>Impact Stats</strong>
              <div style={{marginTop:6,display:'grid',gap:4}}>
                <div><strong>Crater:</strong> {impactResult.crater.diameter_km.toFixed(2)} km ø, {(impactResult.crater.depth_m).toFixed(0)} m deep</div>
                <div><strong>Seismic:</strong> Magnitude {impactResult.seismic.magnitude.toFixed(1)}</div>
                <div><strong>Terrain:</strong> {impactResult.terrain.rock_type}</div>
                <hr style={{margin:'6px 0',border:'none',borderTop:'1px solid rgba(255,255,255,0.15)'}} />
                <div><strong>Total Deaths:</strong> {impactResult.casualties.total_deaths.toLocaleString()}</div>
                <div><strong>Total Injuries:</strong> {impactResult.casualties.total_injuries.toLocaleString()}</div>
                <hr style={{margin:'6px 0',border:'none',borderTop:'1px solid rgba(255,255,255,0.15)'}} />
                {/* DEBUG: Show all tsunami-related data */}
                {/* <div style={{marginTop:4,marginBottom:4,padding:4,background:'rgba(128,128,128,0.2)',borderRadius:4,border:'1px dashed rgba(255,255,255,0.3)',fontSize:'9px',fontFamily:'monospace',color:'#aaa'}}>
                  DEBUG - Terrain: '{impactResult.terrain.rock_type}' (empty: {!impactResult.terrain.rock_type ? 'YES' : 'NO'})<br/>
                  Is Water Bodies: {impactResult.terrain.rock_type === 'Water Bodies' ? 'YES' : 'NO'}<br/>
                  Tsunami object: {impactResult.tsunami ? 'EXISTS' : 'NULL'}<br/>
                  {impactResult.tsunami && (
                    <>
                      amplitude: {impactResult.tsunami.source_amplitude_m}<br/>
                      attenuation: {impactResult.tsunami.attenuation_km}<br/>
                      speed: {impactResult.tsunami.shallow_speed_m_s}
                    </>
                  )}
                </div> */}
                {impactResult.tsunami && impactResult.tsunami.source_amplitude_m && impactResult.tsunami.source_amplitude_m > 0 ? (
                  <div style={{marginTop:4,marginBottom:6,padding:8,background:'linear-gradient(135deg, rgba(59,130,246,0.25) 0%, rgba(14,165,233,0.15) 100%)',borderRadius:6,border:'2px solid rgba(59,130,246,0.7)',boxShadow:'0 2px 8px rgba(59,130,246,0.3)'}}>
                    <div style={{fontSize:'13px',fontWeight:'bold',color:'#60a5fa',marginBottom:6,display:'flex',alignItems:'center',gap:6}}>
                       Tsunami Impact
                    </div>
                    <div style={{color:'#e0e7ff',fontSize:'11.5px',lineHeight:1.6}}>
                      <div style={{marginBottom:3}}><strong style={{color:'#93c5fd'}}>Wave Height:</strong> {impactResult.tsunami.source_amplitude_m ? (impactResult.tsunami.source_amplitude_m >= 1 ? impactResult.tsunami.source_amplitude_m.toFixed(1) : impactResult.tsunami.source_amplitude_m.toFixed(3)) : 'N/A'} m</div>
                      <div style={{marginBottom:3}}><strong style={{color:'#93c5fd'}}>Travel Range:</strong> {impactResult.tsunami.attenuation_km?.toFixed(0) || 'N/A'} km radius</div>
                      <div style={{marginBottom:3}}><strong style={{color:'#93c5fd'}}>Wave Speed:</strong> {impactResult.tsunami.shallow_speed_m_s?.toFixed(1) || 'N/A'} m/s</div>
                      <div><strong style={{color:'#93c5fd'}}>Ocean Depth:</strong> {impactResult.tsunami.ocean_depth_m?.toFixed(0) || 'N/A'} m</div>
                    </div>
                  </div>
                ) : impactResult.terrain.rock_type === 'Water Bodies' ? (
                  <div style={{marginTop:4,marginBottom:6,padding:6,background:'rgba(239,68,68,0.15)',borderRadius:6,border:'1px solid rgba(239,68,68,0.4)'}}>
                    <div style={{color:'#fca5a5',fontSize:'11px',marginBottom:2}}><strong> Water Impact Detected</strong></div>
                    <div style={{color:'#fca5a5',fontSize:'10px',opacity:0.8}}>Tsunami: {impactResult.tsunami ? JSON.stringify(impactResult.tsunami) : 'No data returned from backend'}</div>
                  </div>
                ) : null}
                <hr style={{margin:'6px 0',border:'none',borderTop:'1px solid rgba(255,255,255,0.15)'}} />
                <div style={{fontSize:11,opacity:0.8}}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <strong>Blast Zones:</strong>
                    <InfoIcon />
                  </div><br/>
                  {impactResult.blast_zones.map(zone => {
                    const colorMap: {[key: number]: string} = {20: '#8b5cf6', 10: '#ec4899', 5: '#fbbf24', 2: '#fb923c'};
                    const color = colorMap[zone.psi] || '#666';
                    return (
                      <div key={zone.psi} style={{marginLeft:8,display:'flex',alignItems:'center',gap:6}}>
                        <div style={{width:12,height:12,borderRadius:2,background:color,border:'1px solid rgba(255,255,255,0.3)',flexShrink:0}}></div>
                        <span>{zone.psi} psi: {zone.radius_km?.toFixed(2) ?? '—'} km</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
