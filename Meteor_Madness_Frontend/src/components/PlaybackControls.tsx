import { useMemo } from "react";
import { useStore } from "../store";

function formatSeconds(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const value = Math.abs(seconds);
  const days = Math.floor(value / 86400);
  const remDay = value % 86400;
  const hours = Math.floor(remDay / 3600);
  const minutes = Math.floor((remDay % 3600) / 60);
  const secs = Math.floor(remDay % 60);
  if (days > 0) {
    return `${sign}${days}d ${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}`;
  }
  if (hours > 0) {
    return `${sign}${hours}:${minutes.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}`;
  }
  return `${sign}${minutes}:${secs.toString().padStart(2,'0')}`;
}

export function PlaybackControls() {
  const simulationMode = useStore((state) => state.simulationMode);
  const simulationData = useStore((state) => state.simulationData);
  const playbackProgress = useStore((state) => state.playbackProgress);
  const isPlaybackPlaying = useStore((state) => state.isPlaybackPlaying);
  const setPlaybackProgress = useStore((state) => state.setPlaybackProgress);
  const setIsPlaybackPlaying = useStore((state) => state.setIsPlaybackPlaying);

  const hasFullSimulation = simulationMode === "full" && simulationData && simulationData.asteroid_trajectory.length > 0;

  const timeline = useMemo(() => {
    if (!hasFullSimulation || !simulationData) {
      return {
        label: "No timeline",
        start: 0,
        end: 1,
        duration: 1,
        hasTimestamps: false,
      } as const;
    }

    // Collect all timestamps from both asteroid and earth to show synchronized span
    const collect = (arr: typeof simulationData.asteroid_trajectory) => arr
      .map(p => p.timestamp)
      .filter((v): v is number => v !== undefined);
    const aTs = collect(simulationData.asteroid_trajectory);
    const eTs = collect(simulationData.earth_trajectory);
    const all = [...aTs, ...eTs].sort((a,b)=>a-b);
    if (all.length >= 2) {
      const start = all[0];
      const end = all[all.length-1];
      const duration = Math.max(end - start, 1);
      return { start, end, duration, hasTimestamps: true } as const;
    }

    return {
      start: 0,
      end: simulationData.asteroid_trajectory.length - 1,
      duration: Math.max(simulationData.asteroid_trajectory.length - 1, 1),
      hasTimestamps: false,
    } as const;
  }, [hasFullSimulation, simulationData]);

  if (!hasFullSimulation) {
    return null;
  }

  const sliderValue = Math.round(playbackProgress * 1000);
  const handleChange = (value: number) => {
    const clamped = Math.min(Math.max(value, 0), 1000);
    setPlaybackProgress(clamped / 1000);
  };

  const handleRestart = () => {
    setPlaybackProgress(0);
    setIsPlaybackPlaying(true);
  };

  const handlePlayPause = () => {
    // If we're at end and user hits Play again, rewind first
    if (!isPlaybackPlaying && playbackProgress >= 0.999) {
      setPlaybackProgress(0);
    }
    setIsPlaybackPlaying(!isPlaybackPlaying);
  };

  const currentRelative = playbackProgress * timeline.duration;

  return (
    <div className="playback-controls">
      <div className="transport-buttons">
        <button type="button" onClick={handlePlayPause}>
          {isPlaybackPlaying ? 'Pause' : (playbackProgress >= 0.999 ? 'Replay' : 'Play')}
        </button>
        <button type="button" onClick={handleRestart}>
          Restart
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={1000}
        value={sliderValue}
        onChange={(event) => handleChange(Number(event.target.value))}
        onMouseDown={() => setIsPlaybackPlaying(false)}
        onTouchStart={() => setIsPlaybackPlaying(false)}
      />
      <div className="timeline-labels">
        <span>{timeline.hasTimestamps ? "T0" : "Frame 0"}</span>
        <span>
          {timeline.hasTimestamps
            ? formatSeconds(currentRelative)
            : `Frame ${Math.round(playbackProgress * timeline.duration)}`}
        </span>
        <span>
          {timeline.hasTimestamps
            ? formatSeconds(timeline.duration)
            : `Frame ${Math.round(timeline.duration)}`}
        </span>
      </div>
    </div>
  );
}
