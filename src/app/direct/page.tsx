import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { DirectView } from "@/components/DirectView";

export const dynamic = "force-dynamic";

export default async function DirectPage() {
  // Same "latest edition" data as the home page — the point of /direct is
  // the "Aspirer les news" button, which fetches + regenerates on demand
  // instead of waiting for the worker's scheduled run.
  const edition = await prisma.edition.findFirst({
    orderBy: { date: "desc" },
    include: {
      articles: { where: { processed: true } }
    }
  });

  return (
    <main className="mx-auto w-full lg:w-3/4 rounded-sm bg-paper/70 px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={edition?.date ?? new Date()} />
      <DirectView initialArticles={edition?.articles ?? []} />
    </main>
  );
}
