import Head from "next/head";
import Link from "next/link";
import type { ReactNode } from "react";

export default function Layout({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <Head>
        <title>{title ? `${title} · AI Coach` : "AI Coach"}</title>
      </Head>
      <div className="flex min-h-screen flex-col text-ink">
        <header className="mx-auto flex w-full max-w-[1500px] items-center justify-between px-5 py-6 sm:px-8">
          <Link href="/" className="group flex items-baseline gap-3">
            <span className="font-display text-2xl font-medium tracking-wide">AI Coach</span>
            <span className="eyebrow hidden transition group-hover:text-ink sm:inline">Form · Breath · Flow</span>
          </Link>
          {actions}
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 px-5 pb-16 sm:px-8">{children}</main>
        <footer className="mx-auto flex w-full max-w-[1500px] items-center justify-between border-t border-slate/10 px-5 py-6 sm:px-8">
          <span className="eyebrow">@aicoach</span>
          <span className="eyebrow">Runs privately in your browser</span>
        </footer>
      </div>
    </>
  );
}
