// Petits utilitaires de fuseau horaire partagés entre la recherche
// (api/articles/search) et la génération d'édition (generateEdition) : JS
// n'a pas d'API native pour construire une date "à minuit dans tel fuseau",
// donc on la déduit de l'écart entre UTC et le fuseau visé au moment donné
// (Intl.DateTimeFormat, seule source fiable côté navigateur/Node pour un nom
// de fuseau IANA comme "Europe/Paris").

/** Décalage (en minutes) du fuseau "timeZone" par rapport à UTC, au moment "date". */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(date);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
  const match = raw.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

/** Instant UTC correspondant à "année-mois-jour 00:00" dans le fuseau donné. */
export function localMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const naiveUtc = Date.UTC(year, month, day);
  const offset = tzOffsetMinutes(new Date(naiveUtc), timeZone);
  return new Date(naiveUtc - offset * 60_000);
}

/**
 * Bornes [début, fin[ du jour calendaire CONTENANT l'instant "at", dans le
 * fuseau donné.
 */
export function dayRangeInTz(at: Date, timeZone: string): { gte: Date; lt: Date } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month") - 1;
  const day = get("day");
  return {
    gte: localMidnightUtc(year, month, day, timeZone),
    lt: localMidnightUtc(year, month, day + 1, timeZone)
  };
}

/**
 * Bornes [début, fin[ du jour calendaire EN COURS dans le fuseau donné,
 * exprimées en instants UTC — ex. pour scoper une requête Prisma sur
 * "publishedAt tombe aujourd'hui, heure de Paris" plutôt que sur le jour
 * UTC (qui décale de 1-2h selon l'heure d'été/hiver par rapport à ce que
 * l'utilisateur voit affiché à l'écran).
 */
export function todayRangeInTz(timeZone: string): { gte: Date; lt: Date } {
  return dayRangeInTz(new Date(), timeZone);
}
