import Anthropic from "@anthropic-ai/sdk";
import type { RawItem } from "./freshrss";
import { getSettings } from "./settings";

export type ProcessedArticle = {
  headline: string;
  summary: string;
  category: string;
  priorityScore: number; // 1-100, higher = more important
  // true seulement si un vrai appel IA (processBatch/processBatchGemini) a
  // produit ce résultat — false pour fallbackProcess (texte brut, jamais
  // affiché sur la une IA de la page d'accueil, voir Article.aiRewritten).
  aiRewritten: boolean;
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

/**
 * Style d'écriture appliqué par l'IA lors de la réécriture des titres/
 * résumés (réglable dans /admin/settings, sans effet sur /direct). "normal"
 * n'ajoute aucune instruction (ton journalistique neutre déjà décrit dans le
 * prompt de base). "ackboo" injecte une consigne de ton en plus du reste du
 * prompt, qui continue de s'appliquer par ailleurs (fidélité au contenu,
 * citation de la source, longueur adaptée...).
 */
const WRITING_STYLES: Record<string, string> = {
  ackboo: `Consigne de TON impérative pour "headline" ET "summary" (et "frontPageSummary" le cas échéant) : adopte le style d'écriture d'Ackboo (rédacteur en chef historique de Canard PC) — sarcastique, passif-agressif, un humour cynique, intelligent et précis, avec une pointe de mauvaise foi assumée et de mépris amusé pour la bêtise ambiante, sans jamais sombrer dans la vulgarité gratuite ni la méchanceté pure. Glisse une pique, une ironie ou un aparté cinglant dans presque chaque résumé, mais SANS jamais déformer les faits ni inventer d'information : le fond reste fidèle et informatif, seul le ton change. Le titre peut être plus mordant/à double sens que d'habitude, tant qu'il reste compréhensible.`
};

function styleInstruction(writingStyle: string): string {
  return WRITING_STYLES[writingStyle] || "";
}

// Filet de sécurité partagé : certains flux (ex. Korben) fournissent parfois
// un extrait totalement vide (balisage/image sans texte réel des deux côtés
// summary/content) — sans repli, l'IA elle-même reçoit une chaîne vide et
// renvoie souvent un résumé vide en retour, et l'article se retrouve sans
// aucun texte affiché nulle part (y compris "à la une"). Utilisé partout où
// un résumé pourrait finir vide : fallbackProcess, processBatch(Gemini), et
// en dernier recours dans curateFrontPage.
const NO_EXCERPT_PLACEHOLDER = "Aucun aperçu fourni par le flux — consulte la source pour lire l'article complet.";

// Longueur de base de l'aperçu de texte affiché sous chaque article. Si
// l'article source est long (extrait brut au-delà de ce seuil), l'aperçu
// est doublé plutôt que coupé à la même longueur qu'un article court.
const BASE_SUMMARY_LEN = 800;
const LONG_SOURCE_THRESHOLD = BASE_SUMMARY_LEN * 2;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Process every raw RSS item into a rewritten, categorized, prioritized article.
 * Falls back to a naive local heuristic if no API key is configured for the
 * selected provider, so the app still runs end-to-end without an AI provider
 * connected.
 */
export async function processArticles(
  items: RawItem[],
  options: { forceNoAi?: boolean } = {}
): Promise<ProcessedArticle[]> {
  if (options.forceNoAi) {
    // Règle du projet : pas de conso de tokens là où ce n'est pas nécessaire.
    // /direct ("Aspirer les news") est un aperçu rapide et brut — jamais d'IA,
    // même si une IA est configurée pour l'édition quotidienne.
    return items.map(fallbackProcess);
  }

  const settings = await getSettings();
  const provider = settings.aiProvider === "gemini" ? "gemini" : "anthropic";

  if (provider === "gemini") {
    if (!settings.geminiApiKey) {
      console.warn("[ai] Gemini API key not set (env or /admin/settings) — using fallback heuristic processing.");
      return items.map(fallbackProcess);
    }
    return processInBatches(items, (batch) =>
      processBatchGemini(batch, settings.geminiApiKey, settings.geminiModel, settings.writingStyle)
    );
  }

  if (!settings.anthropicApiKey) {
    console.warn("[ai] Anthropic API key not set (env or /admin/settings) — using fallback heuristic processing.");
    return items.map(fallbackProcess);
  }
  const client = new Anthropic({ apiKey: settings.anthropicApiKey });
  return processInBatches(items, (batch) => processBatch(client, batch, settings.anthropicModel, settings.writingStyle));
}

async function processInBatches(
  items: RawItem[],
  processBatchFn: (batch: RawItem[]) => Promise<ProcessedArticle[]>
): Promise<ProcessedArticle[]> {
  const batches = chunk(items, BATCH_SIZE);
  const results: ProcessedArticle[] = [];

  for (const batch of batches) {
    try {
      const processed = await processBatchFn(batch);
      results.push(...processed);
    } catch (err) {
      console.error("[ai] Batch processing failed, falling back for this batch:", err);
      results.push(...batch.map(fallbackProcess));
    }
  }

  return results;
}

async function processBatch(
  client: Anthropic,
  batch: RawItem[],
  model: string,
  writingStyle: string
): Promise<ProcessedArticle[]> {
  const prompt = buildPrompt(batch, writingStyle);

  const response = await client.messages.create({
    model: model as any,
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
    summary: p.summary?.trim() || batch[i].sourceExcerpt?.trim() || NO_EXCERPT_PLACEHOLDER,
    category: p.category?.trim() || "Autre",
    priorityScore: clamp(Number(p.priorityScore) || 50, 1, 100),
    aiRewritten: true
  }));
}

// Appel REST direct plutôt qu'un SDK dédié (@google/generative-ai n'est pas
// une dépendance du projet, et l'ajouter demanderait de régénérer
// package-lock.json sans pouvoir vérifier le build ici) — l'API Gemini
// "generateContent" est un simple POST JSON, pas besoin de SDK pour ça.
async function processBatchGemini(
  batch: RawItem[],
  apiKey: string,
  model: string,
  writingStyle: string
): Promise<ProcessedArticle[]> {
  const prompt = buildPrompt(batch, writingStyle);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data: any = await res.json();
  const text: string = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => p?.text || "")
    .join("");

  const json = extractJson(text);
  const parsed = JSON.parse(json) as ProcessedArticle[];

  if (!Array.isArray(parsed) || parsed.length !== batch.length) {
    throw new Error(`Gemini returned ${parsed?.length ?? 0} items, expected ${batch.length}`);
  }

  return parsed.map((p, i) => ({
    headline: p.headline?.trim() || batch[i].sourceTitle,
    summary: p.summary?.trim() || batch[i].sourceExcerpt?.trim() || NO_EXCERPT_PLACEHOLDER,
    category: p.category?.trim() || "Autre",
    priorityScore: clamp(Number(p.priorityScore) || 50, 1, 100),
    aiRewritten: true
  }));
}

function buildPrompt(batch: RawItem[], writingStyle: string = "normal"): string {
  const items = batch.map((item, i) => ({
    index: i,
    source: item.feedTitle,
    title: item.sourceTitle,
    excerpt: (item.sourceExcerpt || "").slice(0, 3000),
    categoryHint: item.categoryLabel,
    // Signal explicite plutôt que de faire deviner la longueur voulue à
    // partir de la taille de l'extrait fourni.
    long: (item.sourceExcerpt || "").length > LONG_SOURCE_THRESHOLD
  }));

  const style = styleInstruction(writingStyle);

  return `Tu es le rédacteur en chef d'un journal quotidien personnel appelé "DailySpoon". \
${style ? `\n${style}\n\n` : ""}Voici une liste d'articles bruts issus de FreshRSS. Pour CHAQUE article, dans l'ordre, produis :
- "headline": un titre court et accrocheur, réécrit dans un style journalistique clair (en français), pas juste copié.
- "summary": un résumé fidèle, réécrit dans tes propres mots (ne pas copier le texte source mot pour mot). Longueur adaptée à l'article : 2-4 phrases si "long" est false, mais si "long" est true (article source substantiel), rédige un résumé deux fois plus développé qu'à l'habitude (environ 6-8 phrases) pour refléter le contenu réel de l'article. Cite intelligemment la provenance de l'info directement dans le texte, sans lien ni URL : selon le sujet, mentionne soit le média fourni dans "source" (ex : "selon Presse-citron", "rapporte Le Monde"), soit une personne ou un porte-parole cité dans l'article si l'info vient clairement de sa bouche (ex : "selon Elon Musk", "d'après le maire de Paris") — choisis ce qui est le plus naturel pour CET article précis, ne force pas la citation si elle alourdit une phrase courte.
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

export function fallbackProcess(item: RawItem): ProcessedArticle {
  // Pas de troncature : on affiche le texte complet fourni par le flux
  // (nettoyé du HTML), sans le couper à une longueur arbitraire. Filet de
  // sécurité : si le flux ne fournit vraiment aucun texte exploitable (ex.
  // un extrait qui n'était que du balisage/une image), on ne laisse jamais
  // l'article sans aucun aperçu — mieux vaut ce message que rien du tout.
  const fullText = (item.sourceExcerpt || "").trim();
  return {
    headline: item.sourceTitle,
    summary: fullText || NO_EXCERPT_PLACEHOLDER,
    category: item.categoryLabel || "Autre",
    priorityScore: 40,
    aiRewritten: false
  };
}

export type CurationItem = { id: string; headline: string; summary: string; category: string; source: string };
export type CurationResult = { priorityScore: number; frontPageSummary: string };

// Passe de curation de la "une" : contrairement à processArticles (qui note
// chaque article par lots indépendants de 12 — un article isolé dans un lot
// faible peut ressortir avec un score élevé par comparaison, même s'il est
// moins important qu'un article noté plus bas dans un lot très concurrentiel
// ailleurs), cette passe reçoit TOUS les articles retenus du jour EN UNE FOIS
// et les compare vraiment entre eux, pour que priorityScore reflète une
// hiérarchie cohérente sur l'ensemble de la journée — c'est ce score qui
// détermine ensuite les 3 articles "à la une" de FrontPageView.
//
// Produit aussi, dans le même appel, un "frontPageSummary" qui va à
// l'essentiel (2-3 phrases pour la plupart des sujets, jusqu'à 10 pour les
// sujets substantiels — pas de troncature arbitraire) et cite la source en
// passant dans le texte (jamais de lien), contrairement à `summary` utilisé
// tel quel sur En direct/favoris/archive.
//
// Un seul appel IA par génération (pas un par lot), sur des textes déjà
// réécrits et courts (titre + résumé, pas le texte source brut) : coût
// marginal, même avec une centaine d'articles dans la journée.
export async function curateFrontPage(items: CurationItem[]): Promise<Map<string, CurationResult>> {
  if (items.length === 0) return new Map();

  const settings = await getSettings();
  const provider = settings.aiProvider === "gemini" ? "gemini" : "anthropic";

  try {
    const curationPrompt = buildCurationPrompt(items, settings.writingStyle);
    const text =
      provider === "gemini"
        ? settings.geminiApiKey
          ? await callGeminiRaw(curationPrompt, settings.geminiApiKey, settings.geminiModel)
          : null
        : settings.anthropicApiKey
          ? await callAnthropicRaw(curationPrompt, settings.anthropicApiKey, settings.anthropicModel)
          : null;

    if (!text) return new Map(); // pas de clé configurée pour ce fournisseur

    const parsed = JSON.parse(extractJson(text)) as {
      id: string;
      priorityScore: number;
      frontPageSummary?: string;
    }[];
    if (!Array.isArray(parsed)) throw new Error("réponse IA non conforme (pas un tableau)");

    const map = new Map<string, CurationResult>();
    for (const p of parsed) {
      if (!p?.id) continue;
      const original = items.find((it) => it.id === p.id);
      map.set(p.id, {
        priorityScore: clamp(Number(p.priorityScore) || 40, 1, 100),
        frontPageSummary: p.frontPageSummary?.trim() || original?.summary?.trim() || NO_EXCERPT_PLACEHOLDER
      });
    }
    return map;
  } catch (err) {
    console.error("[ai] Curation de la une échouée, scores/résumés existants conservés :", err);
    return new Map();
  }
}

function buildCurationPrompt(items: CurationItem[], writingStyle: string = "normal"): string {
  const list = items.map((it) => ({
    id: it.id,
    headline: it.headline,
    summary: (it.summary || "").slice(0, 400),
    category: it.category,
    source: it.source
  }));

  const style = styleInstruction(writingStyle);

  return `Tu es le rédacteur en chef d'un journal quotidien personnel appelé "DailySpoon". ${style ? `\n${style}\n` : ""}Voici TOUS les articles retenus pour l'édition d'aujourd'hui, déjà réécrits.

Détermine, en comparant vraiment les articles ENTRE EUX (pas isolément), quelles sont les news les plus marquantes de la journée, pour composer une "une" cohérente. Pour CHAQUE article, dans l'ordre, donne :
- "priorityScore" : un score d'importance de 1 à 100 (100 = doit faire la une du jour, 1 = anecdotique). Les scores doivent réellement discriminer : seuls 1 à 3 articles au grand maximum doivent approcher 100, le reste doit s'étaler selon l'importance réelle.
- "frontPageSummary" : une réécriture du résumé fourni qui va droit à l'essentiel (l'info principale d'abord). Adapte la longueur au sujet : la plupart des articles n'ont besoin que de 2-3 phrases, mais si le sujet est substantiel/complexe, tu peux aller jusqu'à 10 phrases maximum pour rester fidèle et complet — jamais plus. Intègre aussi une citation journalistique de la source fournie ("source") directement dans le texte (ex : "selon Presse-citron", "rapporte Le Monde", "d'après Reuters"), SANS jamais insérer de lien ni d'URL — juste le nom du média mentionné en passant, comme dans un vrai article de journal.

Articles :
${JSON.stringify(list, null, 2)}

Réponds UNIQUEMENT avec un tableau JSON de ${items.length} objets, dans le même ordre, sans texte avant ou après, format :
[{"id": "...", "priorityScore": 0, "frontPageSummary": "..."}, ...]`;
}

async function callAnthropicRaw(prompt: string, apiKey: string, model: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: model as any,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }]
  });
  return response.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text as string)
    .join("");
}

async function callGeminiRaw(prompt: string, apiKey: string, model: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data: any = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("");
}

export { DEFAULT_CATEGORIES };
