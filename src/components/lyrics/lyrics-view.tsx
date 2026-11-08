"use client";

// Room links sweep through glimm (next/link handles the click itself, so a document-level interceptor never sees it).
import { TransitionLink as Link } from "glimm/next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cachedTracks, loadTracks } from "@/lib/storage";
import { onLyricsDone, startLyricsJob, useLyricsProgress } from "@/lib/background-jobs";
import { createDeckGraph, type DeckGraph } from "@/lib/deck-graph";
import { groupLines, indexAt, shifted, toLrc } from "@/lib/lyrics";
import { canRomanize, useLyricNotes } from "@/hooks/use-lyric-notes";
import { formatTime, type StoredTrack } from "@/lib/types";
import { PITCH_SHIFT_WORKLET, ratioOf, shifterLatency, shifterSize } from "@/lib/pitch-shift";
import { fitKey, loadSongRange, loadVoiceRange, rangeLabel, saveSongRange, saveVoiceRange, songRange, type VocalRange } from "@/lib/vocal-range";
import { cn } from "@/lib/sodium/utils";
import { Button } from "@/components/sodium/ui/button";
import { Switch } from "@/components/sodium/ui/switch";
import { Slider } from "@/components/sodium/ui/slider";
import { Status } from "@/components/sodium/ui/status";
import { Pick } from "@/components/pick";
import { Add, ArrowLeft, Download, Icon, Pause, Play, Previous, Subtract } from "@/components/sodium/icon";
import { VoiceScan } from "@/components/lyrics/voice-scan";

/* Karaoke: a track's lyrics with a time on every word (lib/lyrics, from Whisper through /api/lyrics), shown as the track
   plays. The line being sung is large, the words already sung are dark and the word now sung is marked; click a line to
   jump to it. A track with stems plays through the same eight-channel split the decks use, so Vocals turns the singer
   off and leaves the instrumental. Whisper's times can run a little early or late, so Earlier and Later move all of them.
   Key moves the whole song up or down in semitones without changing its tempo (lib/pitch-shift, in an AudioWorklet
   after the deck graph). Fit to my voice compares the singer's range, from a scan on the microphone, with the melody of
   the vocals stem and picks the key change that puts the song in that range (lib/vocal-range). */

const LANGUAGES = [
  { value: "auto", label: "Detect language" }, { value: "en", label: "English" }, { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" }, { value: "fr", label: "French" }, { value: "it", label: "Italian" },
  { value: "de", label: "German" }, { value: "ja", label: "Japanese" }, { value: "ko", label: "Korean" },
] as const;
const NUDGE = 0.1;
/** The furthest the key moves either way: past a fourth the shifted voice and drums start to sound processed. */
const MAX_KEY = 6;
const songKey = (t: StoredTrack) => t.fingerprint ?? t.id;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "\u2212" : ""}${Math.abs(n)}`;
/** Languages a translation can be written in: the code Whisper uses, and the name the model is asked for. */
const TRANSLATIONS = [
  { value: "off", label: "No translation" }, { value: "en", label: "English" }, { value: "es", label: "Spanish" }, { value: "pt", label: "Portuguese" },
  { value: "fr", label: "French" }, { value: "it", label: "Italian" }, { value: "de", label: "German" }, { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" }, { value: "zh", label: "Chinese" }, { value: "ru", label: "Russian" }, { value: "ar", label: "Arabic" }, { value: "hi", label: "Hindi" },
] as const;

/** Newest first, one entry per file (copies share a fingerprint). Of several copies the one with lyrics is kept, else the one with stems. */
function unique(all: StoredTrack[]) {
  const best = new Map<string, StoredTrack>();
  const rank = (t: StoredTrack) => (t.lyrics ? 2 : 0) + (t.stems ? 1 : 0);
  for (const t of [...all].sort((a, b) => a.addedAt - b.addedAt)) {
    const key = t.fingerprint ?? t.id, kept = best.get(key);
    if (!kept || rank(t) > rank(kept)) best.set(key, t);
  }
  return [...best.values()].sort((a, b) => b.addedAt - a.addedAt);
}

const fileNameOf = (t: StoredTrack) => `${[t.artist, t.title].filter(Boolean).join(" - ").replace(/[\\/:*?"<>|]/g, "") || "lyrics"}.lrc`;

export function LyricsView() {
  const [tracks, setTracks] = useState<StoredTrack[] | null>(cachedTracks);
  const [selected, setSelected] = useState<string | null>(null);
  const [language, setLanguage] = useState("auto");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [offset, setOffset] = useState(0);
  const [vocals, setVocals] = useState(true);
  /** How loud the singer is when the vocals are on, 0..100: lowered, the voice stays as a guide under the instrumental. */
  const [level, setLevel] = useState(100);
  /** What goes under each line: a translation into this language ("off" for none), and the Latin-letter reading. */
  const [translate, setTranslate] = useState("off");
  const [romanize, setRomanize] = useState(false);
  /** The line and word being sung, as indexes into the lines. */
  const [at, setAt] = useState({ line: -1, word: -1 });
  const transcribing = useLyricsProgress();
  /** Semitones the song is moved by. */
  const [semitones, setSemitones] = useState(0);
  const [voice, setVoice] = useState<VocalRange | null>(null);
  const [song, setSong] = useState<VocalRange | null>(null);
  /** Progress reading the vocals stem's melody, or null when not reading. */
  const [measuring, setMeasuring] = useState<number | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  /** Whether the key shifter's worklet loaded: null while loading. */
  const [shiftReady, setShiftReady] = useState<boolean | null>(null);

  const media = useRef<HTMLAudioElement | null>(null);
  const context = useRef<AudioContext | null>(null);
  const graph = useRef<DeckGraph | null>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const lineRefs = useRef<(HTMLElement | null)[]>([]);
  const shifter = useRef<AudioWorkletNode | null>(null);
  /** Seconds the key shifter holds the sound back, so the highlighted word waits for it. */
  const delay = useRef(0);
  const semitonesRef = useRef(0);
  /** A Fit to my voice that waits on the voice scan finishes once the range is saved. */
  const fitAfterScan = useRef(false);

  const all = useMemo(() => tracks ? unique(tracks) : null, [tracks]);
  const ready = useMemo(() => all?.filter(t => t.lyrics) ?? [], [all]);
  const missing = useMemo(() => all?.filter(t => !t.lyrics) ?? [], [all]);
  const track = ready.find(t => t.id === selected) ?? null;
  const words = useMemo(() => track?.lyrics ? shifted(track.lyrics.words, offset) : [], [track, offset]);
  const lines = useMemo(() => groupLines(words), [words]);
  const starts = useMemo(() => lines.map(l => l.t), [lines]);
  const texts = useMemo(() => lines.map(l => l.text), [lines]);
  const romanizable = useMemo(() => canRomanize(texts), [texts]);
  const targetName = TRANSLATIONS.find(t => t.value === translate)?.label ?? "English";
  const { notes, status: noteStatus, error: noteError } = useLyricNotes({
    trackId: track?.id ?? null, lines: texts, language: track?.lyrics?.language ?? "", romanize: romanize && romanizable,
    target: translate === "off" ? null : translate, targetName,
  });

  useEffect(() => {
    let live = true;
    loadTracks().then(list => { if (live) setTracks(list); }, () => { if (live) setTracks([]); });
    fetch("/api/lyrics").then(res => res.ok ? res.json() as Promise<{ available: boolean }> : { available: false })
      .then(res => { if (live) setAvailable(res.available); }, () => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, []);

  // /lyrics?track=<id> opens that track, the way the library's Karaoke link does.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("track");
    if (id) queueMicrotask(() => setSelected(id));
  }, []);

  // One audio context and one deck graph for the page's life; each track brings its own element. The key shifter goes
  // between the graph and the limiter once its worklet has loaded; until then, or if it cannot load, the graph plays direct.
  useEffect(() => {
    const ctx = new AudioContext();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
    limiter.connect(ctx.destination);
    const bus = ctx.createGain();
    bus.connect(limiter);
    context.current = ctx; graph.current = createDeckGraph(ctx, bus);
    let live = true;
    const url = URL.createObjectURL(new Blob([PITCH_SHIFT_WORKLET], { type: "text/javascript" }));
    ctx.audioWorklet.addModule(url).then(() => {
      if (!live) return;
      const node = new AudioWorkletNode(ctx, "pitch-shift", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
        processorOptions: { size: shifterSize(ctx.sampleRate) },
      });
      node.port.postMessage({ ratio: ratioOf(semitonesRef.current) });
      bus.disconnect(); bus.connect(node); node.connect(limiter);
      shifter.current = node; delay.current = shifterLatency(ctx.sampleRate);
      setShiftReady(true);
    }, () => { if (live) setShiftReady(false); }).finally(() => URL.revokeObjectURL(url));
    return () => { live = false; void ctx.close(); context.current = null; graph.current = null; shifter.current = null; delay.current = 0; };
  }, []);

  useEffect(() => {
    semitonesRef.current = semitones;
    shifter.current?.port.postMessage({ ratio: ratioOf(semitones) });
  }, [semitones]);

  useEffect(() => { queueMicrotask(() => setVoice(loadVoiceRange())); }, []);
  // The melody's range is kept per file once read.
  useEffect(() => { queueMicrotask(() => { setSong(track ? loadSongRange(songKey(track)) : null); setKeyMessage(null); }); }, [track]);

  const paint = useCallback(() => {
    const el = media.current;
    if (!el) return;
    const time = formatTime(el.currentTime);
    if (clock.current && clock.current.textContent !== time) clock.current.textContent = time;
  }, []);

  // The track's element: its stems file when it has one (so the vocals can be turned off), else the track itself.
  useEffect(() => {
    const ctx = context.current, g = graph.current;
    if (!ctx || !g || !track) return;
    const el = new Audio();
    el.preload = "auto";
    const url = URL.createObjectURL(track.stems ?? track.blob);
    el.src = url;
    const source = ctx.createMediaElementSource(el);
    source.connect(track.stems ? g.splitter : g.input);
    media.current = el;
    const sync = () => { setPlaying(!el.paused); paint(); };
    const meta = () => { if (Number.isFinite(el.duration)) setDuration(el.duration); paint(); };
    el.addEventListener("play", sync); el.addEventListener("pause", sync); el.addEventListener("ended", sync);
    el.addEventListener("seeked", paint); el.addEventListener("loadedmetadata", meta); el.addEventListener("durationchange", meta);
    return () => {
      el.pause(); source.disconnect();
      el.removeEventListener("play", sync); el.removeEventListener("pause", sync); el.removeEventListener("ended", sync);
      el.removeEventListener("seeked", paint); el.removeEventListener("loadedmetadata", meta); el.removeEventListener("durationchange", meta);
      el.removeAttribute("src"); el.load(); URL.revokeObjectURL(url);
      if (media.current === el) media.current = null;
      setPlaying(false); setDuration(0); setAt({ line: -1, word: -1 });
    };
  }, [track, paint]);

  // Vocals off keeps the other three stems; a track without stems has no vocals to turn off.
  useEffect(() => {
    const ctx = context.current, g = graph.current;
    if (!ctx || !g) return;
    g.stems[0].gain.setTargetAtTime(!track?.stems ? 1 : vocals ? (level / 100) ** 2 : 0, ctx.currentTime, 0.015);
  }, [vocals, level, track]);

  // The line and word under the playhead, read every frame while it plays; state changes only when they move.
  const follow = useCallback(() => {
    const el = media.current;
    if (!el) return;
    const time = el.currentTime - delay.current;
    const line = indexAt(starts, time);
    const word = line < 0 ? -1 : indexAt(lines[line].words.map(w => w.t), time);
    setAt(prev => prev.line === line && prev.word === word ? prev : { line, word });
    paint();
  }, [starts, lines, paint]);
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() { follow(); frame = requestAnimationFrame(tick); });
    return () => cancelAnimationFrame(frame);
  }, [playing, follow]);
  // A seek or a nudge while paused still moves the highlight.
  useEffect(() => { queueMicrotask(follow); }, [follow, offset, track]);

  // Keep the line being sung in the middle of the box.
  useEffect(() => {
    if (at.line < 0) return;
    lineRefs.current[at.line]?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [at.line]);

  const toggle = useCallback(async () => {
    const el = media.current;
    if (!el) return;
    if (el.paused) { await context.current?.resume(); await el.play().catch(() => undefined); } else el.pause();
  }, []);
  const jump = (seconds: number) => { const el = media.current; if (el) { el.currentTime = Math.max(0, seconds); follow(); } };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("button, input, a, [role=button], [role=slider], [role=combobox]") || t.isContentEditable)) return;
      e.preventDefault(); void toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle]);

  // A transcription that finishes while this page is open (started here or in the library) lands on its track and opens it.
  useEffect(() => onLyricsDone(d => {
    setTracks(list => list?.map(x => x.id === d.trackId ? { ...x, lyrics: d.lyrics } : x) ?? list);
    setSelected(d.trackId); setOffset(0);
  }), []);

  const pick = (id: string) => { setSelected(id); setOffset(0); setVocals(true); setLevel(100); setRomanize(false); setTranslate("off"); setSemitones(0); };

  const fit = async (range: VocalRange | null) => {
    if (!track) return;
    if (!range) { fitAfterScan.current = true; media.current?.pause(); setScanOpen(true); return; }
    let melody = song;
    if (!melody) {
      if (!track.stems) { setKeyMessage("Split the stems first: the melody is read from the vocals stem."); return; }
      setMeasuring(0); setKeyMessage(null);
      try {
        melody = await songRange(track.stems, setMeasuring);
      } catch {
        melody = null;
      } finally { setMeasuring(null); }
      if (!melody) { setKeyMessage("The vocals stem has too little steady singing to read a melody from."); return; }
      saveSongRange(songKey(track), melody); setSong(melody);
    }
    const best = fitKey(range, melody, MAX_KEY);
    setSemitones(best.shift);
    const where = best.octave < 0 ? " Sing an octave below the original singer." : best.octave > 0 ? " Sing an octave above the original singer." : "";
    const reach = best.outside > 0 ? ` About ${Math.round(best.outside)} semitones of the melody stay out of your range.` : "";
    setKeyMessage(`${best.shift === 0 ? "The original key suits your voice." : `${signed(best.shift)} semitones suits your voice.`}${where}${reach}`);
  };
  const saveVoice = (range: VocalRange) => {
    saveVoiceRange(range); setVoice(range);
    if (fitAfterScan.current) { fitAfterScan.current = false; void fit(range); }
  };
  const transcribe = (t: StoredTrack) => {
    if (transcribing[t.id] !== undefined) return;
    // The job and its toast live in lib/background-jobs: leaving this page does not stop them.
    void startLyricsJob({ id: t.id, title: t.title, blob: t.blob, fileName: t.fileName, stems: t.stems, language });
  };
  const download = () => {
    if (!track) return;
    const url = URL.createObjectURL(new Blob([toLrc(lines, { title: track.title, artist: track.artist }, true)], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = fileNameOf(track); a.click();
    URL.revokeObjectURL(url);
  };
  const busy = Object.keys(transcribing).length > 0;
  const state = busy ? "running" : track ? "ok" : "idle";

  return <div className="flex min-h-dvh flex-col bg-page text-text-1">
    <div className="px-4 pt-4">
      <header className="flex h-12 items-stretch border border-line bg-panel">
        <Link href="/" className="flex items-center gap-2 border-e border-line px-4 type-label text-text-2 hover:text-text-1"><Icon icon={ArrowLeft}/>Decks</Link>
        <h1 className="flex items-center px-4 type-heading-sm">Karaoke</h1>
        <div className="ms-auto flex items-center border-s border-line px-4">
          <Status size="sm" status={state}>{busy ? "Transcribing" : track ? "Ready" : "Pick a track"}</Status>
        </div>
      </header>
    </div>

    <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
      <section className="h-fit border border-line bg-panel lg:w-72 lg:shrink-0" aria-labelledby="tracks">
        <div className="flex h-12 items-center border-b border-line px-4"><h2 id="tracks" className="type-heading-sm">Tracks</h2></div>
        {all === null ? <p className="p-4 type-body-sm text-text-3">Loading the library…</p>
          : all.length === 0 ? <p className="p-4 type-body-sm text-text-2">The library is empty. Add tracks on the decks page.</p>
          : <>
            {ready.length === 0 && <p className="p-4 type-body-sm text-text-2">No track has lyrics yet. Transcribe one below, or from the library on the decks page.</p>}
            <ul className="divide-y divide-line-faint">
              {ready.map(t => <li key={t.id}>
                <Button variant={selected === t.id ? "secondary" : "ghost"} size="sm" onClick={() => pick(t.id)} aria-pressed={selected === t.id} className="w-full justify-between">
                  <span className="min-w-0 truncate">{t.title}</span>
                  {t.stems ? <span className="shrink-0 text-text-3">Stems</span> : null}
                </Button>
              </li>)}
            </ul>
            {missing.length > 0 && <div className="border-t border-line">
              <div className="flex items-center justify-between gap-2 px-4 py-2">
                <p className="type-label-sm text-text-3">Without lyrics</p>
                <Pick size="sm" items={LANGUAGES} value={language} onValueChange={setLanguage} aria-label="Language of the lyrics" className="w-36"/>
              </div>
              {available === false && <p role="alert" className="px-4 pb-2 type-body-sm text-fail-text">Whisper is not installed on this machine. Run npm run setup:whisper.</p>}
              <ul className="divide-y divide-line-faint border-t border-line-faint">
                {missing.map(t => <li key={t.id} className="flex items-center gap-2 px-4 py-1">
                  <span className="min-w-0 flex-1 truncate type-body-sm text-text-2">{t.title}</span>
                  <Button size="sm" variant="secondary" disabled={!available || busy} onClick={() => transcribe(t)}>
                    {transcribing[t.id] !== undefined ? `${Math.round(transcribing[t.id] * 100)}%` : "Transcribe"}
                  </Button>
                </li>)}
              </ul>
            </div>}
          </>}
      </section>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col border border-line bg-panel" aria-labelledby="lyrics">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <Button size="icon-sm" variant="secondary" onClick={() => jump(0)} disabled={!track} aria-label="Back to start"><Icon icon={Previous}/></Button>
          <Button size="icon-sm" onClick={() => void toggle()} disabled={!track} aria-label={playing ? "Pause" : "Play"}><Icon icon={playing ? Pause : Play}/></Button>
          <span className="type-code-sm text-text-1"><span ref={clock}>00:00</span><span className="text-text-3"> / {formatTime(duration || track?.duration || 0)}</span></span>
          <h2 id="lyrics" className="ms-auto min-w-0 truncate type-heading-sm">{track ? track.title : "Lyrics"}</h2>
        </div>

        {track && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <label className={cn("flex items-center gap-2 type-label-sm", track.stems ? "text-text-2" : "text-text-disabled")}>
            <Switch checked={vocals || !track.stems} disabled={!track.stems} onCheckedChange={setVocals} aria-label="Vocals"/>Vocals
          </label>
          {track.stems
            ? <Slider min={0} max={100} value={level} disabled={!vocals} aria-label="Vocals volume" format={{ style: "unit", unit: "percent" }} showValue
                onValueChange={v => setLevel(Array.isArray(v) ? v[0] : v as number)} className="w-48"/>
            : <span className="type-body-sm text-text-3">Split the stems to turn the singer off or down.</span>}
          {romanizable && <label className="flex items-center gap-2 type-label-sm text-text-2">
            <Switch checked={romanize} onCheckedChange={setRomanize} aria-label="Romanize"/>{noteStatus.roman === "loading" ? "Romanizing…" : "Romanize"}
          </label>}
          <Pick size="sm" items={TRANSLATIONS} value={translate} onValueChange={setTranslate} aria-label="Translate the lyrics" className="w-40"/>
          {noteStatus.translation === "loading" && <span className="type-label-sm text-text-3">Translating…</span>}
          <span className="ms-auto type-label-sm text-text-3">Timing</span>
          <Button size="sm" variant="secondary" onClick={() => setOffset(o => Math.round((o - NUDGE) * 10) / 10)}>Earlier</Button>
          <span className="w-16 text-center type-code-sm text-text-1">{`${offset > 0 ? "+" : ""}${offset.toFixed(1)} s`}</span>
          <Button size="sm" variant="secondary" onClick={() => setOffset(o => Math.round((o + NUDGE) * 10) / 10)}>Later</Button>
          <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(0)}>Reset</Button>
          <Button size="sm" variant="ghost" onClick={download}><Icon icon={Download}/>Download LRC</Button>
          {/* Lyrics written by an older or smaller model, or in the wrong language, can be written again over these. */}
          <Button size="sm" variant="ghost" disabled={!available || busy} onClick={() => transcribe(track)}>
            {transcribing[track.id] !== undefined ? `${Math.round(transcribing[track.id] * 100)}%` : "Transcribe again"}
          </Button>
        </div>}

        {track && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <span className="type-label-sm text-text-3">Key</span>
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="secondary" disabled={!shiftReady || semitones <= -MAX_KEY} onClick={() => setSemitones(k => k - 1)} aria-label="Key down a semitone"><Icon icon={Subtract}/></Button>
            <output className="w-12 text-center type-code-sm text-text-1" aria-label="Key change in semitones">{signed(semitones) || "0"}</output>
            <Button size="icon-sm" variant="secondary" disabled={!shiftReady || semitones >= MAX_KEY} onClick={() => setSemitones(k => k + 1)} aria-label="Key up a semitone"><Icon icon={Add}/></Button>
          </div>
          <Button size="sm" variant="ghost" disabled={semitones === 0} onClick={() => setSemitones(0)}>Original key</Button>
          <Button size="sm" variant="secondary" pending={measuring !== null} pendingLabel={measuring !== null ? `Reading melody ${Math.round(measuring * 100)}%` : undefined}
            disabled={!shiftReady || (!track.stems && !song)} onClick={() => void fit(voice)}>Fit to my voice</Button>
          <Button size="sm" variant="ghost" onClick={() => { fitAfterScan.current = false; media.current?.pause(); setScanOpen(true); }}>{voice ? "Scan voice again" : "Scan my voice"}</Button>
          <p className="w-full type-body-sm text-text-2" aria-live="polite">
            {shiftReady === false ? "This browser cannot run the key shifter (AudioWorklet)." : keyMessage ?? (!voice ? "Scan your voice once, then fit any song's key to it."
              : !track.stems && !song ? "Split the stems to fit this song: its melody is read from the vocals stem."
              : `Your range: ${rangeLabel(voice)}.${song ? ` The melody: ${rangeLabel(song)}.` : ""}`)}
          </p>
        </div>}

        {noteError && <p role="alert" className="border-b border-line px-4 py-2 type-body-sm text-fail-text">{noteError}</p>}
        {!track ? <p className="p-4 type-body-sm text-text-2">Choose a track to sing along. Its words light up as they come, and a click on a line jumps to it.</p>
          : <div className="relative max-h-(--box) min-h-0 flex-1 overflow-y-auto" style={{ "--box": "calc(100dvh - 15rem)" } as React.CSSProperties} tabIndex={0} aria-label="Lyrics">
            <ol className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-[30vh] text-center">
              {lines.map((line, i) => {
                const current = i === at.line;
                return <li key={`${line.t}-${i}`} ref={el => { lineRefs.current[i] = el; }} className="w-full">
                  <div role="button" tabIndex={0} onClick={() => jump(line.t)} aria-current={current ? "true" : undefined}
                    data-state={current ? "now" : i < at.line ? "past" : "next"} data-far={Math.abs(i - at.line) > 2}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(line.t); } }}
                    className="t-lyric type-title w-full cursor-pointer text-balance text-text-1 focus-visible:focus-ring-inset">
                    {notes.roman?.[i] ? <span className="block type-body-sm text-text-2">{notes.roman[i]}</span> : null}
                    {current ? line.words.map((w, k) => <span key={k} className={cn("t-lyric-word", k < at.word ? "text-text-1" : k === at.word ? "text-accent-text" : "text-text-3")}>{w.w}{k < line.words.length - 1 ? " " : ""}</span>) : line.text}
                    {notes.translation?.[i] ? <span className="mt-1 block type-body-sm text-text-2 italic">{notes.translation[i]}</span> : null}
                  </div>
                </li>;
              })}
            </ol>
          </div>}
      </section>
    </main>
    <VoiceScan open={scanOpen} onOpenChange={open => { setScanOpen(open); if (!open) fitAfterScan.current = false; }} saved={voice} onSave={saveVoice}/>
    <p className="shrink-0 px-4 pb-4 type-label-sm text-text-3">Space play · click a line to jump to it · Earlier and Later move the timing</p>
  </div>;
}
