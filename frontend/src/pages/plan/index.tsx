import { useCallback, useEffect, useState } from "react";
import Layout from "@/components/Layout";
import { deletePlan, generatePlan, getPlan, listPlans, PlanApiError } from "@/features/plan/api";
import PlanForm, { type FormSubmit } from "@/features/plan/PlanForm";
import PlanView from "@/features/plan/PlanView";
import type { GenerateResponse, PlanProfile, PlanSummary, StoredPlan } from "@/features/plan/types";

export default function PlanPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [current, setCurrent] = useState<StoredPlan | null>(null);
  const [saved, setSaved] = useState<PlanSummary[]>([]);
  const [last, setLast] = useState<FormSubmit | null>(null);

  const refresh = useCallback(() => listPlans().then(setSaved).catch(() => setSaved([])), []);
  useEffect(() => { refresh(); }, [refresh]);

  async function run(req: FormSubmit & { adjustment?: string }) {
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await generatePlan(req);
      setResult(res);
      if (res.status === "ok" && res.plan) { setCurrent(res.plan); refresh(); }
    } catch (e) {
      setError(e instanceof PlanApiError ? e.message : "Something went wrong. Please try again.");
    } finally { setBusy(false); }
  }

  const submit = (v: FormSubmit) => { setLast(v); setCurrent(null); run(v); };
  const prefill: PlanProfile | null = result?.profile ?? null;

  return (
    <Layout title="Your plan">
      <div className="grid gap-10 py-8 lg:grid-cols-[1fr_260px]">
        <div>
          <p className="eyebrow">Personalised plan</p>
          <h1 className="mt-3 font-display text-5xl text-slate">Training &amp; nutrition, built for you</h1>
          <p className="mt-3 max-w-xl text-sm text-stone">Generated privately on your own machine. General guidance only, not medical advice.</p>

          <div className="mt-8">
            {current ? (
              <>
                <button className="mb-6 text-sm underline" onClick={() => setCurrent(null)}>← New plan</button>
                <PlanView stored={current} onAdjust={(adjustment) => last && run({ ...last, adjustment })} />
              </>
            ) : (
              <>
                {error && <p role="alert" className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
                {result?.status === "blocked" && (
                  <div role="alert" className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
                    <p className="font-medium">We can&apos;t create a plan for this request.</p>
                    <ul className="list-disc pl-5">{result.safety.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                  </div>
                )}
                <PlanForm key={result?.status === "needs_clarification" ? "clarify" : "new"} busy={busy} initial={prefill}
                  questions={result?.status === "needs_clarification" ? result.questions : undefined} onSubmit={submit} />
              </>
            )}
          </div>
        </div>

        <aside aria-label="Saved plans">
          <h2 className="eyebrow">Saved plans</h2>
          {saved.length === 0 && <p className="mt-3 text-sm text-stone">Nothing yet.</p>}
          <ul className="mt-3 space-y-2">
            {saved.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-2 rounded-lg bg-linen px-3 py-2 text-sm">
                <button className="text-left" onClick={() => getPlan(s.id).then(setCurrent).catch(() => setError("Couldn't open that plan."))}>
                  {s.title}<span className="block text-xs text-stone">{new Date(s.created_at).toLocaleDateString()}</span>
                </button>
                <button aria-label={`Delete ${s.title}`} className="text-stone hover:text-ink"
                  onClick={() => deletePlan(s.id).then(refresh).catch(() => setError("Couldn't delete that plan."))}>×</button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </Layout>
  );
}
