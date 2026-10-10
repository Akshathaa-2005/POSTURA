import ExerciseSelector from "@/components/ExerciseSelector";
import Layout from "@/components/Layout";
import PoseFigure from "@/components/PoseFigure";
import { EXERCISES } from "@/utils/exercises";

// 3×3 mosaic echoing the palette board: colour blocks interleaved with moving figures.
const MOSAIC: ({ tone: string; brand?: boolean } | { tone: string; figure: string; color: string })[] = [
  { tone: "bg-mist" },
  { tone: "bg-linen", figure: "jumping_jack", color: "#4A4F5C" },
  { tone: "bg-sand" },
  { tone: "bg-[#ECE8E1]", figure: "lunge", color: "#8E7763" },
  { tone: "bg-cream", brand: true },
  { tone: "bg-[#DCE3E8]", figure: "squat", color: "#4A4F5C" },
  { tone: "bg-taupe" },
  { tone: "bg-linen", figure: "shoulder_press", color: "#5F829A" },
  { tone: "bg-dusty" },
];

export default function Home() {
  return (
    <Layout>
      <section className="grid items-center gap-12 py-8 lg:grid-cols-[1.1fr_1fr] lg:py-14">
        <div className="animate-fade-up">
          <p className="eyebrow">Postura&nbsp;&nbsp;—&nbsp;&nbsp;AI form coach</p>
          <h1 className="mt-6 font-display text-6xl font-normal leading-[0.95] tracking-tight text-slate sm:text-7xl xl:text-8xl">
            Move with
            <br />
            <em className="font-normal text-forest">intention.</em>
          </h1>
          <p className="mt-8 max-w-md text-lg font-light leading-relaxed text-stone">
            A calm, attentive coach that watches your form in real time, gently guiding every joint into
            alignment and counting each rep for you.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-6">
            <a
              href="#practice"
              className="rounded-full bg-forest px-8 py-3.5 text-sm font-medium tracking-wide text-cream transition hover:bg-[#173a24]"
            >
              Begin your practice
            </a>
            <span className="eyebrow">Real-time&nbsp;·&nbsp;Private&nbsp;·&nbsp;Free</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {MOSAIC.map((tile, i) => (
            <div
              key={i}
              style={{ animationDelay: `${150 + i * 60}ms` }}
              className={`relative aspect-[3/4] animate-fade-in overflow-hidden ${tile.tone}`}
            >
              {"brand" in tile && tile.brand && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/brand/postura-mark.png" alt="Postura" className="absolute inset-0 m-auto h-[78%] w-auto" />
              )}
              {"figure" in tile && (
                <PoseFigure
                  exerciseId={tile.figure}
                  color={tile.color}
                  delay={i * 0.4}
                  duration={3.2}
                  className="absolute inset-0 m-auto h-[80%]"
                />
              )}
            </div>
          ))}
        </div>
      </section>

      <section id="practice" className="scroll-mt-8 pt-12">
        <div className="mb-8 flex items-end justify-between border-b border-slate/10 pb-4">
          <div>
            <p className="eyebrow">Choose your practice</p>
            <h2 className="mt-2 font-display text-4xl font-normal text-slate">Today&apos;s movements</h2>
          </div>
          <span className="eyebrow">{String(EXERCISES.length).padStart(2, "0")}</span>
        </div>
        <ExerciseSelector exercises={EXERCISES} />
      </section>
    </Layout>
  );
}
