import { useEffect, useMemo, useRef } from "react";
import { waveformPeaks } from "@soundlab/project";

type Props = { channels: Float32Array[]; color: string; position: number; duration: number; onSeek?: (seconds: number) => void; dim?: boolean; height?: number; label: string };

export function Waveform({ channels, color, position, duration, onSeek, dim, height = 48, label }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const peaks = useMemo(() => waveformPeaks(channels, 1200), [channels]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w) return;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const g = canvas.getContext("2d")!;
      g.scale(dpr, dpr);
      g.clearRect(0, 0, w, h);
      const n = peaks.length / 2, mid = h / 2, played = duration ? (position / duration) * w : 0;
      for (let x = 0; x < w; x++) {
        const b = Math.floor((x / w) * n);
        const lo = peaks[b * 2], hi = peaks[b * 2 + 1];
        g.fillStyle = x < played ? color : dim ? "rgba(139,147,161,0.35)" : `${color}99`;
        g.fillRect(x, mid - Math.max(0.5, hi * mid), 1, Math.max(1, (hi - lo) * mid));
      }
      g.fillStyle = "#E8EBF0";
      g.fillRect(Math.min(w - 1, played), 0, 1, h);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [peaks, color, position, duration, dim]);
  const seek = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onSeek || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };
  return <canvas ref={ref} className="wave" style={{ height }} onPointerDown={seek} role="img" aria-label={label} />;
}
