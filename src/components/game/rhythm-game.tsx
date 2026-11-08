"use client";

// Room links sweep through glimm (next/link handles the click itself, so a document-level interceptor never sees it).
import { TransitionLink as Link } from "glimm/next";
import { useEffect, useRef, useState } from "react";
import "@/lib/legacy-keys";
import { cachedTracks, loadTracks } from "@/lib/storage";
import { formatTime, type StoredTrack } from "@/lib/types";
import { DIFFICULTIES, type Difficulty } from "@/lib/rhythm-game/chart";
import { gradeOf, type Stats } from "@/lib/rhythm-game/judge";
import { makeSong, type Song } from "@/lib/rhythm-game/make-charts";
import { KEY_CODES, Run } from "@/lib/rhythm-game/playfield";
import { cn } from "@/lib/sodium/utils";
import { Button } from "@/components/sodium/ui/button";
import { Input } from "@/components/sodium/ui/input";
import { Status } from "@/components/sodium/ui/status";
import { SegmentedControl, SegmentedControlItem } from "@/components/sodium/ui/segmented-control";
import { ArrowLeft, Icon, Pause, Play, Upload } from "@/components/sodium/icon";

/* The rhythm game: pick a track from the library or drop in a file, it is charted at four difficulties from the audio
   (lib/rhythm-game/chart), then notes fall to the line and the keys hit them. The menu and the end screen are here; the
   run itself is a canvas driven by lib/rhythm-game/playfield. */

type Source = { key: string; title: string; artist: string; blob: Blob; bpm: number | null; duration?: number };
type Phase = "menu" | "play" | "done";

const SETTINGS = "shift-rhythm-v1";
function readSettings(): { speed: number; offset: number; difficulty: Difficulty } {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS) ?? "{}");
    return {
      speed: typeof v.speed === "number" ? Math.max(0.5, Math.min(2.5, v.speed)) : 1,
      offset: typeof v.offset === "number" ? Math.max(-300, Math.min(300, v.offset)) : 0,
      difficulty: DIFFICULTIES.some(d => d.id === v.difficulty) ? v.difficulty : "normal",
    };
  } catch { return { speed: 1, offset: 0, difficulty: "normal" }; }
}

/** Newest first, one entry per file: copies of the same content (same fingerprint) are listed once, the oldest kept. */
function uniqueTracks(all: StoredTrack[]) {
  const seen = new Set<string>();
  return [...all].sort((a, b) => a.addedAt - b.addedAt)
    .filter(t => { const key = t.fingerprint ?? t.id; if (seen.has(key)) return false; seen.add(key); return true; })
    .reverse();
}

const fromTrack = (t: StoredTrack): Source => ({ key: t.id, title: t.title, artist: t.artist, blob: t.blob, bpm: t.bpm, duration: t.duration });

export function RhythmGame() {
  const [initial] = useState(readSettings);
  const [tracks, setTracks] = useState<StoredTrack[] | null>(() => { const all = cachedTracks(); return all && uniqueTracks(all); });
  const [source, setSource] = useState<Source | null>(null);
  const [song, setSong] = useState<Song | null>(null);
  const [charting, setCharting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>(initial.difficulty);
  const [speed, setSpeed] = useState(initial.speed);
  const [offset, setOffset] = useState(initial.offset);
  const [phase, setPhase] = useState<Phase>("menu");
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState<Stats | null>(null);
  const [round, setRound] = useState(0);

  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const context = useRef<AudioContext | null>(null);
  const run = useRef<Run | null>(null);
  const token = useRef(0);

  useEffect(() => {
    let live = true;
    loadTracks().then(all => { if (live) setTracks(uniqueTracks(all)); }, () => { if (live) setTracks([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    try { localStorage.setItem(SETTINGS, JSON.stringify({ speed, offset, difficulty })); } catch { /* storage unavailable */ }
  }, [speed, offset, difficulty]);
  useEffect(() => () => { void context.current?.close(); }, []);

  const audio = () => context.current ??= new AudioContext({ latencyHint: "interactive" });

  function pick(next: Source) {
    const mine = ++token.current;
    setSource(next); setSong(null); setError(null); setCharting(true);
    makeSong(next.blob, audio(), next.bpm).then(
      made => { if (token.current === mine) { setSong(made); setCharting(false); } },
      (e: Error) => { if (token.current === mine) { setError(e.message || "This file could not be read as audio."); setCharting(false); } },
    );
  }

  const chart = song?.charts.charts[difficulty] ?? null;

  // One Run per play of a chart; leaving the screen or starting over ends it.
  useEffect(() => {
    if (phase !== "play" || !song || !chart || !canvas.current || !context.current) return;
    const r = new Run({
      canvas: canvas.current, context: context.current, audio: song.audio, chart, speed, offset: offset / 1000,
      onEnd: stats => { setResult(stats); setPhase("done"); },
    });
    run.current = r;
    r.start();
    return () => { r.destroy(); run.current = null; };
    // speed and offset are read when the run starts; changing them mid-run is the arrow keys' job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, round, song, chart]);

  useEffect(() => {
    if (phase !== "play") return;
    const toggle = () => {
      const r = run.current;
      if (!r) return;
      if (r.isPaused) { void r.resume(); setPaused(false); } else { void r.pause(); setPaused(true); }
    };
    const key = (e: KeyboardEvent) => { if (e.code === "Escape") { e.preventDefault(); toggle(); } };
    const hidden = () => { if (document.hidden && run.current && !run.current.isPaused) toggle(); };
    window.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("keydown", key); document.removeEventListener("visibilitychange", hidden); };
  }, [phase]);

  function play() {
    if (!song) return;
    setResult(null); setPaused(false); setRound(r => r + 1); setPhase("play");
  }
  function leave() { setPaused(false); setPhase("menu"); }

  const keys = chart ? KEY_CODES[chart.lanes].map(k => k === "Space" ? "␣" : k.replace("Key", "")) : [];

  if (phase !== "menu" && chart) {
    return <div className="flex h-dvh flex-col bg-page text-text-1">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <Button variant="ghost" size="sm" onClick={leave}><Icon icon={ArrowLeft}/>Quit</Button>
        <span className="type-label min-w-0 flex-1 truncate text-text-2">{source?.title} · {DIFFICULTIES.find(d => d.id === difficulty)?.label}</span>
        {phase === "play" && <Button variant="secondary" size="sm" onClick={() => { const r = run.current; if (!r) return; if (r.isPaused) { void r.resume(); setPaused(false); } else { void r.pause(); setPaused(true); } }}>
          <Icon icon={paused ? Play : Pause}/>{paused ? "Resume" : "Pause"}
        </Button>}
      </div>
      <div className="relative mx-auto min-h-0 w-full max-w-(--w) flex-1" style={{ "--w": `${chart.lanes * 96}px` } as React.CSSProperties}>
        <canvas ref={canvas} className="absolute inset-0 size-full border-x border-line" aria-label={`Playfield, keys ${keys.join(" ")}`}/>
        {paused && <Overlay title="Paused" hint="Esc to resume">
          <Button onClick={() => { void run.current?.resume(); setPaused(false); }}>Resume</Button>
          <Button variant="secondary" onClick={play}>Restart</Button>
        </Overlay>}
        {phase === "done" && result && <Overlay title={gradeOf(result.accuracy, result.counts.miss, result.total)} hint={source?.title ?? ""} big>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 type-code-sm">
            <dt className="text-text-3">Score</dt><dd className="text-end">{result.score}</dd>
            <dt className="text-text-3">Accuracy</dt><dd className="text-end">{(result.accuracy * 100).toFixed(1)}%</dd>
            <dt className="text-text-3">Max combo</dt><dd className="text-end">{result.maxCombo}</dd>
            <dt className="text-ok-text">Perfect</dt><dd className="text-end">{result.counts.perfect}</dd>
            <dt className="text-accent-text">Great</dt><dd className="text-end">{result.counts.great}</dd>
            <dt className="text-warn-text">Good</dt><dd className="text-end">{result.counts.good}</dd>
            <dt className="text-fail-text">Miss</dt><dd className="text-end">{result.counts.miss}</dd>
          </dl>
          <div className="flex gap-2"><Button onClick={play}>Play again</Button><Button variant="secondary" onClick={leave}>Song select</Button></div>
        </Overlay>}
      </div>
      <p className="shrink-0 py-2 text-center type-label-sm text-text-3">{keys.join(" ")} · ↑↓ scroll speed · Esc pause · or tap the lanes</p>
    </div>;
  }

  return <div className="min-h-dvh bg-page text-text-1">
    <div className="px-4 pt-4">
      <header className="flex h-12 items-stretch border border-line bg-panel">
        <Link href="/" className="flex items-center gap-2 border-e border-line px-4 type-label text-text-2 hover:text-text-1"><Icon icon={ArrowLeft}/>Decks</Link>
        <h1 className="flex items-center px-4 type-heading-sm">Rhythm</h1>
        <div className="ms-auto flex items-center border-s border-line px-4"><Status size="sm" status={charting ? "running" : "idle"}>{charting ? "Charting" : song ? "Ready" : "Pick a track"}</Status></div>
      </header>
    </div>
    <main className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-3">
      <section className="border border-line bg-panel lg:col-span-2" aria-labelledby="songs">
        <div className="flex h-12 items-center justify-between border-b border-line px-4">
          <h2 id="songs" className="type-heading-sm">Songs</h2>
          <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}><Icon icon={Upload}/>Upload a track</Button>
          {/* The Input draws its own absolutely sized field wrapper, so the hiding has to be on a wrapper around it: left in
              the flex header it sits 40px in and pushes the page wider than a phone. */}
          <div className="sr-only" aria-hidden>
            <Input ref={fileInput} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac" tabIndex={-1} aria-label="Audio file"
              onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) pick({ key: `file:${f.name}:${f.size}`, title: f.name.replace(/\.[^.]+$/, ""), artist: "Uploaded file", blob: f, bpm: null }); }}/>
          </div>
        </div>
        {tracks === null ? <p className="p-4 type-body-sm text-text-3">Loading the library…</p>
          : tracks.length === 0 ? <p className="p-4 type-body-sm text-text-2">The library is empty. Upload a track here, or add some on the decks page; they show up in this list.</p>
          : <ul className="divide-y divide-line-faint">
            {tracks.map(t => <li key={t.id} className={cn("flex items-center gap-3 px-4 py-2", source?.key === t.id && "bg-page")}>
              <span className="min-w-0 flex-1"><span className="block truncate type-body-sm text-text-1">{t.title}</span><span className="block truncate type-label-sm text-text-3">{t.artist}</span></span>
              <span className="hidden type-code-sm text-text-3 sm:inline">{t.bpm ? `${Math.round(t.bpm)} BPM` : ""}</span>
              <span className="type-code-sm text-text-2">{formatTime(t.duration)}</span>
              <Button variant={source?.key === t.id ? "secondary" : "ghost"} size="sm" onClick={() => pick(fromTrack(t))} aria-pressed={source?.key === t.id}>{source?.key === t.id ? "Selected" : "Select"}</Button>
            </li>)}
          </ul>}
      </section>

      <section className="h-fit border border-line bg-panel" aria-labelledby="setup">
        <div className="flex h-12 items-center border-b border-line px-4"><h2 id="setup" className="type-heading-sm">Get ready</h2></div>
        <div className="flex flex-col gap-4 p-4">
          {!source && <p className="type-body-sm text-text-2">Choose a song. Its notes are made from the audio, at four difficulties.</p>}
          {source && <div><p className="truncate type-body-sm text-text-1">{source.title}</p><p className="truncate type-label-sm text-text-3">{source.artist}</p></div>}
          {charting && <p role="status" className="type-body-sm text-text-2">Listening to the track and placing notes…</p>}
          {error && <p role="alert" className="type-body-sm text-fail-text">{error}</p>}
          {song && <>
            <div className="flex flex-col gap-1.5">
              <span id="diff" className="type-label-sm text-text-3">DIFFICULTY</span>
              <SegmentedControl fill size="sm" aria-labelledby="diff" value={difficulty} onValueChange={v => setDifficulty(v as Difficulty)}>
                {DIFFICULTIES.map(d => <SegmentedControlItem key={d.id} value={d.id}>{d.label}</SegmentedControlItem>)}
              </SegmentedControl>
              <p className="type-code-sm text-text-2">{chart?.notes.length ?? 0} notes · {chart?.lanes} lanes · {song.charts.bpm ? `${Math.round(song.charts.bpm)} BPM` : "no steady tempo"}</p>
              {chart && chart.notes.length < 8 && <p className="type-body-sm text-warn-text">Very few notes were found. This track may be too quiet or too smooth to chart.</p>}
            </div>
            <Stepper label="Scroll speed" value={`${speed.toFixed(1)}×`} onLess={() => setSpeed(s => Math.max(0.5, Math.round((s - 0.1) * 10) / 10))} onMore={() => setSpeed(s => Math.min(2.5, Math.round((s + 0.1) * 10) / 10))}/>
            <Stepper label="Audio offset" value={`${offset > 0 ? "+" : ""}${offset} ms`} onLess={() => setOffset(o => Math.max(-300, o - 10))} onMore={() => setOffset(o => Math.min(300, o + 10))}
              hint="Raise it if the notes feel early, lower it if late. Wireless headphones usually need a few dozen."/>
            <Button size="lg" onClick={play} disabled={!chart || chart.notes.length === 0}><Icon icon={Play}/>Play</Button>
            <p className="type-label-sm text-text-3">Keys {keys.join(" ")}</p>
          </>}
        </div>
      </section>
    </main>
  </div>;
}

function Stepper({ label, value, onLess, onMore, hint }: { label: string; value: string; onLess: () => void; onMore: () => void; hint?: string }) {
  return <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between">
      <span className="type-label-sm text-text-3">{label.toUpperCase()}</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="icon-sm" onClick={onLess} aria-label={`${label}: less`}>−</Button>
        <span className="min-w-16 text-center type-code-sm" aria-live="polite">{value}</span>
        <Button variant="secondary" size="icon-sm" onClick={onMore} aria-label={`${label}: more`}>+</Button>
      </div>
    </div>
    {hint && <p className="type-label-sm text-text-3">{hint}</p>}
  </div>;
}

function Overlay({ title, hint, big, children }: { title: string; hint: string; big?: boolean; children: React.ReactNode }) {
  return <div role="dialog" aria-label={title} className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-page/85 p-6 text-center">
    <p className={cn("type-heading-sm", big && "type-display text-accent-text")}>{title}</p>
    <p className="max-w-full truncate type-label-sm text-text-3">{hint}</p>
    {children}
  </div>;
}
