import { Product } from "@/types";

export default function ProductCard({ product }: { product: Product }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover">
      <div
        className={`flex h-28 items-center justify-center bg-gradient-to-br ${product.color}`}
      >
        <span className="text-5xl drop-shadow">{product.emoji}</span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-base font-bold text-brand-green">{product.name}</h3>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-orange">
          {product.tagline}
        </p>
        <p className="mt-2 flex-1 text-sm text-ink-muted">{product.description}</p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {product.benefits.map((b) => (
            <span
              key={b}
              className="rounded-full bg-brand-orange-soft px-2.5 py-1 text-[11px] font-medium text-brand-green"
            >
              {b}
            </span>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <span className="text-lg font-extrabold text-brand-green">
            ${product.price}
            <span className="text-xs font-medium text-ink-muted">/mo</span>
          </span>
          <button className="rounded-full bg-brand-green px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-green-mid">
            Add to plan
          </button>
        </div>
      </div>
    </div>
  );
}
