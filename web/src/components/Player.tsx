import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { formatDuration } from "../api/client.ts";
import { Icon } from "./Icon.tsx";

const BARS = 150;
const RATES = [1, 1.25, 1.5, 2];
const SKIP_SECONDS = 10;

/**
 * Resample the server's envelope to the bar count, keeping each bucket's
 * peak, then stretch the range: speech sits in a narrow loudness band, and
 * without the stretch every bar looks the same height.
 */
function toBars(peaks: number[] | null): number[] {
  if (!peaks || peaks.length === 0) return Array.from({ length: BARS }, () => 0.12);
  const raw = Array.from({ length: BARS }, (_, i) => {
    const from = Math.floor((i * peaks.length) / BARS);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / BARS));
    let max = 0;
    for (let j = from; j < to; j++) max = Math.max(max, peaks[j] ?? 0);
    return max;
  });
  const sorted = [...raw].sort((a, b) => a - b);
  const low = sorted[Math.floor(BARS * 0.05)] ?? 0;
  const high = sorted[Math.floor(BARS * 0.98)] ?? 1;
  const span = high - low || 1;
  return raw.map((v) => 0.12 + 0.88 * Math.max(0, Math.min(1, (v - low) / span)));
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * Audio player with a loudness waveform. Owns the <audio> element; the parent
 * keeps a ref to seek it and receives the current time on every frame.
 */
export default function Player({
  src, peaks, fallbackDuration, audioRef, onTime, onPlayingChange, initialTime = 0,
}: {
  src: string | null;
  /** Start position in seconds, from a ?t= deep link. */
  initialTime?: number;
  peaks: number[] | null;
  fallbackDuration: number;
  audioRef: RefObject<HTMLAudioElement>;
  onTime: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(initialTime);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const bars = useMemo(() => toBars(peaks), [peaks]);
  const total = Number.isFinite(duration) && duration > 0 ? duration : fallbackDuration;
  const available = src !== null && !failed;
  const played = total > 0 ? Math.min(1, time / total) : 0;

  useEffect(() => setFailed(false), [src]);

  // Smooth playhead while playing; timeupdate alone only fires ~4 times a second.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) {
        setTime(a.currentTime);
        onTime(a.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, onTime, audioRef]);

  const seekTo = (seconds: number) => {
    const a = audioRef.current;
    if (!a || !available) return;
    const t = Math.max(0, Math.min(total || a.duration || 0, seconds));
    a.currentTime = t;
    setTime(t);
    onTime(t);
  };

  const toggle = () => {
    const a = audioRef.current;
    if (!a || !available) return;
    if (a.paused) void a.play().catch(() => setFailed(true));
    else a.pause();
  };

  // Space plays and pauses, arrows skip, unless the user is typing. The
  // listener reads the latest handlers through a ref so it binds only once.
  const keys = useRef({ toggle, seekTo });
  keys.current = { toggle, seekTo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const a = audioRef.current;
      if (e.code === "Space") {
        // A focused button already reacts to Space; toggling here too would undo it.
        if (["BUTTON", "A"].includes((e.target as HTMLElement | null)?.tagName ?? "")) return;
        e.preventDefault();
        keys.current.toggle();
      } else if (e.key === "ArrowLeft" && a) {
        keys.current.seekTo(a.currentTime - 5);
      } else if (e.key === "ArrowRight" && a) {
        keys.current.seekTo(a.currentTime + 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [audioRef]);

  const fractionAt = (clientX: number) => {
    const rect = waveRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!available) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(fractionAt(e.clientX) * total);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const f = fractionAt(e.clientX);
    setHover(f);
    if (dragging.current) seekTo(f * total);
  };

  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (audioRef.current) audioRef.current.muted = next;
  };

  const control = "grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-40";

  return (
    <section className="relative flex items-center gap-4 rounded-2xl bg-zinc-900/70 px-4 py-3 ring-1 ring-inset ring-white/[0.06]">
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onPlay={() => { setPlaying(true); onPlayingChange?.(true); }}
          onPause={() => { setPlaying(false); onPlayingChange?.(false); }}
          onEnded={() => { setPlaying(false); onPlayingChange?.(false); }}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration);
            if (initialTime > 0 && e.currentTarget.currentTime === 0) e.currentTarget.currentTime = initialTime;
          }}
          onSeeked={(e) => { setTime(e.currentTarget.currentTime); onTime(e.currentTarget.currentTime); }}
          onError={() => setFailed(true)}
        />
      )}

      <button type="button" className={control} disabled={!available} onClick={() => seekTo(time - SKIP_SECONDS)} title="Back 10 seconds">
        <Icon name="back" />
      </button>
      <button
        type="button"
        onClick={toggle}
        disabled={!available}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-zinc-950 shadow-lg shadow-white/10 transition hover:scale-105 disabled:bg-zinc-700 disabled:text-zinc-500 disabled:shadow-none disabled:hover:scale-100"
      >
        <Icon name={playing ? "pause" : "play"} className={playing ? "h-4 w-4" : "ml-0.5 h-4 w-4"} />
      </button>
      <button type="button" className={control} disabled={!available} onClick={() => seekTo(time + SKIP_SECONDS)} title="Forward 10 seconds">
        <Icon name="forward" />
      </button>

      <span className="tnum w-14 text-right font-mono text-sm text-zinc-100">{formatDuration(time)}</span>

      <div
        ref={waveRef}
        className={`relative flex h-10 flex-1 touch-none select-none items-center gap-[2px] ${available ? "cursor-pointer" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { dragging.current = false; }}
        onPointerLeave={() => setHover(null)}
      >
        {bars.map((h, i) => (
          <span
            key={i}
            className={`flex-1 rounded-full ${
              available && (i + 0.5) / BARS <= played
                ? "bg-gradient-to-t from-indigo-500 to-violet-400"
                : "bg-zinc-700/80"
            }`}
            style={{ height: `${Math.round(h * 100)}%` }}
          />
        ))}
        {available && (
          <span
            className="pointer-events-none absolute -inset-y-1 w-[2px] rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.7)]"
            style={{ left: `${played * 100}%` }}
          />
        )}
        {available && hover !== null && (
          <span className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200 ring-1 ring-white/10" style={{ left: `${hover * 100}%` }}>
            {formatDuration(hover * total)}
          </span>
        )}
        {!available && (
          <span className="absolute inset-0 grid place-items-center text-xs text-zinc-500">
            {src === null ? "No audio for this meeting." : "Audio not available. The recording may have moved."}
          </span>
        )}
      </div>

      <span className="tnum w-14 font-mono text-sm text-zinc-500">{formatDuration(total)}</span>
      <button
        type="button"
        onClick={cycleRate}
        disabled={!available}
        title="Playback speed"
        className="tnum w-11 rounded-md bg-white/[0.06] py-1 text-xs font-medium text-zinc-300 transition hover:bg-white/10 disabled:opacity-40"
      >
        {rate}×
      </button>
      <button type="button" className={control} disabled={!available} onClick={toggleMute} title={muted ? "Unmute" : "Mute"}>
        <Icon name={muted ? "volumeOff" : "volume"} />
      </button>
    </section>
  );
}
