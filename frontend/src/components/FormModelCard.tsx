import { useFormModel } from "@/hooks/useFormModel";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";

/** The ST-GCN's read of the last rep. Shown only when a trained model is installed; it never changes the rep count. */
export default function FormModelCard({ exercise }: { exercise: Exercise }) {
  const model = useFormModel();
  const read = useWorkoutState((s) => s.modelRead);
  if (!model) return null;
  const label = (id: string) => exercise.faults.find((f) => f.id === id)?.label ?? id;

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow">AI form check</h2>
        <span className="text-[11px] uppercase tracking-[0.2em] text-stone">{read ? `${read.ms.toFixed(0)} ms` : model.variant}</span>
      </div>
      {!read ? (
        <p className="mt-3 text-sm font-light text-stone">Scores each rep as soon as you finish it.</p>
      ) : read.faults.length === 0 ? (
        <p className="mt-3 font-display text-xl text-done">Last rep looks good.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {read.faults.map((f) => (
            <li key={f.id} className="flex items-baseline justify-between gap-3 text-sm text-ink">
              <span className="font-display text-lg">{label(f.id)}</span>
              <span className="tabular-nums text-stone">{Math.round(f.prob * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
      {model.meta.synthetic && (
        <p className="mt-3 text-xs text-bad">Pipeline test model, trained on synthetic data. These scores mean nothing.</p>
      )}
    </section>
  );
}
