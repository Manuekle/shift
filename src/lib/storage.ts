import type { Project, StoredMix, StoredTrack } from "@/lib/types";
const DB_NAME = "shift-local-v1";
/* The database's name before the app was renamed from Open DJ to Shift. */
const LEGACY_DB = "open-dj-local-v1";
const VERSION = 2;
const STORES = ["tracks","mixes","projects"] as const;

/** Opens a database. With mustExist, a database that is not there is not created: the open is aborted and null comes back. */
function openDb(name: string, version?: number, mustExist = false): Promise<IDBDatabase | null> {
  return new Promise((resolve,reject) => {
    const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    req.onupgradeneeded = e => {
      if (mustExist) { if (e.oldVersion === 0) req.transaction?.abort(); return; }
      const db = req.result;
      for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store,{keyPath:"id"});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => { if (mustExist) { e.preventDefault(); resolve(null); } else reject(req.error); };
  });
}
function readAll(db: IDBDatabase, store: string): Promise<unknown[]> {
  return new Promise((resolve,reject) => {
    const req = db.transaction(store,"readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Once per page: copy every row of the old database into the new one, then delete the old one. A row the new database
   already has is kept as it is. If anything fails the old database stays, and the next page load tries again. */
let migration: Promise<void> | undefined;
function migrateLegacy(): Promise<void> {
  return migration ??= (async () => {
    const old = await openDb(LEGACY_DB, undefined, true);
    if (!old) return;
    let stores: string[], rows: unknown[][];
    try {
      stores = STORES.filter(s => old.objectStoreNames.contains(s));
      rows = await Promise.all(stores.map(s => readAll(old, s)));
    } finally { old.close(); }
    if (stores.length) {
      const db = await openDb(DB_NAME, VERSION);
      if (!db) return;
      try {
        await new Promise<void>((resolve,reject) => {
          const tx = db.transaction(stores,"readwrite");
          stores.forEach((s,i) => {
            const store = tx.objectStore(s);
            for (const row of rows[i]) { const req = store.add(row); req.onerror = e => { e.preventDefault(); e.stopPropagation(); }; }
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    }
    indexedDB.deleteDatabase(LEGACY_DB);
  })().catch(() => {});
}

/* One connection for the page, opened on first use and kept: opening the database on every read cost each room a round
   trip before its library could show. It lets go when another tab upgrades or deletes the database, or the browser
   closes it, and the next query opens a fresh one. */
let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB is unavailable"));
  if (connection) return connection;
  const opened: Promise<IDBDatabase> = (async () => {
    await migrateLegacy();
    const db = (await openDb(DB_NAME, VERSION))!;
    const drop = () => { if (connection === opened) connection = undefined; };
    db.onversionchange = () => { db.close(); drop(); };
    db.onclose = drop;
    return db;
  })();
  opened.catch(() => { if (connection === opened) connection = undefined; });
  return connection = opened;
}
async function query<T>(table: "tracks"|"mixes"|"projects", method: "getAll"|"put"|"delete"|"clear", value?: unknown): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve,reject) => {
      const transaction = db.transaction(table,method==="getAll"?"readonly":"readwrite");
      const req = method==="getAll" ? transaction.objectStore(table).getAll() :
        method==="clear" ? transaction.objectStore(table).clear() :
        method==="put" ? transaction.objectStore(table).put(value) :
        transaction.objectStore(table).delete(value as IDBValidKey);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    // A connection the browser closed under us throws InvalidStateError; drop it so the next query reopens.
    if (error instanceof DOMException && error.name === "InvalidStateError") connection = undefined;
    throw error;
  }
}
/* The library as last read or written in this page, so a room can draw it in its first render (the commit glimm's sweep
   reveals) while loadTracks reads the fresh list behind it. Null until the first read. */
let lastTracks: StoredTrack[] | null = null;
export const cachedTracks = () => lastTracks;
export const loadTracks = async () => (lastTracks = await query<StoredTrack[]>("tracks","getAll"));
export const saveTrack = async (track: StoredTrack) => {
  const key = await query<IDBValidKey>("tracks","put",track);
  if (lastTracks) lastTracks = lastTracks.some(t => t.id === track.id) ? lastTracks.map(t => t.id === track.id ? track : t) : [...lastTracks, track];
  return key;
};
export const removeTrack = async (id: string) => {
  await query<void>("tracks","delete",id);
  if (lastTracks) lastTracks = lastTracks.filter(t => t.id !== id);
};
export const clearTracks = async () => { await query<void>("tracks","clear"); lastTracks = []; };
export const loadMixes = () => query<StoredMix[]>("mixes","getAll");
export const saveMix = (mix: StoredMix) => query<IDBValidKey>("mixes","put",mix);
export const removeMix = (id: string) => query<void>("mixes","delete",id);
export const loadProjects = () => query<Project[]>("projects","getAll");
export const saveProject = (project: Project) => query<IDBValidKey>("projects","put",project);
export const removeProject = (id: string) => query<void>("projects","delete",id);
