import { STEP_TITLES } from "@/lib/quiz-data";

export default function QuizStepper({ current }: { current: number }) {
  return (
    <div className="card px-6 py-6">
      <div className="flex items-center justify-between">
        {STEP_TITLES.map((title, i) => {
          const step = i + 1;
          const active = step === current;
          const done = step < current;
          return (
            <div key={title} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-2">
                <div
                  className={[
                    "flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold transition-colors",
                    active
                      ? "bg-brand-orange text-white shadow-soft"
                      : done
                      ? "bg-brand-green-light text-white"
                      : "bg-cream-200 text-ink-muted",
                  ].join(" ")}
                >
                  {done ? "✓" : step}
                </div>
                <span
                  className={[
                    "text-xs font-semibold",
                    active ? "text-brand-green" : "text-ink-muted",
                  ].join(" ")}
                >
                  {title}
                </span>
              </div>
              {step < STEP_TITLES.length && (
                <div
                  className={[
                    "mx-2 h-[3px] flex-1 rounded-full transition-colors",
                    done ? "bg-brand-orange" : "bg-cream-200",
                  ].join(" ")}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
