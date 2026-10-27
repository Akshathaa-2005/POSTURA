import Link from "next/link";
import { useState } from "react";
import { exportUrl } from "./api";
import type { ExerciseItem, StoredPlan } from "./types";

const amount = (e: ExerciseItem) => (e.reps ? `${e.sets} × ${e.reps}` : `${e.sets} × ${e.duration_sec}s`);

export default function PlanView({ stored, onAdjust }: { stored: StoredPlan; onAdjust: (text: string) => void }) {
  const { plan } = stored;
  const [week, setWeek] = useState(0);
  const [adjust, setAdjust] = useState("");
  const n = plan.nutrition;
  return (
    <div className="space-y-8">
      <header>
        <h2 className="font-display text-4xl text-slate">{plan.title}</h2>
        <p className="mt-2 max-w-2xl text-stone">{plan.summary}</p>
      </header>

      <p role="note" className="rounded-lg border border-taupe/40 bg-cream px-4 py-3 text-sm text-ink">{plan.disclaimer}</p>
      {plan.safety_flags.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-taupe/40 bg-sand/40 px-4 py-3 text-sm">
          {plan.safety_flags.map((f) => <li key={f}>⚠ {f}</li>)}
        </ul>
      )}

      <section>
        <div className="flex flex-wrap gap-2" role="tablist">
          {plan.weeks.map((w, i) => (
            <button key={w.week} role="tab" aria-selected={i === week} onClick={() => setWeek(i)}
              className={`rounded-full px-4 py-1.5 text-sm ${i === week ? "bg-forest text-cream" : "bg-mist text-slate"}`}>
              Week {w.week}
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm text-stone">Focus: {plan.weeks[week].focus}</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plan.weeks[week].days.map((d) => (
            <article key={d.day} className="rounded-xl bg-linen p-5 shadow-sm">
              <h3 className="font-medium text-ink">{d.day} · {d.name}</h3>
              <p className="mt-2 text-xs uppercase tracking-wide text-stone">Warm-up</p>
              <ul className="list-disc pl-5 text-sm">{d.warmup.map((s) => <li key={s}>{s}</li>)}</ul>
              <p className="mt-3 text-xs uppercase tracking-wide text-stone">Exercises</p>
              <ul className="space-y-1 text-sm">
                {d.exercises.map((e, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span>
                      {e.exercise_id ? <Link className="underline decoration-sage underline-offset-2" href={`/workout/${e.exercise_id}`}>{e.name}</Link> : e.name}
                      {e.notes && <span className="block text-xs text-stone">{e.notes}</span>}
                    </span>
                    <span className="whitespace-nowrap tabular-nums">{amount(e)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs uppercase tracking-wide text-stone">Cool-down</p>
              <ul className="list-disc pl-5 text-sm">{d.cooldown.map((s) => <li key={s}>{s}</li>)}</ul>
            </article>
          ))}
        </div>
        <p className="mt-3 text-sm text-stone">{plan.progression}</p>
      </section>

      <section>
        <h3 className="font-display text-2xl text-slate">Nutrition</h3>
        <p className="mt-2 tabular-nums">{n.calories} kcal · protein {n.protein_g} g · carbs {n.carbs_g} g · fat {n.fat_g} g · water {n.water_l} L</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-stone">{n.notes.map((x) => <li key={x}>{x}</li>)}</ul>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {n.meal_days.map((d) => (
            <article key={d.name} className="rounded-xl bg-linen p-5 shadow-sm">
              <h4 className="font-medium">{d.name}</h4>
              <ul className="mt-2 space-y-2 text-sm">
                {d.meals.map((m) => <li key={m.name}><b>{m.name}</b> <span className="text-stone">~{m.approx_kcal} kcal</span><br />{m.description}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <footer className="flex flex-wrap items-center gap-3 border-t border-slate/10 pt-5">
        <a className="btn-link" href={exportUrl(stored.id, "json")} download>Download JSON</a>
        <a className="btn-link" href={exportUrl(stored.id, "md")} download>Download Markdown</a>
        <button className="btn-link" onClick={() => window.print()}>Print</button>
        <form className="ml-auto flex gap-2" onSubmit={(e) => { e.preventDefault(); if (adjust.trim()) onAdjust(adjust.trim()); }}>
          <input value={adjust} onChange={(e) => setAdjust(e.target.value)} maxLength={300} placeholder='Adjust: "make it easier", "no jumping"'
            className="w-72 rounded-lg border border-slate/20 bg-linen px-3 py-2 text-sm" aria-label="Adjustment request" />
          <button className="rounded-lg bg-forest px-4 py-2 text-sm text-cream">Regenerate</button>
        </form>
      </footer>
    </div>
  );
}
