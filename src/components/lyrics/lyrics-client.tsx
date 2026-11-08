"use client";

import { ClientOnly } from "@/components/client-only";
import { LyricsView } from "@/components/lyrics/lyrics-view";

// The page reads IndexedDB and the audio hardware on first render, so it is never rendered on the server.
export function LyricsClient() { return <ClientOnly><LyricsView /></ClientOnly>; }
