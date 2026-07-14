import { QuizOption } from "@/types";

interface Props {
  option: QuizOption;
  selected: boolean;
  onSelect: () => void;
  multi?: boolean;
}

export default function OptionButton({ option, selected, onSelect, multi }: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        "flex w-full items-center gap-3 rounded-2xl border-2 bg-white px-4 py-4 text-left transition-all duration-150",
        selected
          ? "border-brand-orange shadow-card-hover"
          : "border-cream-200 hover:border-brand-orange/40 hover:shadow-card",
      ].join(" ")}
    >
      {option.emoji && (
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-brand-orange-soft text-lg">
          {option.emoji}
        </span>
      )}
      <span className="flex-1">
        <span className="block text-sm font-semibold text-brand-green">
          {option.label}
        </span>
        {option.description && (
          <span className="block text-xs text-ink-muted">{option.description}</span>
        )}
      </span>
      <span
        className={[
          "flex h-6 w-6 flex-none items-center justify-center border-2 text-xs transition-colors",
          multi ? "rounded-md" : "rounded-full",
          selected
            ? "border-brand-orange bg-brand-orange text-white"
            : "border-cream-200 text-transparent",
        ].join(" ")}
      >
        ✓
      </span>
    </button>
  );
}
