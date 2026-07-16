import PhotoWithFallback from "./PhotoWithFallback";

const ITEMS = [
  { icon: "🌿", label: "Natural Ingredients" },
  { icon: "💛", label: "Made with Love" },
  { icon: "🛡️", label: "Rooted in Tradition" },
  { icon: "🇺🇸", label: "Made in USA" },
];

const AVATARS = [
  { src: "/images/avatar-1.jpg", emoji: "🧑" },
  { src: "/images/avatar-2.jpg", emoji: "👩" },
  { src: "/images/avatar-3.jpg", emoji: "🧔" },
  { src: "/images/avatar-4.jpg", emoji: "👩‍🦰" },
];

export default function TrustBar() {
  return (
    <div className="rounded-2xl border border-brand-orange-soft bg-cream-50/70 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            {AVATARS.map((a, i) => (
              <PhotoWithFallback
                key={i}
                src={a.src}
                alt="Happy customer"
                fallbackGradient="from-brand-orange-soft to-amber-100"
                fallbackContent={<span className="text-sm">{a.emoji}</span>}
                className="h-8 w-8 rounded-full border-2 border-white"
              />
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
