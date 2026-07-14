import { GoalCardData } from "@/lib/quiz-data";

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
      {/* Check indicator */}
      <span
        className={[
          "absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs transition-colors",
          selected
            ? "border-brand-orange bg-brand-orange text-white"
            : "border-white bg-white/70 text-transparent",
        ].join(" ")}
      >
        ✓
      </span>

      {/* Visual area */}
      <div
        className={`relative flex h-24 items-center justify-center bg-gradient-to-br ${goal.visual}`}
      >
        <span
          className={`absolute -bottom-5 left-4 flex h-11 w-11 items-center justify-center rounded-full text-xl shadow-soft ${goal.badge}`}
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
