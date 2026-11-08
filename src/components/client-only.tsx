"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => {};

/* Renders its children only in the browser. The server and the hydrating pass see nothing; a client-side navigation
   (a room link) renders them in the very commit that swaps the route, so glimm's sweep reveals the finished room rather
   than an empty page that fills in after the band has passed. next/dynamic with ssr: false could not do that: its lazy
   chunk always mounts behind a fresh Suspense fallback. */
export function ClientOnly({ children }: { children: ReactNode }) {
  const client = useSyncExternalStore(subscribe, () => true, () => false);
  return client ? children : null;
}
