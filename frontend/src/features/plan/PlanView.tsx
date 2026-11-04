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
  const macros = [
    { label: "Calories", value: n.calories, unit: "kcal", tone: "bg-forest text-cream" },
    { label: "Protein", value: n.protein_g, unit: "g", tone: "bg-linen" },
    { label: "Carbs", value: n.carbs_g, unit: "g", tone: "bg-linen" },
    { label: "Fat", value: n.fat_g, unit: "g", tone: "bg-linen" },
    { label: "Water", value: n.water_l, unit: "L", tone: "bg-linen" },
  ];

  return (
    <div className="space-y-10">
      <header className="animate-fade-up">
        <p className="eyebrow">Your plan</p>
        <h2 className="mt-3 font-display text-5xl leading-tight text-slate">{plan.title}</h2>
        <p className="mt-3 max-w-2xl text-lg font-light leading-relaxed text-stone">{plan.summary}</p>
      </header>

      <p role="note" className="flex gap-3 rounded-2xl border border-taupe/40 bg-cream/70 px-5 py-4 text-sm text-ink">
        <span aria-hidden className="mt-0.5 text-taupe">ⓘ</span>
        <span>{plan.disclaimer}</span>
      </p>
      {plan.safety_flags.length > 0 && (
        <ul className="space-y-1.5 rounded-2xl border border-warn/30 bg-warn/10 px-5 py-4 text-sm text-ink">
          {plan.safety_flags.map((f) => <li key={f}>⚠ {f}</li>)}
        </ul>
      )}

      <section className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="inline-flex flex-wrap gap-1 rounded-full bg-mist/70 p-1" role="tablist">
            {plan.weeks.map((w, i) => (
              <button key={w.week} role="tab" aria-selected={i === week} onClick={() => setWeek(i)}
                className={`rounded-full px-4 py-1.5 text-sm transition ${i === week ? "bg-forest text-cream shadow-soft" : "text-slate hover:text-ink"}`}>
                Week {w.week}
              </button>
            ))}
          </div>
          <p className="rounded-full bg-sage/40 px-4 py-1.5 text-sm text-forest">Focus: {plan.weeks[week].focus}</p>
        </div>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {plan.weeks[week].days.map((d) => (
            <article key={d.day} className="card relative overflow-hidden p-6 transition duration-300 hover:-translate-y-0.5 hover:shadow-lg">
              <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sage via-done to-forest" />
              <p className="eyebrow !text-[10px]">{d.day}</p>
              <h3 className="mt-1 font-display text-2xl text-slate">{d.name}</h3>

              <p className="mt-5 text-[11px] font-medium uppercase tracking-[0.2em] text-stone">Warm-up</p>
              <ul className="mt-2 space-y-1 text-sm text-ink">{d.warmup.map((s) => <li key={s} className="flex gap-2"><span className="text-sage">•</span>{s}</li>)}</ul>

              <p className="mt-5 text-[11px] font-medium uppercase tracking-[0.2em] text-stone">Exercises</p>
              <ul className="mt-2 divide-y divide-slate/10">
                {d.exercises.map((e, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0">
                      {e.exercise_id
                        ? <Link className="font-medium text-slate underline decoration-sage decoration-2 underline-offset-4 transition hover:text-forest" href={`/workout/${e.exercise_id}`}>{e.name}</Link>
                        : <span className="font-medium text-slate">{e.name}</span>}
                      {e.notes && <span className="mt-0.5 block text-xs text-stone">{e.notes}</span>}
                    </span>
                    <span className="shrink-0 rounded-full bg-mist px-2.5 py-0.5 text-xs tabular-nums text-slate">{amount(e)}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-5 text-[11px] font-medium uppercase tracking-[0.2em] text-stone">Cool-down</p>
              <ul className="mt-2 space-y-1 text-sm text-ink">{d.cooldown.map((s) => <li key={s} className="flex gap-2"><span className="text-sage">•</span>{s}</li>)}</ul>
            </article>
          ))}
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-stone">{plan.progression}</p>
      </section>

      <section className="space-y-6">
        <div>
          <p className="eyebrow">Nutrition</p>
          <h3 className="mt-2 font-display text-3xl text-slate">Fuel for the work</h3>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {macros.map((m) => (
            <div key={m.label} className={`stat-tile ${m.tone}`}>
              <p className={`eyebrow !text-[10px] ${m.tone.includes("cream") ? "!text-cream/80" : ""}`}>{m.label}</p>
              <p className="mt-2 font-display text-3xl tabular-nums">
                {m.value}<span className="ml-1 font-sans text-xs font-normal opacity-70">{m.unit}</span>
              </p>
            </div>
          ))}
        </div>
        <ul className="grid gap-1.5 text-sm text-stone sm:grid-cols-2">
          {n.notes.map((x) => <li key={x} className="flex gap-2"><span className="text-sage">✦</span>{x}</li>)}
        </ul>
        <div className="grid gap-5 md:grid-cols-3">
          {n.meal_days.map((d) => (
            <article key={d.name} className="card p-6">
              <h4 className="font-display text-xl text-slate">{d.name}</h4>
              <ul className="mt-4 space-y-4 text-sm">
                {d.meals.map((m) => (
                  <li key={m.name} className="border-l-2 border-sage/70 pl-3">
                    <p className="flex items-baseline justify-between gap-2">
                      <b className="font-medium text-slate">{m.name}</b>
                      <span className="text-xs tabular-nums text-stone">~{m.approx_kcal} kcal</span>
                    </p>
                    <p className="mt-0.5 text-ink/80">{m.description}</p>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <footer className="flex flex-wrap items-center gap-3 border-t border-slate/10 pt-6">
        <a className="btn-link" href={exportUrl(stored.id, "json")} download>Download JSON</a>
        <a className="btn-link" href={exportUrl(stored.id, "md")} download>Download Markdown</a>
        <button className="btn-link" onClick={() => window.print()}>Print</button>
        <form className="ml-auto flex w-full gap-2 sm:w-auto" onSubmit={(e) => { e.preventDefault(); if (adjust.trim()) onAdjust(adjust.trim()); }}>
          <input value={adjust} onChange={(e) => setAdjust(e.target.value)} maxLength={300} placeholder='Adjust: "make it easier", "no jumping"'
            className="field !mt-0 w-full sm:w-72" aria-label="Adjustment request" />
          <button className="shrink-0 rounded-full bg-forest px-5 py-2.5 text-sm font-medium text-cream shadow-soft transition hover:bg-[#173a24] active:scale-[0.98]">Regenerate</button>
        </form>
      </footer>
    </div>
  );
}
