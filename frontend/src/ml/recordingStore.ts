// Stores labelled reps in the browser (IndexedDB) so they can be downloaded and used to train the form model.
// Only the normalised skeleton is kept: no video, no images.
import type { RepEvent } from "@/types";
import { CONTEXT_DIM, SPEC, V } from "./skeleton";

export interface RepRecord {
  version: 1;
  spec_version: number;
  kind: "rep";
  exercise_id: string;
  /** Anonymous browser id: keeps one person's reps on one side of the train/validation split. */
  user: string;
  at: string;
  /** What the app decided at the time. */
  counted: boolean;
  frames: number[][][];
  context: number[][];
  labels: {
    /** Fault ids a person confirmed; empty means "good rep". Present only when reviewed. */
    manual?: string[];
    /** Fault ids the rule engine found. */
    rules: string[];
    reviewed: boolean;
  };
}

const DB = "postura-recordings";
const STORE = "reps";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

const round = (n: number) => Math.round(n * 1e4) / 1e4;

export function buildRecord(
  exerciseId: string,
  user: string,
  event: RepEvent,
  manual: string[] | null,
): RepRecord | null {
  const w = event.window;
  if (!w) return null;
  const frames: number[][][] = [];
  const context: number[][] = [];
  for (let f = 0; f < w.frames; f++) {
    const joints: number[][] = [];
    for (let j = 0; j < V; j++) {
      const o = (f * V + j) * 3;
      joints.push([round(w.joints[o]), round(w.joints[o + 1]), round(w.joints[o + 2])]);
    }
    frames.push(joints);
    context.push(Array.from(w.context.subarray(f * CONTEXT_DIM, (f + 1) * CONTEXT_DIM), round));
  }
  return {
    version: 1,
    spec_version: SPEC.version,
    kind: "rep",
    exercise_id: exerciseId,
    user,
    at: new Date().toISOString(),
    counted: event.type === "rep",
    frames,
    context,
    labels: {
      ...(manual ? { manual } : {}),
      rules: event.faults.map((f) => f.rule.id),
      reviewed: manual !== null,
    },
  };
}

export async function saveRecord(record: RepRecord): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).add(record);
  await done(tx);
  db.close();
}

export async function allRecords(): Promise<RepRecord[]> {
  const db = await open();
  const req = db.transaction(STORE).objectStore(STORE).getAll();
  const rows = await new Promise<RepRecord[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rows;
}

export async function clearRecords(): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await done(tx);
  db.close();
}

export async function downloadRecords(): Promise<number> {
  const reps = await allRecords();
  const blob = new Blob([JSON.stringify({ reps: reps.map(({ ...r }) => (delete (r as { key?: number }).key, r)) })], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `postura-reps-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return reps.length;
}
