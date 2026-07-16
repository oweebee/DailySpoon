import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { FavoritesList } from "@/components/FavoritesList";

export const dynamic = "force-dynamic";

export default async function FavoritesPage() {
  const articles = await prisma.article.findMany({
    where: { favorite: true },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      headline: true,
      sourceTitle: true,
      sourceUrl: true,
      feedTitle: true
    }
  });

  return (
    <main className="mx-auto w-full lg:w-3/4 rounded-sm bg-paper/70 px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={new Date()} />

      <h1 className="mb-6 text-center font-display text-2xl font-black uppercase tracking-[0.15em]">
        Favoris
      </h1>

      <FavoritesList articles={articles} />

      <p className="mt-14 text-center text-xl tracking-[0.5em] text-sepia">❦ ❦ ❦</p>
    </main>
  );
}
