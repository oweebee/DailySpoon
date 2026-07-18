import { prisma } from "./prisma";
import { getSettings } from "./settings";

/**
 * Journal technique persistant (/admin/logs) — voir schema.prisma (LogEntry)
 * pour le pourquoi. writeLog() ne doit JAMAIS faire planter l'appelant : un
 * souci d'écriture en base (migration pas encore appliquée, DB
 * momentanément indisponible...) ne doit jamais empêcher la vraie opération
 * en cours (récupération de flux, génération d'édition...) de continuer —
 * seulement console.error en secours dans ce cas précis.
 *
 * Reste volontairement "best effort" et synchrone-fire-and-forget côté
 * appelant (pas de await obligatoire) : logger un événement ne doit jamais
 * ralentir le chemin critique qu'il décrit.
 */
export type LogLevel = "info" | "warn" | "error";

export async function writeLog(
  level: LogLevel,
  source: string,
  message: string,
  detail?: string | null
): Promise<void> {
  // Toujours visible dans les logs bruts du conteneur (Coolify) en plus de
  // la persistance en base — comportement historique conservé.
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[${source}] ${message}`, detail || "");

  try {
    await prisma.logEntry.create({
      data: {
        level,
        source,
        message: message.slice(0, 2000),
        // Plafonné : un detail issu d'une exception (stack trace complète,
        // corps de réponse HTTP...) peut être bien plus long que nécessaire
        // pour diagnostiquer — voir /admin/logs qui n'affiche de toute façon
        // qu'un aperçu repliable.
        detail: detail ? detail.slice(0, 5000) : null
      }
    });
  } catch (err) {
    // Ne PAS relancer : voir le commentaire en tête de fichier. Le message
    // le plus probable ici est "table LogEntry does not exist" tant que la
    // migration 20260718190000_log_entry n'a pas encore tourné.
    console.error("[logger] Échec de l'écriture du journal (migration appliquée ?) :", (err as Error)?.message);
  }
}

// Options proposées dans /admin/logs pour la rétention — mêmes valeurs que
// demandées explicitement (1h/1j/1semaine/1mois), plus "illimité" (0), par
// cohérence avec le pattern déjà utilisé pour retentionDays.
export const LOG_RETENTION_OPTIONS = [
  { value: 60, label: "1 heure" },
  { value: 1440, label: "1 jour" },
  { value: 10080, label: "1 semaine" },
  { value: 43200, label: "1 mois" },
  { value: 0, label: "Illimité" }
];

/**
 * Purge les entrées plus vieilles que Settings.logRetentionMinutes. Appelée
 * à chaque tick du worker (voir worker/index.ts) — un simple DELETE indexé
 * sur createdAt, négligeable même appelé chaque minute (la plupart du temps
 * aucune ligne à supprimer). 0/valeur absente = illimité, ne purge rien.
 */
export async function pruneOldLogs(): Promise<void> {
  try {
    const { logRetentionMinutes } = await getSettings();
    if (!logRetentionMinutes || logRetentionMinutes <= 0) return;

    const cutoff = new Date(Date.now() - logRetentionMinutes * 60_000);
    await prisma.logEntry.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (err) {
    console.error("[logger] Échec de la purge du journal :", (err as Error)?.message);
  }
}
