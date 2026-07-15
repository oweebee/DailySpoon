import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { EditionView } from "@/components/EditionView";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Show the most recent edition available (today's if generated, otherwise the latest).
  const edition = await prisma.edition.findFirst({
    orderBy: { date: "desc" },
    include: {
      articles: { where: { processed: true } }
    }
  });

  return (
    <main className="mx-auto w-full lg:w-3/4 rounded-sm bg-paper/70 px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={edition?.date ?? new Date()} />
      {edition ? (
        <EditionView articles={edition.articles} />
      ) : (
        <p className="py-24 text-center italic text-sepia">
          Aucune édition générée pour l’instant. Sélectionne des catégories FreshRSS dans l’admin
          puis lance une génération.
        </p>
      )}
    </main>
  );
}
