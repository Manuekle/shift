"use client";

// Room links sweep through glimm (next/link handles the click itself, so a document-level interceptor never sees it).
import { TransitionLink as Link } from "glimm/next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cachedTracks, loadTracks } from "@/lib/storage";
import { onDownloaded, onStemsDone, startStemJob, takePendingImports, useStemProgress } from "@/lib/background-jobs";
import { importToLibrary } from "@/lib/library-import";
import { stemPeaks, type StemPeaks } from "@/lib/stem-peaks";
import { EFFECTS, STEMS, formatTime, type EffectName, type StoredTrack, type Track, type TransitionPlan } from "@/lib/types";
import { planToMix } from "@/lib/stem-plan";
import { planTransition } from "@/lib/transition-planner";
import { mixFeatures } from "@/lib/mix-features";
import { EFFECT_OPTIONS, STEM_OPTIONS } from "@/lib/transition-options";
import {
  EDGE_OPTIONS, FADE_OPTIONS, SNAP_OPTIONS, alignOffset, crossfade, barLoop, barNumber, clampView, floorTo, lengthOf, makeLayerMix, makeTrackEdit, overlap,
  swapStem, syncRatio, zoomView, type Cut, type FadeShape, type Loop, type Placement, type Strip, type TrackEdit, type View, type VolumePoint,
} from "@/lib/stem-mix";
import { Timeline, gridOf, type TimelineLayer, type Tool } from "@/components/stems/timeline";
import { useStemEngine, type EngineLayer } from "@/components/stems/use-stem-engine";
import { LinkImport } from "@/components/stems/link-import";
import { Pick } from "@/components/pick";
import { toast } from "@/components/sodium/ui/toast";
import { Button } from "@/components/sodium/ui/button";
import { Slider } from "@/components/sodium/ui/slider";
import { SegmentedControl, SegmentedControlItem } from "@/components/sodium/ui/segmented-control";
import { Switch } from "@/components/sodium/ui/switch";
import { Status } from "@/components/sodium/ui/status";
import { Add, ArrowLeft, Download, Icon, Lightning, Pause, Play, Previous, Repeat, Shrink, Sparkles, Subtract } from "@/components/sodium/icon";


/* The Stems page. Edit: one track, its four stems on their own lanes with a channel each (mute, solo, level, filter, pan),
   cuts that silence one stem for a stretch, and a loop. Mix: two tracks on one timeline, the second one synced to the
   first one's tempo and dragged to where it should come in, with the same lanes and cuts for both, so any stem of one
   plays against any stem of the other; the stem swaps of a transition are one click at the playhead. The edits are kept
   in this browser. */

type Mode = "edit" | "mix";
type PlanInfo = { by: "auto" | "ai"; model?: string; notes: string[]; score?: number; title: string };
type Saved = {
  mode: Mode; selected: string | null; a: string | null; b: string | null; offset: number; sync: boolean;
  edits: Record<string, TrackEdit>; mixEdits: [TrackEdit, TrackEdit]; snap: string; edge: string; autoSplit: boolean;
  /** How A fades out and B in; anything but custom is worked out from where B sits. */
  fade: FadeShape;
  /** The plan the mix was last laid out from, for its notes. */
  plan: PlanInfo | null;
};
const KEY = "shift.stems.v1";
const LOOP_BARS = [1, 2, 4, 8, 16];
const SWAPS = [{ label: "Bass", stems: [2] }, { label: "Drums", stems: [1] }, { label: "Vocals", stems: [0] }, { label: "Melody", stems: [3] }, { label: "All", stems: [0, 1, 2, 3] }];
const barSpan = (a: number, b: number) => a === b ? `Bar ${a}` : `Bars ${a}–${b}`;
const first = (v: number | readonly number[]) => Array.isArray(v) ? v[0] : v as number;

function initial(): Saved {
  const base: Saved = { mode: "edit", selected: null, a: null, b: null, offset: 0, sync: true, edits: {}, mixEdits: [makeTrackEdit(), makeTrackEdit()], snap: "1", edge: "0.25", autoSplit: true, fade: "smooth", plan: null };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...base, ...JSON.parse(raw) as Partial<Saved> } : base;
  } catch { return base; }
}

/** Newest first, one entry per file (copies share a fingerprint). Of several copies the one with stems is kept, else the oldest. */
function withStems(all: StoredTrack[]) {
  const best = new Map<string, StoredTrack>();
  for (const t of [...all].sort((a, b) => a.addedAt - b.addedAt)) {
    const key = t.fingerprint ?? t.id, kept = best.get(key);
    if (!kept || (!kept.stems && t.stems)) best.set(key, t);
  }
  return [...best.values()].sort((a, b) => b.addedAt - a.addedAt);
}

/** Where the second track comes in by default: its first beat on the bar 16 bars before the first track ends. */
function defaultOffset(a: StoredTrack, b: StoredTrack, ratio: number) {
  const ga = gridOf(a), gb = gridOf(b);
  const lead = ga ? 64 * ga.beat : 30;
  return Math.max(0, alignOffset(Math.max(0, a.duration - lead), ga, gb, ratio, 4));
}

export function StemsView() {
  const [tracks, setTracks] = useState<StoredTrack[] | null>(cachedTracks);
  const [saved, setSaved] = useState<Saved>(initial);
  const { mode, selected, sync, snap, edge } = saved;
  const patch = (p: Partial<Saved>) => setSaved(s => ({ ...s, ...p }));
  const [peaks, setPeaks] = useState<Record<string, StemPeaks[]>>({});
  const [reading, setReading] = useState<Record<string, "reading" | "failed">>({});
  const [speed, setSpeed] = useState(1);
  const [keepPitch, setKeepPitch] = useState(true);
  const [tool, setTool] = useState<Tool>("move");
  const [loop, setLoop] = useState<Loop | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [focus, setFocus] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const splitting = useStemProgress();
  // Whether /api/mix can reach Ollama with its model, asked once per visit.
  const [aiAvailable, setAiAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/mix").then(r => r.ok ? r.json() as Promise<{ available: boolean }> : { available: false }, () => ({ available: false }))
      .then(b => { if (live) setAiAvailable(!!b.available); });
    return () => { live = false; };
  }, []);

  const playhead = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const barText = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let live = true;
    loadTracks().then(list => { if (live) setTracks(list); }, () => { if (live) setTracks([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* private window or full: edits live for this visit */ } }, [saved]);

  const all = useMemo(() => tracks ? withStems(tracks) : null, [tracks]);
  const ready = useMemo(() => all?.filter(t => t.stems) ?? [], [all]);
  const missing = useMemo(() => all?.filter(t => !t.stems) ?? [], [all]);
  const byId = (id: string | null) => ready.find(t => t.id === id) ?? null;

  // The layers on the timeline: one in edit mode, two (or one while the second is unchosen) in mix mode.
  const trackA = mode === "edit" ? byId(selected) : byId(saved.a);
  const trackB = mode === "mix" ? byId(saved.b) : null;
  const ratioB = trackA && trackB && sync ? syncRatio(trackA.bpm, trackB.bpm) : 1;
  const storedA = mode === "edit" ? (trackA && saved.edits[trackA.id]) || makeTrackEdit() : saved.mixEdits[0];
  const storedB = saved.mixEdits[1];

  const engineLayers: EngineLayer[] = [];
  const fadeBeats = Number(edge);
  // A layer's length is its media's once known: the analysis can be a few ms off the stems file.
  const [durations, setDurations] = useState<[number, number]>([0, 0]);
  const placeA: Placement = { offset: 0, ratio: 1, duration: durations[0] || trackA?.duration || 0 };
  const placeB: Placement = { offset: saved.offset, ratio: ratioB, duration: durations[1] || trackB?.duration || 0 };
  // In mix mode the volume curves follow B until one is drawn by hand: the fade spans what both tracks cover.
  const blend = trackA && trackB ? overlap(placeA, placeB) : null;
  const baseGridEarly = trackA ? gridOf(trackA) : null;
  const autoCurves = mode === "mix" && trackB && saved.fade !== "custom"
    ? crossfade(placeA, placeB, saved.fade, blend, blend ? floorTo((blend.from + blend.to) / 2, baseGridEarly, 4) : undefined) : null;
  const editA: TrackEdit = autoCurves ? { ...storedA, volume: autoCurves[0] } : storedA;
  const editB: TrackEdit = autoCurves ? { ...storedB, volume: autoCurves[1] } : storedB;
  engineLayers.push({ track: trackA, placement: placeA, edit: editA, fadeBeats });
  engineLayers.push({ track: trackB, placement: placeB, edit: editB, fadeBeats });
  const baseGrid = trackA ? gridOf(trackA) : null;
  const viewRef = useRef<View>({ from: 0, span: 0 });
  const baseGridRef = useRef(baseGrid);
  useEffect(() => { baseGridRef.current = baseGrid; });

  // Playhead, clock and bar number move every frame without a render; the view follows the playhead page by page.
  const drawn = useRef({ left: "", time: "", bar: "" });
  const followRef = useRef(false);
  const onFrame = useCallback((t: number) => {
    const v = viewRef.current;
    if (followRef.current && v.span && (t > v.from + v.span || t < v.from)) {
      setView(clampView({ from: t - v.span * 0.05, span: v.span }, Infinity));
    }
    const x = v.span ? (t - v.from) / v.span : 0;
    const left = x < 0 || x > 1 ? "hidden" : `${x * 100}%`;
    if (playhead.current && drawn.current.left !== left) {
      playhead.current.style.display = left === "hidden" ? "none" : "";
      if (left !== "hidden") playhead.current.style.left = left;
      drawn.current.left = left;
    }
    const time = formatTime(t), bar = barNumber(t, baseGridRef.current);
    if (clock.current && drawn.current.time !== time) { clock.current.textContent = time; drawn.current.time = time; }
    const barLabel = bar === null ? "" : `Bar ${bar}`;
    if (barText.current && drawn.current.bar !== barLabel) { barText.current.textContent = barLabel; drawn.current.bar = barLabel; }
  }, []);

  const engine = useStemEngine({ layers: engineLayers, speed, keepPitch, loop: loopOn ? loop : null, onFrame, onDurations: setDurations });
  useEffect(() => { followRef.current = engine.playing; }, [engine.playing]);
  const total = lengthOf(engineLayers.filter(l => l.track).map(l => l.placement));
  const shown = clampView(view ?? { from: 0, span: total }, total);
  useEffect(() => { viewRef.current = shown; });
  const engineRef = useRef(engine);
  useEffect(() => { engineRef.current = engine; });

  // Re-fit the view and clear the loop when the tracks on the timeline change.
  /** The view around the blend, 8 bars either side; the whole timeline when there is none. */
  const blendView = () => {
    if (!blend) return null;
    const pad = baseGrid ? baseGrid.beat * 32 : 15;
    return clampView({ from: blend.from - pad, span: blend.to - blend.from + 2 * pad }, total);
  };
  const blendViewRef = useRef(blendView);
  useEffect(() => { blendViewRef.current = blendView; });
  const idsKey = `${mode}|${trackA?.id ?? ""}|${trackB?.id ?? ""}`;
  const lastIds = useRef(idsKey);
  useEffect(() => {
    if (lastIds.current === idsKey) return;
    lastIds.current = idsKey;
    queueMicrotask(() => { setView(blendViewRef.current()); setLoop(null); setLoopOn(false); setFocus(0); });
  }, [idsKey]);
  // Paint the playhead again when the view moves.
  useEffect(() => { onFrame(engineRef.current.now()); }, [shown.from, shown.span, onFrame]);

  // Waveforms of the tracks on the timeline, read once per track and kept for the visit.
  useEffect(() => {
    for (const t of [trackA, trackB]) {
      if (!t?.stems || peaks[t.id] || reading[t.id]) continue;
      const id = t.id, blob = t.stems;
      queueMicrotask(() => setReading(r => ({ ...r, [id]: "reading" })));
      stemPeaks(blob, Math.min(20000, Math.max(2400, Math.round(t.duration * 40)))).then(
        p => { setPeaks(m => ({ ...m, [id]: p })); setReading(r => { const rest = { ...r }; delete rest[id]; return rest; }); },
        () => setReading(r => ({ ...r, [id]: "failed" })),
      );
    }
  }, [trackA, trackB, peaks, reading]);

  const updateEdit = (layer: number, fn: (e: TrackEdit) => TrackEdit) => setSaved(s => {
    if (s.mode === "mix") return { ...s, mixEdits: s.mixEdits.map((e, i) => i === layer ? fn(e) : e) as [TrackEdit, TrackEdit] };
    if (!s.selected) return s;
    return { ...s, edits: { ...s.edits, [s.selected]: fn(s.edits[s.selected] ?? makeTrackEdit()) } };
  });
  const onStrip = (layer: number, stem: number, p: Partial<Strip>) => updateEdit(layer, e => ({ ...e, strips: e.strips.map((s, k) => k === stem ? { ...s, ...p } : s) }));
  /** A drawn curve. In mix mode the first edit turns the worked-out fade into points of both curves, then edits them. */
  const onVolume = (layer: number, points: VolumePoint[], stem: number | null = null) => setSaved(s => {
    if (stem !== null) {
      const put = (e: TrackEdit): TrackEdit => {
        const curves = [0, 1, 2, 3].map(k => e.stemVolume?.[k] ?? []);
        curves[stem] = points;
        return { ...e, stemVolume: curves };
      };
      if (s.mode === "mix") return { ...s, mixEdits: s.mixEdits.map((e, i) => i === layer ? put(e) : e) as [TrackEdit, TrackEdit] };
      return s.selected ? { ...s, edits: { ...s.edits, [s.selected]: put(s.edits[s.selected] ?? makeTrackEdit()) } } : s;
    }
    if (s.mode !== "mix") {
      if (!s.selected) return s;
      return { ...s, edits: { ...s.edits, [s.selected]: { ...(s.edits[s.selected] ?? makeTrackEdit()), volume: points } } };
    }
    const base = s.fade !== "custom" && autoCurves ? s.mixEdits.map((e, i) => ({ ...e, volume: autoCurves[i] })) : s.mixEdits;
    return { ...s, fade: "custom", mixEdits: base.map((e, i) => i === layer ? { ...e, volume: points } : e) as [TrackEdit, TrackEdit] };
  });
  const onCuts = (layer: number, fn: (c: Cut[]) => Cut[]) => updateEdit(layer, e => ({ ...e, cuts: fn(e.cuts) }));
  const setMix = (layer: number, p: Partial<TrackEdit["mix"]>) => updateEdit(layer, e => ({ ...e, mix: { ...e.mix, ...p } }));

  const pickEdit = (id: string) => { patch({ selected: id }); setSpeed(1); };
  /** Puts a track in slot A or B of the mix; a track already in the other slot swaps places. */
  const pickMix = (slot: "a" | "b", id: string) => setSaved(s => {
    const other = slot === "a" ? "b" : "a";
    const next: Saved = { ...s, [slot]: id, [other]: s[other] === id ? s[slot] : s[other] };
    next.mixEdits = [slot === "a" || s[other] === id ? makeTrackEdit() : s.mixEdits[0], slot === "b" || s[other] === id ? makeTrackEdit() : s.mixEdits[1]];
    if (s.fade === "custom") next.fade = "smooth";
    next.plan = null;
    const a = ready.find(t => t.id === next.a), b = ready.find(t => t.id === next.b);
    if (a && b) next.offset = defaultOffset(a, b, s.sync ? syncRatio(a.bpm, b.bpm) : 1);
    return next;
  });

  async function split(t: StoredTrack) {
    if (splitting[t.id] !== undefined) return;
    await startStemJob({ id: t.id, title: t.title, blob: t.blob, fileName: t.fileName });
  }
  /** A finished split opens its track: the edited one in edit mode, the first empty slot in mix mode. */
  const openRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    openRef.current = id => setSaved(s => s.mode === "edit" ? { ...s, selected: id } : !s.a ? { ...s, a: id } : !s.b && s.a !== id ? { ...s, b: id } : s);
  });
  useEffect(() => onStemsDone(d => {
    setTracks(list => list?.map(x => x.id === d.trackId ? { ...x, stems: d.blob, stemEnergy: d.stemEnergy } : x) ?? list);
    openRef.current(d.trackId);
  }), []);

  // Downloads from a link land here while this page is open: into the library, then split when asked.
  const autoSplit = useRef(saved.autoSplit);
  useEffect(() => { autoSplit.current = saved.autoSplit; });
  useEffect(() => {
    let n = 0;
    const take = async (files: File[]) => {
      for (const file of files) {
        const id = `stems-add-${++n}`;
        toast.loading(`Adding ${file.name}`, { id, description: "Reading tempo and key" });
        try {
          const { track, duplicate } = await importToLibrary(file, await loadTracks());
          if (!duplicate) setTracks(list => list ? [track, ...list] : [track]);
          toast.update(id, "success", duplicate ? `${track.title} is already in the library` : `${track.title} added to the library`);
          if (track.stems) openRef.current(track.id);
          else if (autoSplit.current) await startStemJob({ id: track.id, title: track.title, blob: track.blob, fileName: track.fileName });
        } catch { toast.update(id, "fail", `Could not add ${file.name}`); }
      }
    };
    const waiting = takePendingImports();
    if (waiting.length) void take(waiting);
    return onDownloaded(files => { void take(files); });
  }, []);

  const setLoopFrom = (bars: number) => { setLoop(barLoop(engine.now(), baseGrid, bars)); setLoopOn(true); };
  const toggleLoop = () => {
    if (!loop) { setLoopFrom(4); return; }
    setLoopOn(on => !on);
  };
  const zoom = (factor: number) => setView(zoomView(shown, factor, engine.playing ? engine.now() : shown.from + shown.span / 2, total));

  const toggleLoopRef = useRef(toggleLoop), zoomRef = useRef(zoom);
  useEffect(() => { toggleLoopRef.current = toggleLoop; zoomRef.current = zoom; });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, [role=dialog]") || t.isContentEditable)) return;
      const onControl = !!t?.closest("button, a, [role=slider]");
      if (e.code === "Space" && !onControl) { e.preventDefault(); engineRef.current.toggle(); return; }
      const k = e.key.toLowerCase();
      if (k === "l") toggleLoopRef.current();
      else if (k === "v") setTool("move");
      else if (k === "r") setTool("loop");
      else if (k === "c") setTool("cut");
      else if (k === "=" || k === "+") zoomRef.current(0.6);
      else if (k === "-") zoomRef.current(1 / 0.6);
      else if (k === "0") setView(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const layers: TimelineLayer[] = [];
  if (trackA) layers.push({ key: `a-${trackA.id}`, name: mode === "mix" ? "A" : null, track: trackA, placement: engineLayers[0].placement, edit: editA, peaks: peaks[trackA.id], grid: gridOf(trackA), movable: false, curve: "--data-1" });
  if (trackA && trackB) layers.push({ key: `b-${trackB.id}`, name: "B", track: trackB, placement: engineLayers[1].placement, edit: editB, peaks: peaks[trackB.id], grid: gridOf(trackB), movable: true, curve: "--text-1" });

  const focused = Math.min(focus, layers.length - 1);
  const focusedEdit = focused === 1 ? editB : editA;
  const both = overlap(engineLayers[0].placement, engineLayers[1].placement);
  /** Loops the blend with 4 bars before it and 2 after, shows it and plays it. */
  /** Lays a transition plan onto the mix: B's place and tempo, both volume curves, a curve per moved stem. */
  const applyPlan = (plan: TransitionPlan, info: Omit<PlanInfo, "title" | "notes"> & { notes?: string[] }) => {
    if (!trackA || !trackB) return;
    const fit = planToMix(plan, trackA, trackB);
    const notes = [...(info.notes ?? plan.notes ?? [])];
    if (plan.effect !== "none") notes.push(`The ${EFFECT_OPTIONS.find(o => o.value === plan.effect)?.label.toLowerCase() ?? plan.effect} effect plays on the decks only; it is not laid out here.`);
    const label = STEM_OPTIONS.find(o => o.value === (plan.stems ?? "none"))?.label ?? "No stem move";
    const title = `${plan.bars} ${plan.bars === 1 ? "bar" : "bars"} · ${plan.volume} curve · ${plan.stems && plan.stems !== "none" ? label.toLowerCase() : plan.eq !== "none" ? `${plan.eq} eq` : "no stem move"}`;
    setSaved(st => ({
      ...st, offset: fit.offset, sync: plan.sync !== false, fade: "custom",
      mixEdits: [
        { ...st.mixEdits[0], cuts: [], volume: fit.volume[0], stemVolume: fit.stems[0] },
        { ...st.mixEdits[1], cuts: [], volume: fit.volume[1], stemVolume: fit.stems[1] },
      ],
      plan: { ...info, notes, title },
    }));
    const bar = baseGrid ? baseGrid.beat * 4 : 2;
    setLoop({ from: Math.max(0, fit.span.from - 4 * bar), to: fit.span.to + 2 * bar }); setLoopOn(false);
    const pad = baseGrid ? baseGrid.beat * 32 : 15;
    setView({ from: Math.max(0, fit.span.from - pad), span: fit.span.to - fit.span.from + 2 * pad });
    engine.seek(Math.max(0, fit.span.from - 4 * bar));
  };
  const asTrack = (t: StoredTrack): Track => ({ ...t, url: "" });
  /** The decks' own automatic planner, on this pair. */
  const autoBlend = () => {
    if (!trackA || !trackB) return;
    try {
      const r = planTransition(asTrack(trackA), asTrack(trackB));
      applyPlan(r.plan, { by: "auto", score: Math.round(r.score) });
      toast.success("Automatic blend laid out", { description: "Preview it, or ask the AI for a second opinion." });
    } catch { toast.fail("Could not plan this pair"); }
  };
  /** The local model through /api/mix, given the automatic plan to improve on, as the decks' AI plan does. */
  const [planning, setPlanning] = useState(false);
  const [allNotes, setAllNotes] = useState(false);
  const aiBlend = async () => {
    if (!trackA || !trackB || planning) return;
    const id = "stems-ai-blend";
    setPlanning(true);
    toast.loading(`AI is planning ${trackA.title} into ${trackB.title}`, { id, description: "On the local model; the first answer can take a minute." });
    try {
      const auto = planTransition(asTrack(trackA), asTrack(trackB)).plan;
      const res = await fetch("/api/mix", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: mixFeatures(asTrack(trackA)), to: mixFeatures(asTrack(trackB)), auto }) });
      const body = await res.json() as { plan?: Partial<TransitionPlan>; model?: string; error?: string };
      if (!res.ok || !body.plan) throw new Error(body.error ?? "The AI plan failed");
      applyPlan({ ...auto, ...body.plan } as TransitionPlan, { by: "ai", model: body.model });
      toast.update(id, "success", "AI blend laid out. Preview it.");
    } catch (e) {
      toast.update(id, "fail", e instanceof Error ? e.message : "The AI plan failed");
    } finally { setPlanning(false); }
  };
  const previewBlend = () => {
    if (!both) return;
    const bar = baseGrid ? baseGrid.beat * 4 : 2;
    const l = { from: Math.max(0, floorTo(both.from, baseGrid, 4) - 4 * bar), to: Math.min(total, both.to + 2 * bar) };
    setLoop(l); setLoopOn(true); setView(blendView());
    engine.seek(l.from);
    if (!engine.playing) void engine.play();
  };
  const swap = (stems: number[]) => {
    if (!trackA || !trackB || !both) return;
    const at = Math.min(both.to, Math.max(both.from, floorTo(engine.now(), baseGrid, 4)));
    setSaved(s => {
      let [a, b] = s.mixEdits;
      for (const k of stems) [a, b] = swapStem(a, engineLayers[0].placement, b, engineLayers[1].placement, k, at, () => crypto.randomUUID());
      return { ...s, mixEdits: [a, b] };
    });
    toast.success(`${stems.length === 4 ? "Everything" : STEMS[stems[0]].label} swaps at ${barNumber(at, baseGrid) ? `bar ${barNumber(at, baseGrid)}` : formatTime(at)}`);
  };
  const cutCount = layers.reduce((n, l) => n + l.edit.cuts.length, 0);
  const stemCurves = layers.some(l => l.edit.stemVolume?.some(c => c.length > 0));
  const anyReading = [trackA, trackB].some(t => t && reading[t.id] === "reading");
  const anyFailed = [trackA, trackB].some(t => t && reading[t.id] === "failed");
  const bBar = trackB && baseGrid ? barNumber(saved.offset + (gridOf(trackB)?.first ?? 0) / ratioB, baseGrid) : null;

  return <div className="flex min-h-dvh flex-col bg-page text-text-1">
    <div className="px-4 pt-4">
      <header className="flex h-12 items-stretch border border-line bg-panel">
        <Link href="/" className="flex items-center gap-2 border-e border-line px-4 type-label text-text-2 hover:text-text-1"><Icon icon={ArrowLeft}/>Decks</Link>
        <h1 className="flex items-center px-4 type-heading-sm">Stems</h1>
        <div className="flex items-center border-s border-line px-4">
          <SegmentedControl size="sm" aria-label="Mode" value={mode} onValueChange={v => { engine.pause(); patch({ mode: v as Mode }); }}>
            <SegmentedControlItem value="edit">Edit</SegmentedControlItem>
            <SegmentedControlItem value="mix">Mix</SegmentedControlItem>
          </SegmentedControl>
        </div>
        <div className="ms-auto flex items-center border-s border-line px-4">
          <Status size="sm" status={anyReading ? "running" : anyFailed ? "fail" : "idle"}>
            {anyReading ? "Reading waveforms" : anyFailed ? "Could not read" : trackA ? "Ready" : mode === "mix" ? "Pick two tracks" : "Pick a track"}
          </Status>
        </div>
      </header>
    </div>

    <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
      <section className="h-fit border border-line bg-panel lg:w-72 lg:shrink-0" aria-labelledby="tracks">
        <div className="flex h-12 items-center gap-2 border-b border-line ps-4 pe-2">
          <h2 id="tracks" className="type-heading-sm">Tracks</h2>
          <Button className="ms-auto" size="sm" variant="secondary" onClick={() => setLinkOpen(true)}><Icon icon={Download}/>Import link</Button>
        </div>
        {all === null ? <p className="p-4 type-body-sm text-text-3">Loading the library…</p>
          : all.length === 0 ? <p className="p-4 type-body-sm text-text-2">The library is empty. Import a link above, or add files on the decks page.</p>
          : <>
            {ready.length === 0 && <p className="p-4 type-body-sm text-text-2">No track has stems yet. Split one below; it shows up here.</p>}
            {mode === "mix" && ready.length > 0 && <p className="border-b border-line-faint px-4 py-2 type-body-sm text-text-3">Put one track in A and the one that comes in after it in B.</p>}
            <ul className="divide-y divide-line-faint">
              {ready.map(t => <li key={t.id} className="flex items-center gap-1 pe-2">
                {mode === "edit"
                  ? <Button variant={selected === t.id ? "secondary" : "ghost"} size="sm" onClick={() => pickEdit(t.id)} aria-pressed={selected === t.id} className="w-full justify-between">
                    <span className="min-w-0 truncate">{t.title}</span>
                    {t.bpm ? <span className="shrink-0 text-text-3">{Math.round(t.bpm)}</span> : null}
                  </Button>
                  : <>
                    <span className="min-w-0 flex-1 truncate ps-4 type-body-sm text-text-1">{t.title}</span>
                    {t.bpm ? <span className="shrink-0 type-code-sm text-text-3">{Math.round(t.bpm)}</span> : null}
                    <Button size="icon-sm" variant={saved.a === t.id ? "primary" : "ghost"} aria-pressed={saved.a === t.id} aria-label={`Put ${t.title} in A`} onClick={() => pickMix("a", t.id)}><span className="type-label-sm">A</span></Button>
                    <Button size="icon-sm" variant={saved.b === t.id ? "primary" : "ghost"} aria-pressed={saved.b === t.id} aria-label={`Put ${t.title} in B`} onClick={() => pickMix("b", t.id)}><span className="type-label-sm">B</span></Button>
                  </>}
              </li>)}
            </ul>
            {missing.length > 0 && <div className="border-t border-line">
              <p className="px-4 py-2 type-label-sm text-text-3">Without stems</p>
              <ul className="divide-y divide-line-faint border-t border-line-faint">
                {missing.map(t => <li key={t.id} className="flex items-center gap-2 px-4 py-1">
                  <span className="min-w-0 flex-1 truncate type-body-sm text-text-2">{t.title}</span>
                  <Button size="sm" variant="secondary" disabled={Object.keys(splitting).length > 0} onClick={() => void split(t)}>
                    {splitting[t.id] !== undefined ? `${Math.round(splitting[t.id] * 100)}%` : "Split"}
                  </Button>
                </li>)}
              </ul>
            </div>}
          </>}
      </section>

      <section className="min-w-0 flex-1 border border-line bg-panel" aria-labelledby="playlist">
        {/* Transport, loop, tools and zoom. */}
        <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2">
          <Button size="icon-sm" variant="secondary" onClick={() => engine.seek(loopOn && loop ? loop.from : 0)} disabled={!trackA} aria-label="Back to start"><Icon icon={Previous}/></Button>
          <Button size="icon-sm" onClick={engine.toggle} disabled={!trackA} aria-label={engine.playing ? "Pause" : "Play"}><Icon icon={engine.playing ? Pause : Play}/></Button>
          <span className="type-code-sm text-text-1"><span ref={clock}>0:00</span><span className="text-text-3"> / {formatTime(total)}</span></span>
          <span ref={barText} className="w-16 type-code-sm text-text-3"/>
          <span className="h-6 border-s border-line" aria-hidden="true"/>
          <Button size="sm" variant={loopOn ? "primary" : "secondary"} aria-pressed={loopOn} disabled={!trackA} onClick={toggleLoop}><Icon icon={Repeat}/>Loop</Button>
          <div className="flex items-center" role="group" aria-label="Loop length in bars">
            {LOOP_BARS.map(n => <Button key={n} size="sm" variant="ghost" disabled={!trackA} aria-label={`Loop ${n} ${n === 1 ? "bar" : "bars"} from the playhead`} onClick={() => setLoopFrom(n)}>{n}</Button>)}
          </div>
          <span className="w-24 type-code-sm text-text-2">
            {!loop ? <span className="text-text-3">No loop</span> : baseGrid ? barSpan(barNumber(loop.from + 1e-3, baseGrid)!, barNumber(loop.to - 1e-3, baseGrid)!) : `${formatTime(loop.from)}–${formatTime(loop.to)}`}
          </span>
          <Button size="sm" variant="ghost" disabled={!loop} onClick={() => { setLoop(null); setLoopOn(false); }}>Clear loop</Button>
          <div className="ms-auto flex items-center" role="group" aria-label="Zoom">
            <Button size="icon-sm" variant="ghost" disabled={!trackA} aria-label="Zoom out" onClick={() => zoom(1 / 0.6)}><Icon icon={Subtract}/></Button>
            <Button size="icon-sm" variant="ghost" disabled={!trackA} aria-label="Zoom in" onClick={() => zoom(0.6)}><Icon icon={Add}/></Button>
            <Button size="icon-sm" variant="ghost" disabled={!view} aria-label="Fit the whole timeline" onClick={() => setView(null)}><Icon icon={Shrink}/></Button>
          </div>
        </div>

        {/* Tools: what a drag on the lanes does, what it snaps to, how a mute opens and closes. */}
        {trackA && <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2">
          <span className="type-label-sm text-text-3">Tool</span>
          <SegmentedControl size="sm" aria-label="Tool" value={tool} onValueChange={v => setTool(v as Tool)}>
            <SegmentedControlItem value="move">Move</SegmentedControlItem>
            <SegmentedControlItem value="loop">Loop</SegmentedControlItem>
            <SegmentedControlItem value="cut">Mute</SegmentedControlItem>
            <SegmentedControlItem value="volume">Volume</SegmentedControlItem>
          </SegmentedControl>
          <span className="ms-2 type-label-sm text-text-3">Snap</span>
          <Pick aria-label="Snap" items={SNAP_OPTIONS} value={snap} onValueChange={v => patch({ snap: v })} className="w-28"/>
          <span className="ms-2 type-label-sm text-text-3">Mute edges</span>
          <Pick aria-label="Mute edges" items={EDGE_OPTIONS} value={edge} onValueChange={v => patch({ edge: v })} className="w-32"/>
          <span className="type-body-sm text-text-3">{tool === "move" ? "Click or drag the lanes to move the playhead." : tool === "loop" ? "Drag across the lanes to set the loop." : tool === "cut" ? "Drag on a stem's lane to mute it there; click a mute to remove it."
            : "On the volume lanes: click to add a point, drag it, double-click to remove it."}</span>
        </div>}

        {trackA && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <span className="type-label-sm text-text-3">Speed</span>
          <div className="w-40"><Slider aria-label="Playback speed" min={50} max={150} value={Math.round(speed * 100)} onValueChange={v => setSpeed(first(v) / 100)}/></div>
          <span className="w-12 type-code-sm text-text-1">{Math.round(speed * 100)}%</span>
          {trackA.bpm ? <span className="type-code-sm text-text-2">{(trackA.bpm * speed).toFixed(1)} BPM</span> : null}
          <label className="flex items-center gap-2 type-label-sm text-text-2"><Switch checked={keepPitch} onCheckedChange={setKeepPitch} aria-label="Keep pitch"/>Keep pitch</label>
          {!keepPitch && speed !== 1 && <span className="type-code-sm text-text-3">{(12 * Math.log2(speed)).toFixed(1)} st</span>}
          <Button size="sm" variant="ghost" disabled={speed === 1} onClick={() => setSpeed(1)}>Reset</Button>
        </div>}

        {/* Mix: where B comes in, its tempo, and stem swaps at the playhead. */}
        {mode === "mix" && trackA && trackB && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <span className="type-label-sm text-text-3">B starts</span>
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="secondary" aria-label="B one bar earlier" onClick={() => patch({ offset: Math.max(-engineLayers[1].placement.duration / ratioB + 1, saved.offset - (baseGrid ? baseGrid.beat * 4 : 2)) })}><Icon icon={Subtract}/></Button>
            <span className="w-20 text-center type-code-sm text-text-1">{bBar !== null ? `Bar ${bBar}` : formatTime(saved.offset)}</span>
            <Button size="icon-sm" variant="secondary" aria-label="B one bar later" onClick={() => patch({ offset: saved.offset + (baseGrid ? baseGrid.beat * 4 : 2) })}><Icon icon={Add}/></Button>
          </div>
          <Button size="sm" variant="primary" disabled={!both} onClick={previewBlend}><Icon icon={Repeat}/>Preview blend</Button>
          <Button size="sm" variant="ghost" disabled={!both} onClick={() => setView(blendView())}>Zoom to blend</Button>
          <label className="flex items-center gap-2 type-label-sm text-text-2">
            <Switch checked={sync} onCheckedChange={v => setSaved(s => {
              const r = v ? syncRatio(trackA.bpm, trackB.bpm) : 1;
              return { ...s, sync: v, offset: alignOffset(s.offset, gridOf(trackA), gridOf(trackB), r, 4) };
            })} aria-label="Sync B to A's tempo"/>Sync tempo
          </label>
          {trackB.bpm ? <span className="type-code-sm text-text-2">B {trackB.bpm.toFixed(1)}{ratioB !== 1 ? ` → ${(trackB.bpm * ratioB).toFixed(1)}` : ""} BPM</span> : null}
          <span className="h-6 border-s border-line" aria-hidden="true"/>
          <span className="type-label-sm text-text-3">Swap at playhead</span>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Swap a stem from A to B at the playhead">
            {SWAPS.map(s => <Button key={s.label} size="sm" variant="secondary" disabled={!both} onClick={() => swap(s.stems)}>{s.label}</Button>)}
          </div>
          <Button size="sm" variant="ghost" disabled={!cutCount && !stemCurves} onClick={() => patch({ mixEdits: [{ ...storedA, cuts: [], stemVolume: [] }, { ...storedB, cuts: [], stemVolume: [] }] })}>Clear stem moves</Button>
          <span className="h-6 border-s border-line" aria-hidden="true"/>
          <span className="type-label-sm text-text-3">Fade</span>
          <Pick aria-label="Fade shape" className="w-28" items={FADE_OPTIONS} value={saved.fade}
            onValueChange={v => patch(v === "custom" ? { fade: "custom", mixEdits: [{ ...storedA, volume: editA.volume }, { ...storedB, volume: editB.volume }] }
              : { fade: v as FadeShape, mixEdits: [{ ...storedA, volume: [] }, { ...storedB, volume: [] }] })}/>
        </div>}

        {/* Planning: the decks' automatic planner and the local model lay the whole blend out in one go. */}
        {mode === "mix" && trackA && trackB && <div className="border-b border-line px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="type-label-sm text-text-3">Plan</span>
            <Button size="sm" variant="secondary" onClick={autoBlend}><Icon icon={Lightning}/>Auto blend</Button>
            <Button size="sm" variant="secondary" disabled={!aiAvailable || planning} pending={planning} pendingLabel="Planning" onClick={() => void aiBlend()}
              title={aiAvailable ? undefined : "Start Ollama with the model pulled to use the AI plan"}><Icon icon={Sparkles}/>AI blend</Button>
            {!aiAvailable && <span className="type-body-sm text-text-3">AI needs Ollama running with its model.</span>}
            {saved.plan && <span className="type-body-sm text-text-2">
              {saved.plan.by === "ai" ? `AI${saved.plan.model ? ` (${saved.plan.model})` : ""}` : "Automatic"}: {saved.plan.title}{saved.plan.score !== undefined ? ` · score ${saved.plan.score}` : ""}
            </span>}
          </div>
          {saved.plan && saved.plan.notes.length > 0 && <>
            <ul className="mt-2 flex flex-col gap-1">
              {(allNotes ? saved.plan.notes : saved.plan.notes.slice(0, 3)).map((n, i) => <li key={i} className="type-body-sm text-text-2">{n}</li>)}
            </ul>
            {saved.plan.notes.length > 3 && <Button className="mt-1" size="sm" variant="ghost" onClick={() => setAllNotes(v => !v)}>
              {allNotes ? "Show fewer notes" : `Show all ${saved.plan.notes.length} notes`}
            </Button>}
          </>}
        </div>}

        {/* The deck chain of one layer: volume, EQ, color filter, effect. */}
        {trackA && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-2">
          {layers.length > 1 && <SegmentedControl size="sm" aria-label="Layer the mixer edits" value={String(focused)} onValueChange={v => setFocus(Number(v))}>
            <SegmentedControlItem value="0">A</SegmentedControlItem>
            <SegmentedControlItem value="1">B</SegmentedControlItem>
          </SegmentedControl>}
          <div className="flex items-center gap-2">
            <span className="type-label-sm text-text-3">Vol</span>
            <div className="w-24"><Slider aria-label="Layer volume" min={0} max={150} value={Math.round(focusedEdit.mix.volume * 100)} onValueChange={v => setMix(focused, { volume: first(v) / 100 })}/></div>
            <span className="w-9 type-code-sm text-text-2">{Math.round(focusedEdit.mix.volume * 100)}</span>
          </div>
          {(["Low", "Mid", "High"] as const).map((name, i) => <div key={name} className="flex items-center gap-2">
            <span className="w-8 type-label-sm text-text-3">{name}</span>
            <div className="w-24"><Slider aria-label={`${name} EQ`} min={-24} max={12} value={focusedEdit.mix.eq[i]}
              onValueChange={v => setMix(focused, { eq: focusedEdit.mix.eq.map((x, j) => j === i ? first(v) : x) as [number, number, number] })}/></div>
            <span className="w-14 type-code-sm text-text-2">{focusedEdit.mix.eq[i] <= -24 ? "kill" : `${focusedEdit.mix.eq[i] > 0 ? "+" : ""}${focusedEdit.mix.eq[i]} dB`}</span>
          </div>)}
          <div className="flex items-center gap-2">
            <span className="w-12 type-label-sm text-text-3">Filter</span>
            <div className="w-28"><Slider aria-label="Layer filter" min={-100} max={100} value={Math.round(focusedEdit.mix.color * 100)} onValueChange={v => setMix(focused, { color: first(v) / 100 })}/></div>
            <span className="w-8 type-code-sm text-text-2">{Math.abs(focusedEdit.mix.color) < 0.02 ? "off" : focusedEdit.mix.color < 0 ? "LP" : "HP"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="type-label-sm text-text-3">Effect</span>
            <Pick aria-label="Effect" className="w-28" items={[{ value: "off", label: "Off" }, ...EFFECTS.map(e => ({ value: e.id, label: e.label }))]} value={focusedEdit.mix.fx} onValueChange={v => setMix(focused, { fx: v as EffectName })}/>
            <div className="w-24"><Slider aria-label="Effect amount" min={0} max={100} disabled={focusedEdit.mix.fx === "off"} value={Math.round(focusedEdit.mix.fxAmount * 100)} onValueChange={v => setMix(focused, { fxAmount: first(v) / 100 })}/></div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => updateEdit(focused, e => ({ ...e, mix: makeLayerMix(), strips: makeTrackEdit().strips }))}>Reset channels</Button>
          {mode === "edit" && <Button size="sm" variant="ghost" disabled={!cutCount} onClick={() => onCuts(0, () => [])}>Clear mutes</Button>}
          {mode === "edit" && <Button size="sm" variant="ghost" disabled={!editA.volume?.length} onClick={() => onVolume(0, [])}>Flat volume</Button>}
        </div>}

        {!trackA ? <p className="p-4 type-body-sm text-text-2">{mode === "mix"
          ? "Choose a track for A and one for B. B is synced to A's tempo and placed 16 bars before A ends; drag its clip to move it."
          : "Choose a track to see its vocals, drums, bass and melody on their own lanes."}</p>
          : <>
            {mode === "mix" && !trackB && <p className="border-b border-line px-4 py-2 type-body-sm text-text-2">Choose a track for B to mix it with A.</p>}
            <Timeline layers={layers} total={total} view={shown} onView={v => setView(v)} baseGrid={baseGrid} tool={tool} snapBeats={Number(snap)}
              loop={loop} loopOn={loopOn} playhead={playhead} onSeek={t => engine.seek(t)}
              onLoop={l => { setLoop(l); if (l) setLoopOn(true); }} onCuts={onCuts} onStrip={onStrip}
              onOffset={(_, offset) => patch({ offset })} onVolume={onVolume}/>
            {shown.span < total && <div className="flex items-center gap-3 border-t border-line px-4 py-2">
              <span className="type-label-sm text-text-3">Scroll</span>
              <Slider className="flex-1" aria-label="Scroll the timeline" min={0} max={1000} value={Math.round(shown.from / Math.max(1e-6, total - shown.span) * 1000)}
                onValueChange={v => setView({ from: first(v) / 1000 * (total - shown.span), span: shown.span })}/>
            </div>}
          </>}
      </section>
    </main>
    <p className="shrink-0 px-4 pb-4 type-label-sm text-text-3">Space play · L loop · V move · R draw loop · C draw mutes · drag the ruler to loop · ctrl and wheel to zoom · + − 0 zoom</p>
    <LinkImport open={linkOpen} onOpenChange={setLinkOpen} split={saved.autoSplit} onSplitChange={v => patch({ autoSplit: v })}/>
  </div>;
}

