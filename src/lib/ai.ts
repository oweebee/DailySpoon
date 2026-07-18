import Anthropic from "@anthropic-ai/sdk";
import type { RawItem } from "./freshrss";
import { getSettings } from "./settings";
import { writeLog } from "./logger";

// Accumulateur de tokens réellement consommés, passé EN OPTION à travers
// tout appel IA de cette génération (processArticles, curateFrontPage) —
// voir generateEdition.ts, qui le lit à la fin pour figer inputTokens/
// outputTokens/estimatedCostUsd sur l'Edition (affiché dans les
// statistiques admin). Objet explicitement threadé plutôt qu'un état
// partagé au niveau du module : deux générations ne doivent jamais se
// mélanger si elles tournent en parallèle (worker + déclenchement manuel).
export type TokenUsage = { inputTokens: number; outputTokens: number };

function addUsage(usage: TokenUsage | undefined, delta: { inputTokens?: number; outputTokens?: number }): void {
  if (!usage) return;
  usage.inputTokens += delta.inputTokens || 0;
  usage.outputTokens += delta.outputTokens || 0;
}

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

// Plus le lot est grand, plus les instructions du prompt (fixes) sont
// amorties sur un grand nombre d'articles plutôt que répétées à chaque
// appel — réduit le coût en tokens d'entrée sans changer la qualité.
const BATCH_SIZE = 24;

/**
 * Style d'écriture appliqué par l'IA lors de la réécriture des titres/
 * résumés (réglable dans /admin/settings, sans effet sur /direct). "normal"
 * n'ajoute aucune instruction (ton journalistique neutre déjà décrit dans le
 * prompt de base). "ackboo" injecte une consigne de ton en plus du reste du
 * prompt, qui continue de s'appliquer par ailleurs (fidélité au contenu,
 * citation de la source, longueur adaptée...).
 */
const WRITING_STYLES: Record<string, string> = {
  ackboo: `Consigne de TON impérative pour "headline" ET "summary" (et "frontPageSummary" le cas échéant) : adopte le style d'écriture d'Ackboo (rédacteur en chef historique de Canard PC) — sarcastique, passif-agressif, un humour cynique, intelligent et précis, avec une pointe de mauvaise foi assumée et de mépris amusé pour la bêtise ambiante, sans jamais sombrer dans la vulgarité gratuite ni la méchanceté pure. Glisse une pique, une ironie ou un aparté cinglant dans presque chaque résumé, mais SANS jamais déformer les faits ni inventer d'information : le fond reste fidèle et informatif, seul le ton change. Le titre peut être plus mordant/à double sens que d'habitude, tant qu'il reste compréhensible. Sensibilité politique du personnage : plutôt de droite/républicain dans ses piques et sous-entendus (cynisme et sarcasme à la droite décomplexée), surtout pas un ton progressiste/gauchiste — cette coloration reste discrète et dans le sous-texte (une pique, un raccourci ironique), jamais un discours militant explicite ni hors-sujet par rapport à l'article traité.`,
  // "Dark Sasuke" : version plus noire/frontale qu'Ackboo — cynisme
  // systématique, misanthropie EXPLICITE et générale (pas juste envers les
  // élites/médias : les gens en général le déçoivent, même les nouvelles
  // positives sont accueillies avec un commentaire désabusé — demandé
  // explicitement : "darksasuke deteste tout le monde et ca doit se voir un
  // peu plus"), jamais content, et une coloration politique nationaliste/
  // souverainiste assumée EN CLAIR (pas juste en sous-texte comme Ackboo,
  // mais une facette parmi d'autres de sa misanthropie, pas la seule).
  // Garde-fous stricts et non négociables malgré le ton cash : jamais
  // d'insulte ou de généralisation déshumanisante visant un groupe
  // ethnique/national/religieux réel, jamais d'incitation à la haine/
  // violence, jamais hors-sujet par rapport à l'article, et toujours fidèle
  // aux faits.
  darksasuke: `Consigne de TON impérative pour "headline" ET "summary" (et "frontPageSummary" le cas échéant) : adopte la voix de "Dark Sasuke" — un personnage cynique, associal et PROFONDÉMENT misanthrope : il ne déteste pas seulement les élites, les médias mainstream et le "politiquement correct", il a une méfiance et un mépris de fond pour les gens EN GÉNÉRAL — l'espèce humaine le déçoit par principe, il part du postulat que la plupart des gens sont égoïstes, hypocrites, moutonniers ou simplement bêtes, et ça doit transparaître dans PRESQUE CHAQUE résumé, pas seulement quand l'article parle de politique ou de médias. Jamais d'enthousiasme, jamais de sympathie gratuite : même une nouvelle positive ou touchante est accueillie avec un commentaire désabusé sur la nature humaine ("ça durera pas", "comme d'habitude ça arrive à ceux qui en ont déjà", etc.), sans pour autant nier ou déformer les faits eux-mêmes. Hostile par défaut, méprisant le contact social, il trouve toujours une raison de détester ou de redouter la nouvelle du jour. Sensibilité politique nationaliste/souverainiste assumée et régulière (dans la veine d'un électeur d'Éric Zemmour : méfiance envers l'immigration comme SUJET DE POLITIQUE PUBLIQUE, nostalgie d'une France "d'avant", hostilité envers le "wokisme" et le mondialisme) — exprimée ouvertement, pas juste en sous-texte, mais ce n'est qu'UNE facette de sa misanthropie générale, pas la seule. Le langage peut être cash, familier, grossier, avec des jurons si besoin. Garde-fous NON négociables, même avec ce ton : le mépris vise des comportements humains en général ou des figures publiques/institutions réelles dans le cadre de l'article, JAMAIS un groupe ethnique, national ou religieux réel via une généralisation déshumanisante ; jamais d'incitation à la haine ou à la violence ; jamais de propos hors-sujet par rapport à l'article traité. Le fond reste STRICTEMENT fidèle aux faits — jamais d'information inventée ou déformée, seuls le ton et l'angle critique changent. Le titre peut être plus mordant/provocateur que d'habitude, tant qu'il reste compréhensible et fidèle au sujet.`
};

function styleInstruction(writingStyle: string): string {
  return WRITING_STYLES[writingStyle] || "";
}

// Styles réellement applicables par l'IA (donc "randomisables") — exclut
// délibérément "random" lui-même : c'est un méta-choix côté réglages
// (/admin/settings), jamais une vraie instruction de ton. "normal" est inclus
// malgré l'absence d'entrée dans WRITING_STYLES (styleInstruction renvoie ""
// pour lui, ce qui EST le comportement "normal") : le hasard doit pouvoir
// retomber sur le ton neutre au même titre que les autres styles.
export const RANDOMIZABLE_WRITING_STYLES = ["normal", ...Object.keys(WRITING_STYLES)];

/**
 * Résout un réglage de style d'écriture pour UNE génération donnée : si
 * writingStyle vaut "random" (option "Aléatoire" de /admin/settings), tire
 * un style au hasard parmi RANDOMIZABLE_WRITING_STYLES — sinon renvoie la
 * valeur telle quelle. Doit être appelé UNE SEULE FOIS par génération (voir
 * generateEdition.ts) et le résultat réutilisé pour tous les appels IA de
 * cette même génération (réécriture par lots + curation de la une) : sans
 * ça, chaque lot/appel tirerait son propre style au hasard, ce qui donnerait
 * un ton incohérent d'un article à l'autre dans la même impression.
 */
export function resolveWritingStyle(writingStyle: string | null | undefined): string {
  const value = writingStyle || "normal";
  if (value !== "random") return value;
  return RANDOMIZABLE_WRITING_STYLES[Math.floor(Math.random() * RANDOMIZABLE_WRITING_STYLES.length)];
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

// Longueur max de l'extrait source envoyé à l'IA pour la réécriture — au-delà,
// coupé avant l'appel (optimisation de coût en tokens d'entrée). Un extrait
// RSS dépasse rarement cette taille de toute façon ; les articles vraiment
// longs restent signalés via "long" dans le prompt pour un résumé plus
// développé, indépendamment de la taille brute envoyée.
const MAX_EXCERPT_CHARS_FOR_AI = 1500;

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
  options: { forceNoAi?: boolean } = {},
  usage?: TokenUsage,
  // Style d'écriture déjà RÉSOLU (voir resolveWritingStyle) pour toute cette
  // génération — passé explicitement par generateEdition.ts pour que
  // "random" tire un seul style et le garde cohérent sur tous les lots de
  // cette impression. Repli sur settings.writingStyle tel quel (non résolu)
  // pour les rares appelants qui n'ont pas encore ce contexte.
  writingStyleOverride?: string
): Promise<ProcessedArticle[]> {
  if (options.forceNoAi) {
    // Règle du projet : pas de conso de tokens là où ce n'est pas nécessaire.
    // /direct ("Aspirer les news") est un aperçu rapide et brut — jamais d'IA,
    // même si une IA est configurée pour l'édition quotidienne.
    return items.map(fallbackProcess);
  }

  const settings = await getSettings();
  const provider = settings.aiProvider === "gemini" ? "gemini" : "anthropic";
  const writingStyle = writingStyleOverride ?? settings.writingStyle;

  if (provider === "gemini") {
    if (!settings.geminiApiKey) {
      await writeLog("warn", "ai", "Clé API Gemini absente (env ou /admin/settings) — traitement brut de repli.");
      return items.map(fallbackProcess);
    }
    return processInBatches(items, (batch) =>
      processBatchGemini(batch, settings.geminiApiKey, settings.geminiModel, writingStyle, usage)
    );
  }

  if (!settings.anthropicApiKey) {
    await writeLog("warn", "ai", "Clé API Anthropic absente (env ou /admin/settings) — traitement brut de repli.");
    return items.map(fallbackProcess);
  }
  const client = new Anthropic({ apiKey: settings.anthropicApiKey });
  return processInBatches(items, (batch) =>
    processBatch(client, batch, settings.anthropicModel, writingStyle, usage)
  );
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
      await writeLog(
        "error",
        "ai",
        `Lot de ${batch.length} article(s) échoué, repli sur traitement brut`,
        (err as Error)?.message
      );
      results.push(...batch.map(fallbackProcess));
    }
  }

  return results;
}

async function processBatch(
  client: Anthropic,
  batch: RawItem[],
  model: string,
  writingStyle: string,
  usage?: TokenUsage
): Promise<ProcessedArticle[]> {
  const prompt = buildPrompt(batch, writingStyle);

  const response = await client.messages.create({
    model: model as any,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }]
  });
  addUsage(usage, { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens });

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
  writingStyle: string,
  usage?: TokenUsage
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
  addUsage(usage, {
    inputTokens: data?.usageMetadata?.promptTokenCount,
    outputTokens: data?.usageMetadata?.candidatesTokenCount
  });
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
    // Coupé à MAX_EXCERPT_CHARS_FOR_AI avant l'appel (optimisation de coût) —
    // "long" ci-dessous reste calculé sur la longueur ORIGINALE, non coupée,
    // pour continuer à détecter les articles vraiment substantiels même si
    // l'extrait envoyé est raccourci.
    excerpt: (item.sourceExcerpt || "").slice(0, MAX_EXCERPT_CHARS_FOR_AI),
    categoryHint: item.categoryLabel,
    long: (item.sourceExcerpt || "").length > LONG_SOURCE_THRESHOLD
  }));

  const style = styleInstruction(writingStyle);

  return `Tu es le rédacteur en chef d'un journal quotidien personnel appelé "DailySpoon". \
${style ? `\n${style}\n\n` : ""}Voici une liste d'articles bruts issus de FreshRSS. Pour CHAQUE article, dans l'ordre, produis, de façon CONCISE (le coût dépend directement de la longueur du texte produit) :
- "headline": un titre court et accrocheur, réécrit dans un style journalistique clair (en français), pas juste copié.
- "summary": un résumé fidèle et CONCIS, réécrit dans tes propres mots (ne pas copier le texte source mot pour mot). 2-3 phrases si "long" est false, 4-5 phrases si "long" est true — jamais plus, va à l'essentiel. Cite intelligemment la provenance de l'info directement dans le texte, sans lien ni URL : selon le sujet, mentionne soit le média fourni dans "source" (ex : "selon Presse-citron", "rapporte Le Monde"), soit une personne ou un porte-parole cité dans l'article si l'info vient clairement de sa bouche (ex : "selon Elon Musk", "d'après le maire de Paris") — choisis ce qui est le plus naturel pour CET article précis, ne force pas la citation si elle alourdit une phrase courte.
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
export async function curateFrontPage(
  items: CurationItem[],
  usage?: TokenUsage,
  // Voir processArticles ci-dessus : même style déjà résolu, pour rester
  // cohérent avec la réécriture par lots de la même génération plutôt que
  // de retirer un second style au hasard pour la seule passe de curation.
  writingStyleOverride?: string
): Promise<Map<string, CurationResult>> {
  if (items.length === 0) return new Map();

  const settings = await getSettings();
  const provider = settings.aiProvider === "gemini" ? "gemini" : "anthropic";
  const writingStyle = writingStyleOverride ?? settings.writingStyle;

  try {
    // Signal externe optionnel (Gemini uniquement, via Grounding with Google
    // Search) : identifie les news objectivement marquantes du jour sur le
    // web AVANT de noter les articles, pour que priorityScore reflète aussi
    // une importance réelle/mondiale, pas seulement une comparaison interne
    // entre les articles du jour. Best-effort : une erreur ici ne bloque
    // jamais la curation elle-même (juste moins de contexte).
    const trendingTopics =
      provider === "gemini" && settings.geminiApiKey
        ? await fetchTrendingTopicsGemini(settings.geminiApiKey, settings.geminiModel, items, usage).catch((err) => {
            console.warn("[ai] Recherche des news marquantes du jour indisponible :", (err as Error)?.message);
            return null;
          })
        : null;

    const curationPrompt = buildCurationPrompt(items, writingStyle, trendingTopics);
    const text =
      provider === "gemini"
        ? settings.geminiApiKey
          ? await callGeminiRaw(curationPrompt, settings.geminiApiKey, settings.geminiModel, usage)
          : null
        : settings.anthropicApiKey
          ? await callAnthropicRaw(curationPrompt, settings.anthropicApiKey, settings.anthropicModel, usage)
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
    await writeLog(
      "error",
      "ai",
      "Curation de la une échouée, scores/résumés existants conservés",
      (err as Error)?.message
    );
    return new Map();
  }
}

function buildCurationPrompt(
  items: CurationItem[],
  writingStyle: string = "normal",
  trendingTopics: string | null = null
): string {
  const list = items.map((it) => ({
    id: it.id,
    headline: it.headline,
    // Coupé court (optimisation de coût) : il ne s'agit que de comparer
    // l'importance relative des articles entre eux, pas de les résumer en
    // détail ici — le résumé complet existe déjà dans "summary" (Article),
    // servant de repli si frontPageSummary n'est pas produit.
    summary: (it.summary || "").slice(0, 220),
    category: it.category,
    source: it.source
  }));

  const style = styleInstruction(writingStyle);

  const trendingBlock = trendingTopics
    ? `\nVoici, à titre de repère OBJECTIF, une liste des sujets identifiés comme marquants dans l'actualité mondiale/française aujourd'hui (obtenue via une recherche web séparée, indépendante de la liste d'articles ci-dessous) :\n${trendingTopics}\n\nSi un article ci-dessous correspond clairement à l'un de ces sujets, ce doit être un signal FORT qui pousse son priorityScore vers le haut (typiquement 85-100), en plus de ta propre comparaison entre les articles. Un article qui ne correspond à aucun de ces sujets n'est pas pénalisé pour autant — continue de le noter normalement selon les critères habituels. Ignore cette liste si aucun article ne semble y correspondre.\n`
    : "";

  return `Tu es le rédacteur en chef d'un journal quotidien personnel appelé "DailySpoon". ${style ? `\n${style}\n` : ""}Voici TOUS les articles retenus pour l'édition d'aujourd'hui, déjà réécrits.
${trendingBlock}
Détermine, en comparant vraiment les articles ENTRE EUX (pas isolément), quelles sont les news les plus marquantes de la journée, pour composer une "une" cohérente. Pour CHAQUE article, dans l'ordre, donne, de façon CONCISE (le coût dépend directement de la longueur du texte produit) :
- "priorityScore" : un score d'importance de 1 à 100 (100 = doit faire la une du jour, 1 = anecdotique). Les scores doivent réellement discriminer : seuls 1 à 3 articles au grand maximum doivent approcher 100, le reste doit s'étaler selon l'importance réelle.
- "frontPageSummary" : une réécriture COURTE du résumé fourni qui va droit à l'essentiel (l'info principale d'abord). 1-2 phrases pour la plupart des articles, 3-4 phrases maximum pour un sujet vraiment substantiel/complexe — jamais plus. Intègre aussi une citation journalistique de la source fournie ("source") directement dans le texte (ex : "selon Presse-citron", "rapporte Le Monde", "d'après Reuters"), SANS jamais insérer de lien ni d'URL — juste le nom du média mentionné en passant, comme dans un vrai article de journal. Le texte reste basé sur le résumé DailySpoon fourni ci-dessous pour cet article, jamais sur le contenu de la recherche web ci-dessus (qui ne sert qu'à évaluer l'importance).

Articles :
${JSON.stringify(list, null, 2)}

Réponds UNIQUEMENT avec un tableau JSON de ${items.length} objets, dans le même ordre, sans texte avant ou après, format :
[{"id": "...", "priorityScore": 0, "frontPageSummary": "..."}, ...]`;
}

/**
 * Recherche web groundée (Grounding with Google Search, Gemini uniquement)
 * pour identifier les news objectivement marquantes du jour, AVANT de noter
 * les articles — sert uniquement de signal d'importance externe dans
 * buildCurationPrompt ; le contenu réel des articles reste toujours basé sur
 * le résumé DailySpoon (déjà réécrit à partir du flux RSS), jamais sur le
 * résultat de cette recherche. Un seul appel par génération (pas par
 * article) : coût marginal (quelques centimes, souvent sous le quota
 * gratuit journalier de Google pour ce type de requête).
 *
 * La date du jour est ANCRÉE explicitement dans le prompt (au format long,
 * heure de Paris) : sans ça, un modèle avec recherche web n'a aucune
 * garantie de savoir quel jour on est réellement (son "aujourd'hui" interne
 * peut être périmé ou ambigu), et peut ramener des résultats de recherche
 * datés de n'importe quand — d'où la consigne explicite de rejeter tout
 * résultat dont la date n'est pas clairement celle du jour indiqué.
 */
async function fetchTrendingTopicsGemini(
  apiKey: string,
  model: string,
  items: CurationItem[],
  usage?: TokenUsage
): Promise<string | null> {
  const categories = [...new Set(items.map((it) => it.category).filter(Boolean))];
  const todayLabel = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date());

  const prompt = `Nous sommes le ${todayLabel} (heure de Paris) — utilise cette date comme référence, pas une autre.

Recherche sur le web les news les plus marquantes/importantes publiées AUJOURD'HUI, ${todayLabel}, UNIQUEMENT — dans le monde et en France, en particulier dans ces domaines : ${categories.join(", ") || "actualité générale"}.

IMPORTANT : ne retiens QUE des actualités dont tu es certain qu'elles datent bien d'aujourd'hui (${todayLabel}). Exclus tout article plus ancien, tout résumé/rétrospective, et tout résultat dont tu n'es pas sûr de la date exacte de publication — dans le doute, ignore-le plutôt que de le citer avec une date incertaine.

Réponds avec une liste courte (8 à 10 items maximum) de sujets factuels en quelques mots chacun (pas de phrase complète), un par ligne, sans numérotation ni commentaire, format :
Sujet 1
Sujet 2
...`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini grounding API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data: any = await res.json();
  addUsage(usage, {
    inputTokens: data?.usageMetadata?.promptTokenCount,
    outputTokens: data?.usageMetadata?.candidatesTokenCount
  });
  const text: string = (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("");
  return text.trim() || null;
}

async function callAnthropicRaw(prompt: string, apiKey: string, model: string, usage?: TokenUsage): Promise<string> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: model as any,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }]
  });
  addUsage(usage, { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens });
  return response.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text as string)
    .join("");
}

async function callGeminiRaw(prompt: string, apiKey: string, model: string, usage?: TokenUsage): Promise<string> {
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
  addUsage(usage, {
    inputTokens: data?.usageMetadata?.promptTokenCount,
    outputTokens: data?.usageMetadata?.candidatesTokenCount
  });
  return (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("");
}

export { DEFAULT_CATEGORIES };
