import Link from "next/link";

export default function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`group inline-flex flex-col leading-none ${className}`}>
      <span
        className="text-3xl font-extrabold tracking-tight text-brand-green-light drop-shadow-sm"
        style={{ fontFamily: "var(--font-script)" }}
      >
        YoYo
      </span>
      <span className="text-xs font-bold tracking-[0.35em] text-brand-orange">
        AK-100
      </span>
    </Link>
  );
}
