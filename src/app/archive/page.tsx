import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { SpoonDivider } from "@/components/SpoonDivider";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  const editions = await prisma.edition.findMany({
    where: { status: "published" },
    orderBy: { date: "desc" },
    include: { _count: { select: { articles: true } } }
  });

  return (
    <main className="mx-auto w-full lg:w-3/4 rounded-sm bg-paper/70 px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={new Date()} />
      <h1 className="mb-6 text-center font-display text-3xl font-black uppercase tracking-[0.2em]">
        Archives
      </h1>
      <ul className="border-t-2 border-ink">
        {editions.map((edition) => {
          const key = edition.date.toISOString().slice(0, 10);
          const label = new Intl.DateTimeFormat("fr-FR", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
          }).format(edition.date);
          return (
            <li
              key={edition.id}
              className="flex items-baseline justify-between border-b border-ink/30 py-3"
            >
              <Link
                href={`/archive/${key}`}
                className="font-display text-lg capitalize hover:underline"
              >
                {label}
              </Link>
              <span className="text-sm italic text-sepia">
                {edition._count.articles} article{edition._count.articles > 1 ? "s" : ""}
              </span>
            </li>
          );
        })}
        {editions.length === 0 && (
          <p className="py-8 text-center italic text-sepia">
            Aucune édition archivée pour l’instant.
          </p>
        )}
      </ul>
      <SpoonDivider />
    </main>
  );
}
