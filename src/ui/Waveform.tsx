import { useEffect, useMemo, useRef, useState } from "react";
import { waveformPeaks } from "@soundlab/project";

export type Selection = { start: number; end: number }; // seconds

type Props = {
  channels: Float32Array[];
  color: string;
  position: number;
  duration: number;
  label: string;
  onSeek?: (seconds: number) => void;
  // When given, dragging selects a range; a plain click still seeks.
  onSelect?: (s: Selection | null) => void;
  selection?: Selection | null;
  dim?: boolean;
  height?: number;
};

const MIN_DRAG_PX = 5;

export function Waveform({ channels, color, position, duration, label, onSeek, onSelect, selection, dim, height = 64 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const peaks = useMemo(() => waveformPeaks(channels, 1600), [channels]);
  const [drag, setDrag] = useState<{ x0: number; t0: number; t1: number; moved: boolean } | null>(null);
  const shown = drag?.moved ? { start: Math.min(drag.t0, drag.t1), end: Math.max(drag.t0, drag.t1) } : selection;

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
      const x = (t: number) => (duration ? (t / duration) * w : 0);
      if (shown) {
        g.fillStyle = "rgba(245,165,36,0.14)";
        g.fillRect(x(shown.start), 0, x(shown.end) - x(shown.start), h);
        g.fillStyle = "rgba(245,165,36,0.8)";
        g.fillRect(x(shown.start), 0, 1, h); g.fillRect(x(shown.end) - 1, 0, 1, h);
      }
      g.fillStyle = "rgba(255,255,255,0.06)";
      g.fillRect(0, h / 2, w, 1);
      const n = peaks.length / 2, mid = h / 2, played = x(position);
      for (let px = 0; px < w; px++) {
        const b = Math.floor((px / w) * n);
        const lo = peaks[b * 2], hi = peaks[b * 2 + 1];
        if (hi - lo < 1e-4) continue; // silence: draw nothing, so empty stretches read as empty
        g.globalAlpha = dim ? 0.3 : px < played ? 1 : 0.7;
        g.fillStyle = color;
        g.fillRect(px, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
      }
      g.globalAlpha = 1;
      g.fillStyle = "#E8EBF0";
      g.fillRect(Math.min(w - 1, played), 0, 1, h);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [peaks, color, position, duration, dim, shown?.start, shown?.end]);

  const timeAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
  };
  return (
    <canvas
      ref={ref}
      className={`wave${onSelect ? " selectable" : ""}`}
      style={{ height }}
      role="img"
      aria-label={label}
      onPointerDown={(e) => {
        if (!duration) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const t = timeAt(e);
        setDrag({ x0: e.clientX, t0: t, t1: t, moved: false });
      }}
      onPointerMove={(e) => {
        if (!drag || !onSelect) return;
        setDrag({ ...drag, t1: timeAt(e), moved: drag.moved || Math.abs(e.clientX - drag.x0) > MIN_DRAG_PX });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        if (drag.moved && onSelect) onSelect({ start: Math.min(drag.t0, drag.t1), end: Math.max(drag.t0, drag.t1) });
        else onSeek?.(timeAt(e));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    />
  );
}

// Time ruler above the lanes; labels at a spacing that stays readable at any width.
export function Ruler({ duration, position, onSeek }: { duration: number; position: number; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => (s / Math.max(duration, 1)) * width >= 64) ?? 600;
  const ticks = [];
  // Leave out a label that would hang past the end.
  for (let t = 0; t <= duration; t += step) if (t === 0 || ((duration - t) / Math.max(duration, 1)) * width >= 30) ticks.push(t);
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  return (
    <div className="ruler" ref={ref} onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration); }}>
      {ticks.map((t) => <span key={t} style={{ left: `${(t / duration) * 100}%` }}>{fmt(t)}</span>)}
      <i style={{ left: `${(position / Math.max(duration, 1e-9)) * 100}%` }} />
    </div>
  );
}
