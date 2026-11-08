"use client";

import { ClientOnly } from "@/components/client-only";
import { RhythmGame } from "@/components/game/rhythm-game";

// The game reads the browser's storage and audio on first render, so it is never rendered on the server.
export function RhythmGameClient() { return <ClientOnly><RhythmGame /></ClientOnly>; }
