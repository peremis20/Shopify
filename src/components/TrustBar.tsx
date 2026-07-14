const ITEMS = [
  { icon: "🌿", label: "Natural Ingredients" },
  { icon: "💛", label: "Made with Love" },
  { icon: "🛡️", label: "Rooted in Tradition" },
  { icon: "🇺🇸", label: "Made in USA" },
];

export default function TrustBar() {
  return (
    <div className="rounded-2xl border border-brand-orange-soft bg-cream-50/70 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            {["🧑", "👩", "🧔", "👩‍🦰"].map((e, i) => (
              <span
                key={i}
                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-brand-orange-soft text-sm"
              >
                {e}
              </span>
            ))}
          </div>
          <div className="leading-tight">
            <p className="text-sm font-bold text-brand-green">Trusted by</p>
            <p className="text-sm font-bold text-brand-green">Thousands</p>
          </div>
        </div>

        <div className="leading-tight">
          <p className="text-amber-500">★★★★★</p>
          <p className="text-xs font-semibold text-ink-muted">
            4.9 (2,560+ Reviews)
          </p>
        </div>

        {ITEMS.map((item) => (
          <div key={item.label} className="flex items-center gap-2">
            <span className="text-lg">{item.icon}</span>
            <span className="text-sm font-semibold text-brand-green">
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
