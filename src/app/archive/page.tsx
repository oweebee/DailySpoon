import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  const editions = await prisma.edition.findMany({
    where: { status: "published" },
    orderBy: { date: "desc" },
    include: { _count: { select: { articles: true } } }
  });

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <Masthead date={new Date()} />
      <h1 className="text-2xl font-bold mb-6">Archives</h1>
      <ul className="divide-y divide-neutral-300">
        {editions.map((edition) => {
          const key = edition.date.toISOString().slice(0, 10);
          const label = new Intl.DateTimeFormat("fr-FR", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
          }).format(edition.date);
          return (
            <li key={edition.id} className="py-3 flex items-baseline justify-between">
              <Link href={`/archive/${key}`} className="hover:underline capitalize">
                {label}
              </Link>
              <span className="text-sm text-neutral-500">
                {edition._count.articles} article{edition._count.articles > 1 ? "s" : ""}
              </span>
            </li>
          );
        })}
        {editions.length === 0 && (
          <p className="text-neutral-500 py-6">Aucune édition archivée pour l’instant.</p>
        )}
      </ul>
    </main>
  );
}
