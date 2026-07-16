import Link from "next/link";

export function Masthead({ date }: { date: Date }) {
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);

  return (
    <header className="mb-10">
      {/* Bandeau supérieur */}
      <div className="flex items-center justify-between border-b border-ink py-1 text-[0.65rem] uppercase tracking-[0.25em] text-sepia">
        <span>Édition quotidienne personnelle</span>
        <span>Prix : un café</span>
      </div>

      {/* Masthead gothique centré */}
      <div className="py-6 text-center">
        <Link href="/" className="font-masthead text-5xl font-black uppercase tracking-tight md:text-7xl">
          DailySpoon
        </Link>
      </div>

      {/* Ligne de date entre deux filets */}
      <div className="double-rule" />
      <div className="flex items-center justify-between py-1.5 text-xs uppercase tracking-[0.2em]">
        <span className="capitalize">{formatted}</span>
        <nav className="space-x-6">
          <Link href="/direct" className="text-journal hover:underline">
            En direct
          </Link>
          <Link href="/archive" className="hover:underline">
            Archives
          </Link>
          <Link href="/favoris" className="hover:underline">
            Favoris
          </Link>
          <Link href="/admin/categories" className="text-sepia hover:underline">
            Admin
          </Link>
        </nav>
      </div>
      <div className="double-rule rotate-180" />
    </header>
  );
}
