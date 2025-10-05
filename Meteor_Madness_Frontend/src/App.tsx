import './App.css'
import { AsteroidSelector } from './components/AsteroidSelector'
import { Scene } from './components/Scene'
import { PlaybackControls } from './components/PlaybackControls'
import { ImpactMap } from './components/ImpactMap'
import { useStore } from './store'
import { useEffect, useState } from 'react';

function App() {
  const { cameraFocus, setCameraFocus, activeScene, simulationMode, simulationData } = useStore();
  const [showScale, setShowScale] = useState(true);
  useEffect(() => {
    const t = setTimeout(()=>setShowScale(false), 12000);
    return ()=> clearTimeout(t);
  }, []);

  return (
    <div className="app-container">
      <aside className="sidebar">
        <AsteroidSelector />
        
        {activeScene === 'space' && (
        <div className="camera-controls">
          <h3>Camera Focus</h3>
          <div className="focus-buttons" style={{display:'flex', gap:'0.4rem'}}>
            <button
              className={cameraFocus === 'sun' ? 'active' : ''}
              onClick={() => setCameraFocus('sun')}
            >Sun</button>
            <button
              className={cameraFocus === 'earth' ? 'active' : ''}
              onClick={() => setCameraFocus('earth')}
            >Earth</button>
            <button
              disabled={simulationMode !== 'full' || !simulationData}
              className={cameraFocus === 'asteroid' ? 'active' : ''}
              onClick={() => { if (simulationMode === 'full' && simulationData) setCameraFocus('asteroid'); }}
              title={simulationMode === 'full' ? 'Focus asteroid' : 'Run full simulation to enable'}
            >
              Asteroid
              {(simulationMode !== 'full' || !simulationData) && (
                <span style={{display:'block', fontSize:'0.55rem', opacity:0.6, marginTop:'2px', letterSpacing:'0.5px'}}>
                  only in full sim
                </span>
              )}
            </button>
          </div>
        </div>
        )}
      </aside>
      
      <main className="scene-container">
        {activeScene === 'space' ? <Scene /> : <ImpactMap />}
        {activeScene === 'space' && <PlaybackControls />}
        {activeScene === 'space' && showScale && (
          <div style={{position:'absolute',left:12,bottom:12,padding:'6px 10px',background:'rgba(0,0,0,0.55)',color:'#e5ecf4',fontSize:'12px',maxWidth:340,lineHeight:1.3,borderRadius:6,backdropFilter:'blur(3px)'}}>
            Everything looks tiny because distances and sizes are to scale (astronomical). This is intentional for educational accuracy.
            <button onClick={()=>setShowScale(false)} style={{marginLeft:8,fontSize:11,padding:'2px 6px',cursor:'pointer'}}>x</button>
          </div>
        )}
        {/* Full sim overlay moved into Scene for consistency */}
      </main>
    </div>
  )
}

export default App
