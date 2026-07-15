import Link from "next/link";

export function Masthead({ date }: { date: Date }) {
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);

  return (
    <header className="border-b-4 border-ink pb-4 mb-8">
      <div className="flex items-baseline justify-between">
        <Link href="/" className="text-5xl md:text-6xl font-bold tracking-tight">
          DailySpoon
        </Link>
        <nav className="text-sm space-x-4">
          <Link href="/archive" className="underline hover:no-underline">
            Archives
          </Link>
        </nav>
      </div>
      <p className="mt-1 italic text-sm capitalize">{formatted}</p>
    </header>
  );
}
