"use client";

import { ClientOnly } from "@/components/client-only";
import { StemsView } from "@/components/stems/stems-view";

// The page reads IndexedDB and the audio hardware on first render, so it is never rendered on the server.
export function StemsClient() { return <ClientOnly><StemsView /></ClientOnly>; }
