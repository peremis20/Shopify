import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import Quiz from "@/components/Quiz";
import TrustBar from "@/components/TrustBar";

export default function HomePage() {
  return (
    <main className="page-bg">
      <Navbar />
      <Hero />
      <Quiz />
      <div className="mx-auto max-w-6xl px-5 pb-14">
        <TrustBar />
      </div>
      <footer className="border-t border-brand-green/10 bg-cream-50 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-5 text-center">
          <p className="text-sm text-ink-muted">
            🔒 Your information is always private and secure.
          </p>
          <p className="text-xs text-ink-muted">
            © {new Date().getFullYear()} YoYo AK-100. Made with 💛 in the USA.
          </p>
        </div>
      </footer>
    </main>
  );
}
