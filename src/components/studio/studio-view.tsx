"use client";

// Room links sweep through glimm (next/link handles the click itself, so a document-level interceptor never sees it).
import { TransitionLink as Link } from "glimm/next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cachedTracks, loadTracks } from "@/lib/storage";
import { NOTE_NAMES, SCALES, SCALE_LABELS, autotune, type Scale } from "@/lib/autotune";
import { peaksOf, type StemPeaks } from "@/lib/stem-peaks";
import { STUDIO_LANES, audible, clipWindow, encodeWav, joinChunks, stemChannels, takeOffset, timelineLength } from "@/lib/studio";
import { STEMS, formatTime, type StoredTrack } from "@/lib/types";
import { cn } from "@/lib/sodium/utils";
import { Button } from "@/components/sodium/ui/button";
import { Field, FieldLabel, FieldTitle, Label } from "@/components/sodium/ui/field";
import { Frame, FrameHeader, FrameStatus, FrameTitle } from "@/components/sodium/ui/frame";
import { Pick } from "@/components/pick";
import { Switch } from "@/components/sodium/ui/switch";
import { Slider } from "@/components/sodium/ui/slider";
import { Status } from "@/components/sodium/ui/status";
import { ArrowLeft, Download, Icon, Play, Previous, Record, StopOutline } from "@/components/sodium/icon";
import { Ruler, gridOf, token, useCanvas, type Grid } from "@/components/stems/timeline";

/* A four-track studio. Each lane holds one clip: a stem of a library track, or your voice recorded over whatever the
   other lanes play. Every lane starts at its own offset on one shared timeline, so a take lines up with the backing
   it was sung to (minus the round trip through speakers and microphone, which the latency control sets).
   Takes live in memory for the session: export the mixdown to keep it. */

/** The source value of an empty lane (the popup select ignores an empty string). */
const NONE = "none";
const LANE_COLORS =["--data-1", "--data-6", "--data-2", "--data-5"];
/** Playback starts this far ahead of "now" so every lane's source can be scheduled on the same clock edge. */
const LEAD = 0.05;
const BUCKETS = 1600;

type Lane = {
  kind: "empty" | "stem" | "voice";
  trackId?: string;
  stem: number;
  buffer: AudioBuffer | null;
  peaks: StemPeaks | null;
  /** Where the clip starts on the timeline, seconds. */
  offset: number;
  /** Manual shift on top of `offset`, ms. */
  nudge: number;
  level: number;
  loading: boolean;
  error?: string;
  /** The take as recorded, kept while `buffer` holds its autotuned version. */
  dry?: AudioBuffer;
};
const emptyLane = (): Lane => ({ kind: "empty", stem: 0, buffer: null, peaks: null, offset: 0, nudge: 0, level: 1, loading: false });
const start = (l: Lane) => l.offset + l.nudge / 1000;

/** Records microphone samples on the audio thread; the main thread only collects the chunks. */
const RECORDER_SOURCE = `
class StudioRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.port.onmessage = () => this.port.postMessage("done"); }
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
}
registerProcessor("studio-recorder", StudioRecorder);`;

function bufferPeaks(b: AudioBuffer): StemPeaks {
  const left = b.getChannelData(0), right = b.numberOfChannels > 1 ? b.getChannelData(1) : left;
  return peaksOf(left, right, BUCKETS);
}

/** The eight-channel stems file as four stereo buffers, in STEMS order. */
async function decodeStems(blob: Blob): Promise<AudioBuffer[]> {
  const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  return STEMS.map((_, k) => {
    const [l, r] = stemChannels(channels, k);
    const out = new AudioBuffer({ length: audio.length, numberOfChannels: 2, sampleRate: audio.sampleRate });
    out.copyToChannel(l as Float32Array<ArrayBuffer>, 0); out.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
    return out;
  });
}

function ClipLane({ lane, color, dim, length, grid }: { lane: Lane; color: string; dim: boolean; length: number; grid: Grid }) {
  const ref = useCanvas((ctx, w, h) => {
    const px = w / length, faint = token("--line-faint"), strong = token("--line");
    if (grid) {
      for (let n = 0; ; n++) {
        const t = grid.first + n * grid.beat;
        if (t > length) break;
        if (t < 0) continue;
        const bar = n % 4 === 0;
        if (!bar && grid.beat * px < 8) continue;
        ctx.strokeStyle = bar ? strong : faint; ctx.lineWidth = 1;
        const x = Math.round(t * px) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    if (!lane.peaks || !lane.buffer) return;
    const mid = h / 2, amp = mid - 4, n = lane.peaks.max.length, from = start(lane) * px, width = lane.buffer.duration * px;
    ctx.fillStyle = token(color); ctx.globalAlpha = dim ? 0.25 : 1;
    for (let x = Math.max(0, Math.floor(from)); x < Math.min(w, Math.ceil(from + width)); x++) {
      const a = Math.floor((x - from) / width * n), b = Math.max(a + 1, Math.floor((x + 1 - from) / width * n));
      let lo = 0, hi = 0;
      for (let i = Math.max(0, a); i < b && i < n; i++) { if (lane.peaks.min[i] < lo) lo = lane.peaks.min[i]; if (lane.peaks.max[i] > hi) hi = lane.peaks.max[i]; }
      ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    ctx.globalAlpha = 1;
  }, [lane.peaks, lane.buffer, lane.offset, lane.nudge, color, dim, length, grid]);
  return <canvas ref={ref} className="block h-36 w-full" aria-hidden="true"/>;
}

export function StudioView() {
  const [tracks, setTracks] = useState<StoredTrack[] | null>(cachedTracks);
  const [lanes, setLanes] = useState<Lane[]>(() => Array.from({ length: STUDIO_LANES }, emptyLane));
  const [mute, setMute] = useState<boolean[]>(() => Array(STUDIO_LANES).fill(false));
  const [solo, setSolo] = useState<boolean[]>(() => Array(STUDIO_LANES).fill(false));
  const [armed, setArmed] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [latency, setLatency] = useState(90);
  const [monitor, setMonitor] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [tuneTrack, setTuneTrack] = useState<number | null>(null);
  const [key, setKey] = useState(0);
  const [scale, setScale] = useState<Scale>("major");
  const [speed, setSpeed] = useState(0);
  const [amount, setAmount] = useState(100);
  const [tuning, setTuning] = useState<number | null>(null);

  const ctx = useRef<AudioContext | null>(null);
  const gains = useRef<GainNode[]>([]);
  const sources = useRef<AudioBufferSourceNode[]>([]);
  const clock = useRef({ ctxTime: 0, pos: 0 });
  const pos = useRef(0);
  const mic = useRef<{ stream: MediaStream; source: MediaStreamAudioSourceNode; node: AudioWorkletNode; monitor: GainNode } | null>(null);
  const take = useRef<{ lane: number; firstPos: number; chunks: Float32Array[] } | null>(null);
  const stemCache = useRef(new Map<string, AudioBuffer[]>());
  const playhead = useRef<HTMLDivElement>(null);
  const clockText = useRef<HTMLSpanElement>(null);
  const lanesRef = useRef(lanes);
  const latencyRef = useRef(latency);
  const armedRef = useRef(armed);
  useEffect(() => { lanesRef.current = lanes; latencyRef.current = latency; armedRef.current = armed; });

  const ready = useMemo(() => (tracks ?? []).filter(t => t.stems).sort((a, b) => b.addedAt - a.addedAt), [tracks]);
  const length = useMemo(
    () => timelineLength(lanes.filter(l => l.buffer).map(l => ({ offset: start(l), duration: l.buffer!.duration }))),
    [lanes],
  );
  const lengthRef = useRef(length);
  useEffect(() => { lengthRef.current = length; });
  const grid = useMemo<Grid>(() => {
    const first = lanes.find(l => l.kind === "stem" && l.trackId);
    const t = first && tracks?.find(x => x.id === first.trackId);
    return t ? gridOf(t) : null;
  }, [lanes, tracks]);

  useEffect(() => {
    let live = true;
    loadTracks().then(list => { if (live) setTracks(list); }, () => { if (live) setTracks([]); });
    return () => { live = false; };
  }, []);

  const ensureContext = useCallback(async () => {
    if (!ctx.current) {
      const c = new AudioContext({ latencyHint: "interactive" });
      gains.current = Array.from({ length: STUDIO_LANES }, () => { const g = c.createGain(); g.connect(c.destination); return g; });
      ctx.current = c;
    }
    if (ctx.current.state !== "running") await ctx.current.resume();
    return ctx.current;
  }, []);

  const position = useCallback(() => {
    const c = ctx.current;
    return playing && c ? clock.current.pos + Math.max(0, c.currentTime - clock.current.ctxTime) : pos.current;
  }, [playing]);

  const paint = useCallback((at: number) => {
    if (playhead.current) playhead.current.style.left = `${Math.min(100, at / lengthRef.current * 100)}%`;
    if (clockText.current) clockText.current.textContent = formatTime(Math.max(0, at));
  }, []);

  const silence = useCallback(() => {
    for (const s of sources.current) { try { s.stop(); } catch { /* never started */ } s.disconnect(); }
    sources.current = [];
  }, []);

  /** Starts every lane's clip from `from`, all on one clock edge. */
  const schedule = useCallback((c: AudioContext, from: number) => {
    silence();
    const edge = c.currentTime + LEAD;
    clock.current = { ctxTime: edge, pos: from };
    lanesRef.current.forEach((l, k) => {
      if (!l.buffer) return;
      const w = clipWindow(start(l), l.buffer.duration, from);
      if (!w) return;
      const s = c.createBufferSource();
      s.buffer = l.buffer; s.connect(gains.current[k]); s.start(edge + w.delay, w.bufferOffset);
      sources.current.push(s);
    });
  }, [silence]);

  const releaseMic = useCallback(() => {
    const m = mic.current;
    if (!m) return;
    m.stream.getTracks().forEach(t => t.stop());
    m.source.disconnect(); m.node.disconnect(); m.monitor.disconnect();
    mic.current = null;
  }, []);

  const finishTake = useCallback(async () => {
    const m = mic.current, t = take.current, c = ctx.current;
    take.current = null; setRecording(false);
    if (!m || !t || !c) return;
    m.source.disconnect(m.node); m.source.disconnect(m.monitor);
    // The worklet answers "done" after every chunk it posted, so nothing of the take is still in flight.
    await new Promise<void>(resolve => {
      const prev = m.node.port.onmessage;
      m.node.port.onmessage = e => { if (e.data === "done") { m.node.port.onmessage = prev; resolve(); } else prev?.call(m.node.port, e); };
      m.node.port.postMessage("flush");
    });
    const samples = joinChunks(t.chunks);
    if (samples.length < c.sampleRate / 20) { setMessage("Nothing was recorded."); return; }
    const buffer = c.createBuffer(1, samples.length, c.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const lane: Lane = { kind: "voice", stem: 0, buffer, peaks: bufferPeaks(buffer), offset: takeOffset(t.firstPos, latencyRef.current / 1000), nudge: 0, level: 1, loading: false };
    setLanes(ls => ls.map((l, i) => i === t.lane ? { ...lane, level: l.level } : l));
  }, []);

  const stop = useCallback(() => {
    const at = position();
    silence();
    pos.current = Math.min(at, lengthRef.current);
    setPlaying(false);
    paint(pos.current);
    if (take.current) void finishTake();
  }, [position, silence, paint, finishTake]);

  const play = useCallback(async () => {
    const c = await ensureContext();
    const from = pos.current >= lengthRef.current ? 0 : pos.current;
    pos.current = from;
    schedule(c, from);
    const m = mic.current, a = armedRef.current;
    if (m && a !== null) {
      take.current = { lane: a, firstPos: from - LEAD, chunks: [] };
      m.source.connect(m.node); m.source.connect(m.monitor);
      setRecording(true);
    }
    setPlaying(true);
  }, [ensureContext, schedule]);

  const toggle = useCallback(() => { if (playing) stop(); else void play(); }, [playing, stop, play]);

  // The playhead follows the audio clock while playing; recording and playback stop at the end of the timeline.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      const at = position();
      paint(at);
      if (at >= lengthRef.current) { stop(); return; }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, position, paint, stop]);

  // Collect the recorder's chunks while a take is open.
  const collect = useCallback((e: MessageEvent) => { if (e.data instanceof Float32Array) take.current?.chunks.push(e.data); }, []);

  async function arm(k: number) {
    if (armed === k) { releaseMic(); setArmed(null); return; }
    setMessage(null);
    if (playing) stop();
    try {
      const c = await ensureContext();
      if (!mic.current) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot reach a microphone.");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
        const url = URL.createObjectURL(new Blob([RECORDER_SOURCE], { type: "text/javascript" }));
        try { await c.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        const source = c.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(c, "studio-recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
        const quiet = c.createGain(); quiet.gain.value = 0; node.connect(quiet); quiet.connect(c.destination);
        const heard = c.createGain(); heard.gain.value = monitor ? 1 : 0; heard.connect(c.destination);
        node.port.onmessage = collect;
        mic.current = { stream, source, node, monitor: heard };
      }
      setArmed(k);
    } catch (e) {
      releaseMic(); setArmed(null);
      setMessage(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was blocked." : e instanceof Error ? e.message : "Could not open the microphone.");
    }
  }

  useEffect(() => { if (mic.current) mic.current.monitor.gain.value = monitor ? 1 : 0; }, [monitor]);

  // Mute, solo and level are gains: no click, and they follow while playing.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    gains.current.forEach((g, k) => g.gain.setTargetAtTime(audible(mute, solo, k) ? lanes[k].level : 0, c.currentTime, 0.015));
  }, [mute, solo, lanes, playing]);

  // A clip moved or replaced while playing restarts from the playhead.
  const lastLayout = useRef("");
  useEffect(() => {
    const key = lanes.map(l => `${l.buffer?.length ?? 0}:${l.offset}:${l.nudge}`).join("|");
    const changed = key !== lastLayout.current;
    lastLayout.current = key;
    const c = ctx.current;
    if (changed && playing && c && !take.current) schedule(c, position());
  }, [lanes, playing, schedule, position]);

  useEffect(() => () => {
    silence(); releaseMic();
    const c = ctx.current; ctx.current = null;
    if (c) void c.close();
  }, [silence, releaseMic]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("button, input, select, a, [role=slider]") || t.isContentEditable)) return;
      e.preventDefault(); toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle]);

  const patch = (k: number, change: Partial<Lane>) => setLanes(ls => ls.map((l, i) => i === k ? { ...l, ...change } : l));

  async function choose(k: number, value: string) {
    if (armed === k && value !== "voice") { releaseMic(); setArmed(null); }
    if (value === NONE) { patch(k, emptyLane()); return; }
    if (value === "voice") {
      if (lanes[k].kind !== "voice") patch(k, { ...emptyLane(), kind: "voice", level: lanes[k].level });
      return;
    }
    await loadStem(k, value, lanes[k].kind === "stem" && lanes[k].trackId === value ? lanes[k].stem : 0);
  }

  async function loadStem(k: number, trackId: string, stem: number) {
    const track = tracks?.find(t => t.id === trackId);
    if (!track?.stems) return;
    patch(k, { kind: "stem", trackId, stem, loading: true, error: undefined });
    try {
      let all = stemCache.current.get(trackId);
      if (!all) {
        all = await decodeStems(track.stems);
        stemCache.current.set(trackId, all);
        // The decoded stems of a long track are big: keep the last two tracks.
        while (stemCache.current.size > 2) stemCache.current.delete(stemCache.current.keys().next().value as string);
      }
      const buffer = all[stem];
      patch(k, { kind: "stem", trackId, stem, buffer, peaks: bufferPeaks(buffer), offset: 0, nudge: 0, loading: false });
    } catch {
      patch(k, { kind: "stem", trackId, stem, buffer: null, peaks: null, loading: false, error: "Could not read this track's stems." });
    }
  }

  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    if (recording) return;
    const box = e.currentTarget.getBoundingClientRect();
    const at = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * length;
    pos.current = at; paint(at);
    const c = ctx.current;
    if (playing && c) schedule(c, at);
  };

  const rewind = () => {
    if (recording) return;
    pos.current = 0; paint(0);
    const c = ctx.current;
    if (playing && c) schedule(c, 0);
  };

  const voiceTakes = lanes.map((l, k) => ({ l, k })).filter(({ l }) => l.kind === "voice" && l.buffer);
  const target = voiceTakes.find(({ k }) => k === tuneTrack) ?? voiceTakes[0] ?? null;

  /** Pitch-corrects the dry take of the chosen lane; the original stays one click away. */
  async function applyTune() {
    if (!target || tuning !== null) return;
    const { l, k } = target, dry = l.dry ?? l.buffer!;
    if (playing) stop();
    setMessage(null); setTuning(0);
    try {
      const out = await autotune(dry.getChannelData(0), dry.sampleRate, { key, scale, speed, amount: amount / 100 }, setTuning);
      const buffer = new AudioBuffer({ length: out.length, numberOfChannels: 1, sampleRate: dry.sampleRate });
      buffer.copyToChannel(out as Float32Array<ArrayBuffer>, 0);
      patch(k, { buffer, peaks: bufferPeaks(buffer), dry });
    } catch { setMessage("Could not tune this take."); } finally { setTuning(null); }
  }

  function revertTune() {
    if (!target?.l.dry) return;
    const dry = target.l.dry;
    if (playing) stop();
    patch(target.k, { buffer: dry, peaks: bufferPeaks(dry), dry: undefined });
  }

  async function exportMix() {
    const parts = lanes.map((l, k) => ({ l, k })).filter(({ l, k }) => l.buffer && audible(mute, solo, k));
    if (!parts.length) { setMessage("Nothing to export: add a clip to a lane that is not muted."); return; }
    setExporting(true); setMessage(null);
    try {
      const rate = 44100, end = Math.max(...parts.map(({ l }) => start(l) + l.buffer!.duration));
      const off = new OfflineAudioContext(2, Math.ceil(end * rate), rate);
      for (const { l } of parts) {
        const w = clipWindow(start(l), l.buffer!.duration, 0);
        if (!w) continue;
        const s = off.createBufferSource(), g = off.createGain();
        s.buffer = l.buffer; g.gain.value = l.level; s.connect(g); g.connect(off.destination); s.start(w.delay, w.bufferOffset);
      }
      const blob = encodeWav(await off.startRendering());
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "studio-mix.wav"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch { setMessage("Could not render the mix."); } finally { setExporting(false); }
  }

  const set = <T,>(list: T[], k: number, v: T) => list.map((x, i) => i === k ? v : x);
  const sourceItems = useMemo(
    () => [{ value: NONE, label: "Empty" }, { value: "voice", label: "My voice" }, ...ready.map(t => ({ value: t.id, label: t.title }))],
    [ready],
  );
  const stemItems = STEMS.map((s, i) => ({ value: String(i), label: s.label }));
  const hasClips = lanes.some(l => l.buffer);

  return <div className="flex min-h-dvh flex-col bg-page text-text-1">
    <div className="px-4 pt-4">
      <header className="flex h-12 items-stretch border border-line bg-panel">
        <Link href="/" className="flex items-center gap-2 border-e border-line px-4 type-label text-text-2 hover:text-text-1"><Icon icon={ArrowLeft}/>Decks</Link>
        <h1 className="flex items-center px-4 type-heading-sm">Studio</h1>
        <Link href="/stems" className="flex items-center border-s border-line px-4 type-label text-text-2 hover:text-text-1">Stems</Link>
        <div className="ms-auto flex items-center border-s border-line px-4">
          <Status size="sm" status={recording ? "running" : message ? "fail" : "idle"}>
            {recording ? "Recording" : message ? "Check below" : armed !== null ? `Track ${armed + 1} armed` : "Ready"}
          </Status>
        </div>
      </header>
    </div>

    <main className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <Frame variant="panel" aria-labelledby="timeline">
        <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <div className="flex items-center gap-2">
            <Button size="icon-sm" variant="secondary" onClick={rewind} disabled={recording} aria-label="Back to start"><Icon icon={Previous}/></Button>
            <Button size="icon-sm" onClick={toggle} aria-label={playing ? "Stop" : armed !== null ? "Record" : "Play"}><Icon icon={playing ? StopOutline : armed !== null ? Record : Play}/></Button>
            <span className="type-code-sm text-text-1"><span ref={clockText}>0:00</span><span className="text-text-3"> / {formatTime(length)}</span></span>
          </div>
          <div className="flex min-w-48 flex-1 items-center gap-3 sm:max-w-xs">
            <span id="latency-label" className="type-label-sm text-text-2">Latency</span>
            <Slider aria-labelledby="latency-label" min={0} max={400} step={5} value={latency} disabled={recording}
              onValueChange={v => setLatency(Array.isArray(v) ? v[0] : v)}/>
            <span className="w-14 shrink-0 text-end type-code-sm text-text-2">{latency} ms</span>
          </div>
          <div className="flex items-center gap-2">
            <Switch size="sm" id="monitor" checked={monitor} onCheckedChange={setMonitor}/>
            <Label htmlFor="monitor">Hear myself</Label>
          </div>
          <h2 id="timeline" className="sr-only">Timeline</h2>
          <Button size="sm" variant="secondary" className="ms-auto" disabled={!hasClips || exporting} onClick={() => void exportMix()}>
            <Icon icon={Download}/>{exporting ? "Rendering" : "Export WAV"}
          </Button>
        </div>
        {message && <p role="alert" className="border-b border-line px-4 py-2 type-body-sm text-fail-text">{message}</p>}

        <div className="flex overflow-hidden">
          <div className="w-64 shrink-0 border-e border-line">
            <div className="h-7 border-b border-line"/>
            {lanes.map((l, k) => {
              const sounds = audible(mute, solo, k), isArmed = armed === k;
              return <div key={k} className="flex h-36 flex-col justify-between gap-2 border-b border-line-faint px-3 py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className={cn("size-(--marker) shrink-0 bg-(--swatch)", !sounds && "opacity-30")} style={{ "--swatch": `var(${LANE_COLORS[k]})` } as React.CSSProperties} aria-hidden="true"/>
                  <span className="min-w-0 flex-1 truncate type-label text-text-1">Track {k + 1}</span>
                  <Button size="icon-sm" variant={isArmed ? "primary" : "secondary"} aria-pressed={isArmed} disabled={recording || l.kind !== "voice"}
                    aria-label={`Arm track ${k + 1} for recording`} onClick={() => void arm(k)}><Icon icon={Record}/></Button>
                  <Button size="icon-sm" variant={mute[k] ? "primary" : "secondary"} aria-pressed={mute[k]} aria-label={`Mute track ${k + 1}`}
                    onClick={() => setMute(m => set(m, k, !m[k]))}><span className="type-label-sm">M</span></Button>
                  <Button size="icon-sm" variant={solo[k] ? "primary" : "secondary"} aria-pressed={solo[k]} aria-label={`Solo track ${k + 1}`}
                    onClick={() => setSolo(m => set(m, k, !m[k]))}><span className="type-label-sm">S</span></Button>
                </div>
                <div className="flex items-center gap-2">
                  <Pick aria-label={`Source of track ${k + 1}`} items={sourceItems} disabled={recording} className="min-w-0 flex-1"
                    value={l.kind === "empty" ? NONE : l.kind === "voice" ? "voice" : l.trackId ?? NONE}
                    onValueChange={v => void choose(k, v)}/>
                  {l.kind === "stem" && <Pick aria-label={`Stem of track ${k + 1}`} items={stemItems} className="w-28 shrink-0" disabled={l.loading}
                    value={String(l.stem)} onValueChange={v => { if (l.trackId) void loadStem(k, l.trackId, Number(v)); }}/>}
                </div>
                <p className="truncate type-body-sm text-text-3" aria-live="polite">
                  {l.error ?? (l.loading ? "Reading stems…" : l.kind === "voice" ? (isArmed ? (l.buffer ? "Armed: Record replaces the take" : "Armed: press Record") : l.buffer ? "Voice take" : "Arm to record your voice") : l.kind === "stem" ? "Stem of the library track" : "No clip")}
                </p>
                <div className="flex items-center gap-2">
                  <Slider aria-label={`Level of track ${k + 1}`} min={0} max={100} value={Math.round(l.level * 100)}
                    onValueChange={v => patch(k, { level: (Array.isArray(v) ? v[0] : v) / 100 })}/>
                  <Slider aria-label={`Shift of track ${k + 1} in milliseconds`} min={-300} max={300} step={5} value={l.nudge} disabled={!l.buffer || recording}
                    onValueChange={v => patch(k, { nudge: Array.isArray(v) ? v[0] : v })}/>
                </div>
              </div>;
            })}
          </div>

          <div className="relative min-w-0 flex-1 touch-none select-none"
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); seek(e); }}
            onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e); }}>
            <div className="border-b border-line"><Ruler duration={length} grid={grid}/></div>
            {lanes.map((l, k) => <div key={k} className="border-b border-line-faint last:border-b-0">
              <ClipLane lane={l} color={LANE_COLORS[k]} dim={!audible(mute, solo, k)} length={length} grid={grid}/>
            </div>)}
            <div ref={playhead} className="pointer-events-none absolute inset-y-0 left-0 w-px bg-accent-edge" aria-hidden="true"/>
          </div>
        </div>
      </Frame>

      <Frame variant="panel" aria-labelledby="autotune">
        <FrameHeader>
          <FrameTitle id="autotune">Autotune</FrameTitle>
          {target?.l.dry && <FrameStatus><span className="type-label-sm text-text-3">Tuned</span></FrameStatus>}
        </FrameHeader>
        {!target ? <p className="p-4 type-body-sm text-text-2">Record your voice on a track first. Autotune corrects a take to a key and scale, and keeps the original.</p>
          : <div className="flex flex-wrap items-end gap-x-6 gap-y-4 p-4">
            <Field className="w-28"><FieldLabel>Track</FieldLabel>
              <Pick aria-label="Track to tune" value={String(target.k)} disabled={tuning !== null}
                items={voiceTakes.map(({ k }) => ({ value: String(k), label: `Track ${k + 1}` }))} onValueChange={v => setTuneTrack(Number(v))}/></Field>
            <Field className="w-24"><FieldLabel>Key</FieldLabel>
              <Pick aria-label="Key" value={String(key)} disabled={tuning !== null}
                items={NOTE_NAMES.map((n, i) => ({ value: String(i), label: n }))} onValueChange={v => setKey(Number(v))}/></Field>
            <Field className="w-44"><FieldLabel>Scale</FieldLabel>
              <Pick aria-label="Scale" value={scale} disabled={tuning !== null}
                items={(Object.keys(SCALES) as Scale[]).map(s => ({ value: s, label: SCALE_LABELS[s] }))} onValueChange={v => setScale(v as Scale)}/></Field>
            <div className="flex w-52 flex-col gap-1">
              <FieldTitle id="speed-label">Retune speed · {speed === 0 ? "Hard" : `${speed} ms`}</FieldTitle>
              <Slider aria-labelledby="speed-label" min={0} max={300} step={5} value={speed} disabled={tuning !== null}
                onValueChange={v => setSpeed(Array.isArray(v) ? v[0] : v)}/>
            </div>
            <div className="flex w-52 flex-col gap-1">
              <FieldTitle id="amount-label">Amount · {amount}%</FieldTitle>
              <Slider aria-labelledby="amount-label" min={0} max={100} value={amount} disabled={tuning !== null}
                onValueChange={v => setAmount(Array.isArray(v) ? v[0] : v)}/>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={tuning !== null || recording} onClick={() => void applyTune()}>
                {tuning !== null ? `Tuning ${Math.round(tuning * 100)}%` : target.l.dry ? "Tune again" : "Apply autotune"}
              </Button>
              {target.l.dry && <Button size="sm" variant="secondary" disabled={tuning !== null} onClick={revertTune}>Original</Button>}
            </div>
          </div>}
      </Frame>
    </main>
    <p className="shrink-0 px-4 pb-4 type-label-sm text-text-3">
      Use headphones to record · Space play or record · Level and shift sliders under each track · Latency lines a take up with the backing
    </p>
  </div>;
}
