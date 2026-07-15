import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { EditionView } from "@/components/EditionView";

export const dynamic = "force-dynamic";

export default async function ArchiveDatePage({ params }: { params: { date: string } }) {
  const date = new Date(`${params.date}T00:00:00.000Z`);
  if (isNaN(date.getTime())) notFound();

  const edition = await prisma.edition.findUnique({
    where: { date },
    include: {
      articles: { where: { processed: true } }
    }
  });

  if (!edition) notFound();

  return (
    <main className="mx-auto w-full lg:w-3/4 max-w-6xl rounded-sm bg-paper/70 px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={edition.date} />
      <EditionView articles={edition.articles} />
    </main>
  );
}
