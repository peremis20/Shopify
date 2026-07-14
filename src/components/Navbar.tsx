"use client";

import Link from "next/link";
import { useState } from "react";
import Logo from "./Logo";
import { useAuth } from "@/lib/auth-context";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/#shop", label: "Shop" },
  { href: "/#menu", label: "Menu" },
  { href: "/#story", label: "Our Story" },
  { href: "/#contact", label: "Contact" },
];

export default function Navbar() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-brand-green/5 bg-cream-50/80 backdrop-blur-md">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Logo />

        <div className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className="text-sm font-medium text-brand-green/80 transition-colors hover:text-brand-orange"
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <button aria-label="Search" className="hidden text-brand-green/70 hover:text-brand-orange sm:block">
            <SearchIcon />
          </button>

          {user ? (
            <div className="flex items-center gap-3">
              <Link
                href="/dashboard"
                className="text-sm font-semibold text-brand-green hover:text-brand-orange"
              >
                Dashboard
              </Link>
              <button
                onClick={() => signOut()}
                className="hidden text-sm font-medium text-ink-muted hover:text-brand-orange sm:block"
              >
                Sign out
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              aria-label="Account"
              className="text-brand-green/70 hover:text-brand-orange"
            >
              <UserIcon />
            </Link>
          )}

          <Link href="/#shop" aria-label="Cart" className="relative text-brand-green/70 hover:text-brand-orange">
            <CartIcon />
            <span className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-brand-orange text-[10px] font-bold text-white">
              2
            </span>
          </Link>

          <button
            className="md:hidden text-brand-green"
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
          >
            <MenuIcon />
          </button>
        </div>
      </nav>

      {open && (
        <div className="border-t border-brand-green/5 bg-cream-50 px-5 py-3 md:hidden">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block py-2 text-sm font-medium text-brand-green/80"
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </header>
  );
}

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}
function UserIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" strokeLinecap="round" />
    </svg>
  );
}
function CartIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 4h2l2.5 12h10l2-8H6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="17" cy="20" r="1.5" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </svg>
  );
}
