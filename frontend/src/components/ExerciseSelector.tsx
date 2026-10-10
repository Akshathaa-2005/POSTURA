import { useState } from "react";
import Link from "next/link";
import type { Exercise } from "@/types";
import PoseFigure from "./PoseFigure";

// Tile tones cycle through the palette; figure colour chosen for contrast.
const TONES = [
  { bg: "bg-mist", figure: "#4A4F5C" },
  { bg: "bg-sand", figure: "#4A4F5C" },
  { bg: "bg-slate", figure: "#E0E4E8" },
  { bg: "bg-dusty", figure: "#3B3F49" },
  { bg: "bg-taupe", figure: "#FBFAF8" },
  { bg: "bg-[#E9E4DA]", figure: "#4A4F5C" },
];

const CATEGORIES: Exercise["category"][] = ["strength", "core", "cardio", "mobility"];

export default function ExerciseSelector({ exercises }: { exercises: Exercise[] }) {
  const [category, setCategory] = useState<Exercise["category"] | "all">("all");
  const shown = category === "all" ? exercises : exercises.filter((e) => e.category === category);
  const filters = [
    { id: "all" as const, label: "All", count: exercises.length },
    ...CATEGORIES.map((c) => ({ id: c, label: c, count: exercises.filter((e) => e.category === c).length })).filter(
      (f) => f.count > 0,
    ),
  ];

  return (
    <>
      <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Filter by category">
        {filters.map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={category === f.id}
            onClick={() => setCategory(f.id)}
            className={`pill capitalize ${
              category === f.id ? "border-slate bg-slate text-linen" : "border-slate/15 bg-linen text-stone hover:text-ink"
            }`}
          >
            {f.label}
            <span className={`ml-2 text-xs tabular-nums ${category === f.id ? "text-linen/70" : "text-stone/70"}`}>{f.count}</span>
          </button>
        ))}
      </div>
      <ExerciseGrid exercises={shown} />
    </>
  );
}

function ExerciseGrid({ exercises }: { exercises: Exercise[] }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {exercises.map((ex, i) => {
        const tone = TONES[i % TONES.length];
        const dark = tone.bg === "bg-slate" || tone.bg === "bg-taupe";
        return (
          <div key={ex.id} className="animate-fade-up" style={{ animationDelay: `${Math.min(i, 8) * 60}ms` }}>
            <Link href={`/workout/${ex.id}`} className="card group block overflow-hidden transition duration-300 hover:-translate-y-1">
              <div className={`relative aspect-[4/3] ${tone.bg}`}>
                <span className={`eyebrow absolute left-5 top-5 ${dark ? "text-linen/80" : ""}`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={`eyebrow absolute right-5 top-5 ${dark ? "text-linen/80" : ""}`}>{ex.difficulty}</span>
                <PoseFigure
                  exerciseId={ex.id}
                  color={tone.figure}
                  delay={i * 0.3}
                  className="absolute inset-x-0 bottom-3 mx-auto h-[78%] transition duration-500 group-hover:scale-105"
                />
              </div>
              <div className="p-6">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-[1.7rem] font-medium leading-tight">{ex.name}</h3>
                  <span className="text-stone transition group-hover:translate-x-1 group-hover:text-ink">→</span>
                </div>
                <p className="mt-2 text-sm font-light leading-relaxed text-stone">{ex.description}</p>
                <div className="mt-5 flex items-center gap-3 whitespace-nowrap border-t border-slate/10 pt-4">
                  <span className="eyebrow text-ink">
                    {ex.mode === "hold" ? `${ex.hold_target_sec} s hold` : `${ex.rep_target} reps`}
                  </span>
                  <span className="h-1 w-1 rounded-full bg-taupe" />
                  <span className="eyebrow">{ex.category}</span>
                  <span className="h-1 w-1 rounded-full bg-taupe" />
                  <span className="eyebrow">{ex.view === "side" ? "Side view" : "Front view"}</span>
                </div>
              </div>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
