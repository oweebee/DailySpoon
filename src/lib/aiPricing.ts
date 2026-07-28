/**
 * Estimation du coût d'une génération, à partir des tokens réellement
 * consommés (remontés par les réponses API — voir ai.ts) et d'une table de
 * tarifs approximative. PAS une facture exacte : les tarifs officiels
 * peuvent changer sans qu'on redéploie, et le nom de modèle réglé dans
 * /admin/settings (anthropicModel / geminiModel, champ libre) est reconnu
 * par simple correspondance de sous-chaîne plutôt qu'une liste figée de
 * versions exactes — largement suffisant pour un ordre de grandeur affiché
 * dans les statistiques admin, pas pour un usage comptable.
 *
 * Tarifs (USD par million de tokens, entrée/sortie) relevés en juillet 2026 :
 * - Claude Sonnet 5 : tarif promo 2 $/10 $ jusqu'au 31/08/2026, puis 3 $/15 $
 * - Claude Haiku 4.5 : 1 $/5 $
 * - Claude Opus 4.8 : 5 $/25 $
 * - Claude Fable 5 : 10 $/50 $
 * - Gemini 3.5 Flash : 1,50 $/9 $
 * - Gemini 3.1 Pro : 2 $/12 $ (palier de base)
 * - Gemini Flash-Lite (2.5/3.x) : 0,10 $/0,40 $
 */
type Rate = { inputPerM: number; outputPerM: number };

const ANTHROPIC_RATES: { match: RegExp; rate: Rate }[] = [
  { match: /opus/i, rate: { inputPerM: 5, outputPerM: 25 } },
  { match: /haiku/i, rate: { inputPerM: 1, outputPerM: 5 } },
  { match: /fable/i, rate: { inputPerM: 10, outputPerM: 50 } },
  { match: /sonnet/i, rate: { inputPerM: 2, outputPerM: 10 } } // tarif promo en cours
];
const ANTHROPIC_DEFAULT: Rate = { inputPerM: 3, outputPerM: 15 }; // repli type "Sonnet"

const GEMINI_RATES: { match: RegExp; rate: Rate }[] = [
  { match: /flash-lite/i, rate: { inputPerM: 0.1, outputPerM: 0.4 } },
  { match: /flash/i, rate: { inputPerM: 1.5, outputPerM: 9 } },
  { match: /pro/i, rate: { inputPerM: 2, outputPerM: 12 } }
];
const GEMINI_DEFAULT: Rate = { inputPerM: 1.5, outputPerM: 9 }; // repli type "Flash"

function findRate(model: string, table: { match: RegExp; rate: Rate }[], fallback: Rate): Rate {
  for (const entry of table) {
    if (entry.match.test(model)) return entry.rate;
  }
  return fallback;
}

/** Coût estimé en USD pour un nombre de tokens donné, sur le modèle réglé. */
export function estimateCostUsd(
  provider: "anthropic" | "gemini",
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const rate =
    provider === "gemini"
      ? findRate(model || "", GEMINI_RATES, GEMINI_DEFAULT)
      : findRate(model || "", ANTHROPIC_RATES, ANTHROPIC_DEFAULT);
  return (inputTokens / 1_000_000) * rate.inputPerM + (outputTokens / 1_000_000) * rate.outputPerM;
}

// Taux de change approximatif, fixé en dur — suffisant pour un ordre de
// grandeur affiché dans les statistiques admin (le coût lui-même n'est déjà
// qu'une estimation), pas la peine d'appeler une API de change en plus.
const USD_TO_EUR = 0.92;

export function usdToEur(usd: number): number {
  return usd * USD_TO_EUR;
}
