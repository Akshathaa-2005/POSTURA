import Head from "next/head";
import Link from "next/link";
import type { ReactNode } from "react";

export default function Layout({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <Head>
        <title>{title ? `${title} · Postura` : "Postura · Your real-time form coach"}</title>
      </Head>
      <div className="flex min-h-screen flex-col text-ink">
        <header className="mx-auto flex w-full max-w-[1500px] items-center justify-between px-5 py-6 sm:px-8">
          <Link href="/" className="group flex items-center gap-3" aria-label="Postura home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/postura-mark.png" alt="" width={34} height={44} className="h-11 w-auto transition duration-500 group-hover:-rotate-3" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/postura-wordmark.png" alt="Postura" width={120} height={28} className="h-6 w-auto" />
            <span className="eyebrow ml-2 hidden border-l border-slate/15 pl-4 transition group-hover:text-ink md:inline">
              Form · Breath · Flow
            </span>
          </Link>
          {actions}
        </header>
        <main className="mx-auto w-full max-w-[1500px] flex-1 px-5 pb-16 sm:px-8">{children}</main>
        <footer className="mx-auto flex w-full max-w-[1500px] items-center justify-between border-t border-slate/10 px-5 py-6 sm:px-8">
          <span className="eyebrow">@postura</span>
          <span className="eyebrow">Runs privately in your browser</span>
        </footer>
      </div>
    </>
  );
}
