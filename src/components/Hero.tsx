import PhotoWithFallback from "./PhotoWithFallback";

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
          <PhotoWithFallback
            src="https://loremflickr.com/900/700/healthy,food?lock=20"
            alt="Healthy food and wellness flat lay"
            fallbackGradient="from-amber-100 via-orange-50 to-emerald-50"
            fallbackContent="🥗"
            className="aspect-[4/3] rounded-[2rem] shadow-card"
          />
          {/* Floating "My Health Goals" note, echoing the reference */}
          <div className="absolute bottom-5 left-5 rounded-xl bg-white/90 px-5 py-3 shadow-card backdrop-blur">
            <p
              className="text-2xl text-brand-green"
              style={{ fontFamily: "var(--font-script)" }}
            >
              My Health Goals
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
