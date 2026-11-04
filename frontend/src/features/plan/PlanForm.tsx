import { useState } from "react";
import type { Equipment, PlanProfile } from "./types";
import { splitList, validateProfile } from "./validate";

const field = "field";
const select = "field field-select";
const EQUIPMENT: Equipment[] = ["none", "dumbbells", "bands", "barbell", "gym"];

export interface FormSubmit { profile?: PlanProfile; free_text?: string }

export default function PlanForm({ busy, initial, questions, onSubmit }: {
  busy: boolean; initial?: PlanProfile | null; questions?: string[]; onSubmit: (v: FormSubmit) => void;
}) {
  const [mode, setMode] = useState<"form" | "text">("form");
  const [p, setP] = useState<PlanProfile>({ units: "metric", equipment: ["none"], minutes_per_session: 45, diet: "omnivore", ...initial });
  // Keep the saved lists in the text boxes; otherwise a resubmit would send them back empty.
  const [lists, setLists] = useState({
    allergies: (initial?.allergies ?? []).join(", "), dislikes: (initial?.dislikes ?? []).join(", "),
    injuries: (initial?.injuries ?? []).join(", "), medical_conditions: (initial?.medical_conditions ?? []).join(", "),
  });
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof PlanProfile>(k: K, v: PlanProfile[K]) => setP((o) => ({ ...o, [k]: v }));
  const num = (v: string) => (v === "" ? undefined : Number(v));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "text") return text.trim() ? onSubmit({ free_text: text.trim() }) : setErrors({ text: "Describe your goals first" });
    const profile: PlanProfile = { ...p };
    for (const k of Object.keys(lists) as (keyof typeof lists)[]) profile[k] = splitList(lists[k]);
    const errs = validateProfile(profile);
    setErrors(errs);
    if (!Object.keys(errs).length) onSubmit({ profile, free_text: text.trim() || undefined });
  }
  const err = (k: string) => errors[k] && <span className="text-xs text-red-700" role="alert">{errors[k]}</span>;
  const imperial = p.units === "imperial";

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="inline-flex rounded-full bg-mist/70 p-1" role="tablist">
        {(["form", "text"] as const).map((m) => (
          <button type="button" key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={`rounded-full px-4 py-1.5 text-sm transition ${mode === m ? "bg-forest text-cream shadow-soft" : "text-slate hover:text-ink"}`}>
            {m === "form" ? "Guided form" : "Describe in your own words"}
          </button>
        ))}
      </div>

      {questions && questions.length > 0 && (
        <div className="rounded-lg border border-taupe/40 bg-cream px-4 py-3 text-sm" role="status">
          <p className="font-medium">A few details are missing:</p>
          <ul className="list-disc pl-5">{questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </div>
      )}

      {mode === "text" ? (
        <label className="block text-sm">Tell us about your goals, body, schedule, food and any injuries
          <textarea className={field} rows={8} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="I'm 34, 172 cm, 78 kg. Want to lose fat, train 3 days a week at home with dumbbells. Vegetarian, allergic to peanuts. Sore left knee." />
          {err("text")}
        </label>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate">Goal
            <select className={select} value={p.goal ?? ""} onChange={(e) => set("goal", (e.target.value || undefined) as PlanProfile["goal"])}>
              <option value="">Choose…</option>
              <option value="lose_fat">Lose fat</option><option value="build_muscle">Build muscle</option>
              <option value="endurance">Endurance</option><option value="general_fitness">General fitness</option><option value="mobility">Mobility</option>
            </select>{err("goal")}
          </label>
          <label className="text-sm font-medium text-slate">Experience
            <select className={select} value={p.level ?? ""} onChange={(e) => set("level", (e.target.value || undefined) as PlanProfile["level"])}>
              <option value="">Choose…</option><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option>
            </select>{err("level")}
          </label>
          <label className="text-sm font-medium text-slate">Age
            <input className={field} type="number" inputMode="numeric" value={p.age ?? ""} onChange={(e) => set("age", num(e.target.value))} />{err("age")}
          </label>
          <label className="text-sm font-medium text-slate">Sex (for calorie estimate)
            <select className={select} value={p.sex ?? ""} onChange={(e) => set("sex", (e.target.value || undefined) as PlanProfile["sex"])}>
              <option value="">Choose…</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
            </select>{err("sex")}
          </label>
          <label className="text-sm font-medium text-slate">Units
            <select className={select} value={p.units} onChange={(e) => set("units", e.target.value as PlanProfile["units"])}>
              <option value="metric">Metric (cm, kg)</option><option value="imperial">Imperial (in, lb)</option>
            </select>
          </label>
          <span />
          <label className="text-sm font-medium text-slate">Height ({imperial ? "in" : "cm"})
            <input className={field} type="number" step="any" value={p.height ?? ""} onChange={(e) => set("height", num(e.target.value))} />{err("height")}
          </label>
          <label className="text-sm font-medium text-slate">Weight ({imperial ? "lb" : "kg"})
            <input className={field} type="number" step="any" value={p.weight ?? ""} onChange={(e) => set("weight", num(e.target.value))} />{err("weight")}
          </label>
          <label className="text-sm font-medium text-slate">Days per week
            <input className={field} type="number" min={1} max={7} value={p.days_per_week ?? ""} onChange={(e) => set("days_per_week", num(e.target.value))} />{err("days_per_week")}
          </label>
          <label className="text-sm font-medium text-slate">Minutes per session
            <input className={field} type="number" min={10} max={120} value={p.minutes_per_session ?? ""} onChange={(e) => set("minutes_per_session", num(e.target.value))} />
          </label>
          <fieldset className="text-sm font-medium text-slate sm:col-span-2"><legend>Equipment</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {EQUIPMENT.map((x) => (
                <label key={x} className="group cursor-pointer">
                  <input className="peer sr-only" type="checkbox" checked={p.equipment?.includes(x) ?? false}
                    onChange={(e) => set("equipment", e.target.checked
                      ? (x === "none" ? ["none"] : [...(p.equipment ?? []).filter((q) => q !== "none"), x])
                      : (p.equipment ?? []).filter((q) => q !== x))} />
                  <span className="inline-flex items-center rounded-full border border-slate/15 bg-linen px-4 py-1.5 text-sm capitalize text-slate transition group-hover:border-slate/30 peer-checked:border-forest peer-checked:bg-forest peer-checked:text-cream peer-focus-visible:ring-4 peer-focus-visible:ring-forest/15">
                    {x}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="text-sm font-medium text-slate">Diet
            <select className={select} value={p.diet} onChange={(e) => set("diet", e.target.value as PlanProfile["diet"])}>
              <option value="omnivore">Omnivore</option><option value="vegetarian">Vegetarian</option><option value="vegan">Vegan</option><option value="pescatarian">Pescatarian</option>
            </select>
          </label>
          <span />
          {([["allergies", "Allergies (comma separated)"], ["dislikes", "Foods you dislike"], ["injuries", "Injuries or pain"], ["medical_conditions", "Medical conditions"]] as const).map(([k, label]) => (
            <label key={k} className="text-sm font-medium text-slate">{label}
              <input className={field} value={lists[k]} onChange={(e) => setLists((o) => ({ ...o, [k]: e.target.value }))} />
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={!!p.pregnant} onChange={(e) => set("pregnant", e.target.checked)} /> I am pregnant or postpartum
            {err("pregnant")}
          </label>
          <label className="text-sm sm:col-span-2">Anything else? (optional)
            <textarea className={field} rows={3} maxLength={3000} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </div>
      )}

      <button disabled={busy} className="rounded-full bg-forest px-8 py-3 text-sm font-medium tracking-wide text-cream shadow-soft transition hover:bg-[#173a24] active:scale-[0.98] disabled:opacity-60">
        {busy ? "Building your plan… this can take a minute" : "Generate my plan"}
      </button>
    </form>
  );
}
