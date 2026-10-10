import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import { allRecords, buildRecord, clearRecords, downloadRecords, saveRecord } from "@/ml/recordingStore";
import type { Exercise, RepEvent } from "@/types";
import { getUserId } from "@/utils/api";

/**
 * Record mode: after each rep, say what it was. Those labels are what the form model is trained on, so they come
 * from you, not from the rule engine (the rules' guess is deliberately not shown, to avoid anchoring).
 */
export default function RecordPanel({ exercise }: { exercise: Exercise }) {
  const lastEvent = useWorkoutState((s) => s.lastEvent);
  const [pending, setPending] = useState<RepEvent | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [labelled, setLabelled] = useState(0);
  const [total, setTotal] = useState(0);
  const user = useRef("");

  const refresh = useCallback(() => allRecords().then((r) => {
    setTotal(r.length);
    setLabelled(r.filter((x) => x.labels.reviewed).length);
  }).catch(() => undefined), []);

  useEffect(() => {
    user.current = getUserId();
    refresh();
  }, [refresh]);

  const commit = useCallback(
    async (event: RepEvent, labels: string[] | null) => {
      const record = buildRecord(exercise.id, user.current, event, labels);
      if (record) await saveRecord(record).catch(() => undefined);
      refresh();
    },
    [exercise.id, refresh],
  );

  // A new rep arrives: an unlabelled previous one is kept with the rule engine's labels only (weak).
  const pendingRef = useRef<RepEvent | null>(null);
  pendingRef.current = pending;
  useEffect(() => {
    if (!lastEvent?.window || lastEvent === pendingRef.current) return;
    if (pendingRef.current) void commit(pendingRef.current, null);
    setPending(lastEvent);
    setPicked([]);
  }, [lastEvent, commit]);

  const save = useCallback(
    (labels: string[]) => {
      if (!pending) return;
      void commit(pending, labels);
      setPending(null);
      setPicked([]);
    },
    [pending, commit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pending || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "g") save([]);
      else if (e.key === "Enter") save(picked);
      else if (/^[1-9]$/.test(e.key) && exercise.faults[Number(e.key) - 1]) {
        const id = exercise.faults[Number(e.key) - 1].id;
        setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, picked, save, exercise.faults]);

  return (
    <section className="card p-6" aria-live="polite">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow">Recording · label each rep</h2>
        <span className="text-xs tabular-nums text-stone">{labelled} labelled · {total} saved</span>
      </div>

      {pending ? (
        <div className="mt-4">
          <p className="text-sm text-ink">
            Last rep ({pending.type === "rep" ? "counted" : "not counted"}). What was it?
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => save([])} className="pill border-done/40 text-done hover:bg-done/5">
              Good rep <kbd className="ml-2 text-[10px] opacity-60">G</kbd>
            </button>
            {exercise.faults.map((f, i) => {
              const on = picked.includes(f.id);
              return (
                <button
                  key={f.id}
                  aria-pressed={on}
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== f.id) : [...p, f.id]))}
                  className={`pill ${on ? "border-slate bg-slate text-linen" : "border-slate/20 text-ink hover:bg-slate/5"}`}
                >
                  {f.label} {i < 9 && <kbd className="ml-2 text-[10px] opacity-60">{i + 1}</kbd>}
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex gap-2">
            <button disabled={!picked.length} onClick={() => save(picked)} className="rounded-full bg-slate px-5 py-2 text-sm text-linen disabled:opacity-40">
              Save labels <kbd className="ml-1 text-[10px] opacity-60">Enter</kbd>
            </button>
            <button onClick={() => { void commit(pending, null); setPending(null); }} className="pill border-slate/20 text-stone hover:bg-slate/5">
              Skip
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm font-light text-stone">Do a rep. Only the body's joint positions are saved, never video.</p>
      )}

      <div className="mt-5 flex flex-wrap gap-2 border-t border-slate/10 pt-4">
        <button onClick={() => downloadRecords().then(refresh)} disabled={!total} className="pill border-slate/20 text-ink hover:bg-slate/5 disabled:opacity-40">
          Download reps
        </button>
        <button onClick={() => { if (window.confirm("Delete every saved rep from this browser?")) clearRecords().then(refresh); }} disabled={!total} className="pill border-slate/10 text-stone hover:bg-slate/5 disabled:opacity-40">
          Clear
        </button>
      </div>
    </section>
  );
}
