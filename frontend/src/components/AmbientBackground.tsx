/** Slowly drifting colour washes behind every page. Decorative only; off for reduced motion. */
const BLOBS = [
  { cls: "-left-[10%] -top-[12%] h-[46vmax] w-[46vmax] bg-sage/45", anim: "animate-drift-a" },
  { cls: "right-[-12%] top-[18%] h-[38vmax] w-[38vmax] bg-dusty/40", anim: "animate-drift-b" },
  { cls: "left-[25%] bottom-[-18%] h-[42vmax] w-[42vmax] bg-taupe/25", anim: "animate-drift-b" },
  { cls: "right-[18%] bottom-[-8%] h-[28vmax] w-[28vmax] bg-cream/80", anim: "animate-drift-a" },
];

export default function AmbientBackground() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {BLOBS.map((b, i) => (
        <span
          key={i}
          className={`absolute rounded-full blur-3xl ${b.cls} ${b.anim}`}
          style={{ animationDelay: `${i * -6}s` }}
        />
      ))}
    </div>
  );
}
