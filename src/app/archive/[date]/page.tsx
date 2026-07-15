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
    <main className="max-w-5xl mx-auto px-6 py-10">
      <Masthead date={edition.date} />
      <EditionView articles={edition.articles} />
    </main>
  );
}
