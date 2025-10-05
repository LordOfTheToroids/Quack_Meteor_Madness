import { create } from 'zustand';
import type {
  Asteroid,
  AsteroidDetails,
  SimulationData,
  SimulationMode,
  ViewMode,
  SceneView,
  ImpactParameters,
} from '../types';

interface AppState {
  // Asteroid selection
  asteroids: Asteroid[];
  selectedAsteroidId: string | null;
  asteroidDetails: AsteroidDetails | null;
  
  // Simulation data
  simulationData: SimulationData | null;
  isSimulating: boolean;
  simulationMode: SimulationMode | null;
  simulationJobId: string | null;
  viewMode: ViewMode;
  activeScene: SceneView;
  playbackProgress: number;
  isPlaybackPlaying: boolean;
  impactParameters: ImpactParameters;
  customImpactLatitude: number | null;
  customImpactLongitude: number | null;
  
  // Impact simulation
  shouldRunSimulation: boolean;
  impactSimulationResult: unknown | null;
  
  // Camera focus
  cameraFocus: 'sun' | 'earth' | 'asteroid';
  
  // Actions
  setAsteroids: (asteroids: Asteroid[]) => void;
  setSelectedAsteroidId: (id: string | null) => void;
  setAsteroidDetails: (details: AsteroidDetails | null) => void;
  setSimulationData: (data: SimulationData | null) => void;
  setIsSimulating: (isSimulating: boolean) => void;
  setSimulationMode: (mode: SimulationMode | null) => void;
  setSimulationJobId: (jobId: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setActiveScene: (scene: SceneView) => void;
  setPlaybackProgress: (progress: number) => void;
  setIsPlaybackPlaying: (isPlaying: boolean) => void;
  setCameraFocus: (focus: 'sun' | 'earth' | 'asteroid') => void;
  setImpactParameters: (params: Partial<ImpactParameters>) => void;
  setCustomImpactLocation: (latitude: number, longitude: number) => void;
  setShouldRunSimulation: (should: boolean) => void;
  setImpactSimulationResult: (result: unknown) => void;
  reset: () => void;
}

export const useStore = create<AppState>((set) => ({
  // Initial state
  asteroids: [],
  selectedAsteroidId: null,
  asteroidDetails: null,
  simulationData: null,
  isSimulating: false,
  simulationMode: null,
  simulationJobId: null,
  viewMode: 'basic',
  activeScene: 'space',
  playbackProgress: 0,
  isPlaybackPlaying: false,
  cameraFocus: 'sun',
  impactParameters: {
    diameterKm: 0.15,
    massKg: 0, // 0 means derive from diameter & assumed density until user edits
    entryAngleDeg: 45,
    entryVelocityKms: 18,
  },
  customImpactLatitude: 0,
  customImpactLongitude: 0,
  shouldRunSimulation: false,
  impactSimulationResult: null,
  
  // Actions
  setAsteroids: (asteroids) => set({ asteroids }),
  setSelectedAsteroidId: (id) => set({ selectedAsteroidId: id }),
  setAsteroidDetails: (details) => set({ asteroidDetails: details }),
  setSimulationData: (data) => set({ simulationData: data }),
  setIsSimulating: (isSimulating) => set({ isSimulating }),
  setSimulationMode: (simulationMode) => set({ simulationMode }),
  setSimulationJobId: (simulationJobId) => set({ simulationJobId }),
  setViewMode: (viewMode) => set({ viewMode }),
  setActiveScene: (activeScene) => set({ activeScene }),
  setPlaybackProgress: (playbackProgress) => set({ playbackProgress }),
  setIsPlaybackPlaying: (isPlaybackPlaying) => set({ isPlaybackPlaying }),
  setCameraFocus: (focus) => set({ cameraFocus: focus }),
  setImpactParameters: (params) =>
    set((state) => ({ impactParameters: { ...state.impactParameters, ...params } })),
  setCustomImpactLocation: (latitude, longitude) =>
    set({ customImpactLatitude: latitude, customImpactLongitude: longitude }),
  setShouldRunSimulation: (should) => set({ shouldRunSimulation: should }),
  setImpactSimulationResult: (result) => set({ impactSimulationResult: result }),
  reset: () => set({
    selectedAsteroidId: null,
    asteroidDetails: null,
    simulationData: null,
    isSimulating: false,
    simulationMode: null,
    simulationJobId: null,
    viewMode: 'basic',
    activeScene: 'space',
    playbackProgress: 0,
    isPlaybackPlaying: false,
    impactParameters: {
      diameterKm: 0.15,
      massKg: 0,
      entryAngleDeg: 45,
      entryVelocityKms: 18,
    },
    customImpactLatitude: 0,
    customImpactLongitude: 0,
  }),
}));
