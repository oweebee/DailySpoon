import Anthropic from "@anthropic-ai/sdk";
import type { RawItem } from "./freshrss";

export type ProcessedArticle = {
  headline: string;
  summary: string;
  category: string;
  priorityScore: number; // 1-100, higher = more important
};

const DEFAULT_CATEGORIES = [
  "Une",
  "International",
  "Politique",
  "Économie",
  "Tech",
  "Sciences",
  "Culture",
  "Sport",
  "Autre"
];

const BATCH_SIZE = 12;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Process every raw RSS item into a rewritten, categorized, prioritized article.
 * Falls back to a naive local heuristic if no ANTHROPIC_API_KEY is configured,
 * so the app still runs end-to-end without an AI provider connected.
 */
export async function processArticles(items: RawItem[]): Promise<ProcessedArticle[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[ai] ANTHROPIC_API_KEY not set — using fallback heuristic processing.");
    return items.map(fallbackProcess);
  }

  const client = new Anthropic({ apiKey });
  const batches = chunk(items, BATCH_SIZE);
  const results: ProcessedArticle[] = [];

  for (const batch of batches) {
    try {
      const processed = await processBatch(client, batch);
      results.push(...processed);
    } catch (err) {
      console.error("[ai] Batch processing failed, falling back for this batch:", err);
      results.push(...batch.map(fallbackProcess));
    }
  }

  return results;
}

async function processBatch(client: Anthropic, batch: RawItem[]): Promise<ProcessedArticle[]> {
  const prompt = buildPrompt(batch);

  const response = await client.messages.create({
    model: (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5") as any,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }]
  });

  const text = response.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text as string)
    .join("");

  const json = extractJson(text);
  const parsed = JSON.parse(json) as ProcessedArticle[];

  if (!Array.isArray(parsed) || parsed.length !== batch.length) {
    throw new Error(`AI returned ${parsed?.length ?? 0} items, expected ${batch.length}`);
  }

  return parsed.map((p, i) => ({
    headline: p.headline?.trim() || batch[i].sourceTitle,
    summary: p.summary?.trim() || batch[i].sourceExcerpt || "",
    category: p.category?.trim() || "Autre",
    priorityScore: clamp(Number(p.priorityScore) || 50, 1, 100)
  }));
}

function buildPrompt(batch: RawItem[]): string {
  const items = batch.map((item, i) => ({
    index: i,
    source: item.feedTitle,
    title: item.sourceTitle,
    excerpt: (item.sourceExcerpt || "").slice(0, 1500),
    categoryHint: item.categoryLabel
  }));

  return `Tu es le rédacteur en chef d'un journal quotidien personnel appelé "DailySpoon". \
Voici une liste d'articles bruts issus de FreshRSS. Pour CHAQUE article, dans l'ordre, produis :
- "headline": un titre court et accrocheur, réécrit dans un style journalistique clair (en français), pas juste copié.
- "summary": un résumé fidèle et concis en 2-4 phrases, réécrit dans tes propres mots (ne pas copier le texte source mot pour mot).
- "category": une rubrique parmi ${JSON.stringify(DEFAULT_CATEGORIES)} (choisis la plus pertinente ; utilise "Une" seulement pour l'article vraiment le plus important du lot).
- "priorityScore": un entier de 1 à 100 indiquant l'importance de la nouvelle pour l'édition du jour (100 = à la une, 1 = anecdotique).

Articles :
${JSON.stringify(items, null, 2)}

Réponds UNIQUEMENT avec un tableau JSON valide de ${batch.length} objets, dans le même ordre que les articles fournis, sans texte avant ou après, format :
[{"headline": "...", "summary": "...", "category": "...", "priorityScore": 0}, ...]`;
}

function extractJson(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return text;
  return text.slice(start, end + 1);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function fallbackProcess(item: RawItem): ProcessedArticle {
  return {
    headline: item.sourceTitle,
    summary: (item.sourceExcerpt || "").slice(0, 400),
    category: item.categoryLabel || "Autre",
    priorityScore: 40
  };
}

export { DEFAULT_CATEGORIES };
