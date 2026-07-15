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
    <main className="mx-auto max-w-5xl px-6 py-10">
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
