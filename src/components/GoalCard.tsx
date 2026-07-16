import { GoalCardData } from "@/lib/quiz-data";
import PhotoWithFallback from "./PhotoWithFallback";

interface Props {
  goal: GoalCardData;
  selected: boolean;
  onToggle: () => void;
}

export default function GoalCard({ goal, selected, onToggle }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={[
        "group relative overflow-hidden rounded-2xl border-2 bg-white text-left transition-all duration-200",
        selected
          ? "border-brand-orange shadow-card-hover"
          : "border-transparent shadow-card hover:-translate-y-0.5 hover:shadow-card-hover",
      ].join(" ")}
    >
      {/* Photo header */}
      <div className="relative">
        <PhotoWithFallback
          src={goal.photo}
          alt={goal.title}
          fallbackGradient={goal.visual}
          fallbackContent={goal.emoji}
          className="h-28 w-full"
        />

        {/* Check indicator (top-right) */}
        <span
          className={[
            "absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs shadow-sm transition-colors",
            selected
              ? "border-brand-orange bg-brand-orange text-white"
              : "border-white bg-white/40 text-transparent",
          ].join(" ")}
        >
          ✓
        </span>

        {/* Icon badge overlapping the bottom of the photo */}
        <span
          className={`absolute -bottom-5 left-4 z-10 flex h-11 w-11 items-center justify-center rounded-full text-xl shadow-soft ring-2 ring-white ${goal.badge}`}
        >
          {goal.emoji}
        </span>
      </div>

      <div className="px-4 pb-4 pt-7 text-center">
        <h3 className="text-sm font-bold text-brand-green">{goal.title}</h3>
        <p className="mt-1 text-xs text-ink-muted">{goal.description}</p>
      </div>
    </button>
  );
}
