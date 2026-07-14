const BADGES = [
  { icon: "🌿", label: "Personalized\nResults" },
  { icon: "💛", label: "Better\nWellness" },
  { icon: "🛡️", label: "100% Private\n& Secure" },
];

export default function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-5 pt-10 md:pt-14">
      <div className="grid items-center gap-10 md:grid-cols-2">
        <div>
          <h1 className="font-extrabold leading-[1.05] text-brand-green">
            <span className="block text-5xl md:text-6xl">Your Health.</span>
            <span className="block text-5xl md:text-6xl">Your Plan.</span>
            <span
              className="mt-2 block text-5xl text-brand-orange md:text-6xl"
              style={{ fontFamily: "var(--font-script)" }}
            >
              Made for You.
            </span>
          </h1>

          <p className="mt-6 max-w-md text-lg text-ink-muted">
            Take our quick quiz and get a personalized health plan designed just
            for you.
          </p>

          <div className="mt-8 flex flex-wrap gap-8">
            {BADGES.map((b) => (
              <div key={b.label} className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-orange-soft text-xl">
                  {b.icon}
                </span>
                <span className="whitespace-pre-line text-sm font-semibold text-brand-green">
                  {b.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="relative">
          <div className="aspect-[4/3] overflow-hidden rounded-[2rem] bg-gradient-to-br from-amber-100 via-orange-50 to-emerald-50 shadow-card">
            <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
              <div className="grid grid-cols-3 gap-3 text-4xl">
                <span>🥤</span>
                <span>🧘</span>
                <span>🥗</span>
                <span>💧</span>
                <span>🍊</span>
                <span>📓</span>
              </div>
              <div className="rounded-xl bg-white/80 px-5 py-3 shadow-soft">
                <p
                  className="text-2xl text-brand-green"
                  style={{ fontFamily: "var(--font-script)" }}
                >
                  My Health Goals
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
