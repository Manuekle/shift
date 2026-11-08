"use client";

import { ClientOnly } from "@/components/client-only";
import { StudioView } from "@/components/studio/studio-view";

// The studio reads IndexedDB, the audio hardware and the microphone, so it is never rendered on the server.
export function StudioClient() { return <ClientOnly><StudioView /></ClientOnly>; }
