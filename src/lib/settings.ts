import { prisma } from "./prisma";

const SINGLETON_ID = "singleton";

export type AppSettings = {
  freshrssBaseUrl: string;
  freshrssUsername: string;
  freshrssApiPassword: string;
  anthropicApiKey: string;
  anthropicModel: string;
  editionHour: number;
  editionMinute: number;
  editionTz: string;
  /** Rétention de l'historique en jours. 0 = illimité (jamais purgé). */
  retentionDays: number;
  /** false = génération auto quotidienne (worker) désactivée — dans ce cas
   *  la page d'accueil affiche un bouton pour lancer l'impression à la main. */
  editionScheduleEnabled: boolean;
};

/**
 * Effective settings: whatever's saved in the DB (via /admin/settings) wins;
 * an empty/unset field falls back to the matching environment variable.
 * This lets the app run purely off env vars on first deploy, while every
 * value can be changed later from the admin UI without a redeploy.
 */
export async function getSettings(): Promise<AppSettings> {
  const row = await prisma.settings.findUnique({ where: { id: SINGLETON_ID } });

  return {
    freshrssBaseUrl: row?.freshrssBaseUrl || process.env.FRESHRSS_BASE_URL || "",
    freshrssUsername: row?.freshrssUsername || process.env.FRESHRSS_USERNAME || "",
    freshrssApiPassword: row?.freshrssApiPassword || process.env.FRESHRSS_API_PASSWORD || "",
    anthropicApiKey: row?.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
    anthropicModel: row?.anthropicModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    editionHour: row?.editionHour ?? Number(process.env.EDITION_HOUR ?? 6),
    editionMinute: row?.editionMinute ?? Number(process.env.EDITION_MINUTE ?? 0),
    editionTz: row?.editionTz || process.env.EDITION_TZ || "Europe/Paris",
    retentionDays: row?.retentionDays ?? Number(process.env.RETENTION_DAYS ?? 730),
    editionScheduleEnabled:
      row?.editionScheduleEnabled ?? process.env.EDITION_SCHEDULE_ENABLED !== "false"
  };
}

const STRING_FIELDS = [
  "freshrssBaseUrl",
  "freshrssUsername",
  "freshrssApiPassword",
  "anthropicApiKey",
  "anthropicModel",
  "editionTz"
] as const;

export type SettingsInput = Partial<{
  freshrssBaseUrl: string | null;
  freshrssUsername: string | null;
  freshrssApiPassword: string | null;
  anthropicApiKey: string | null;
  anthropicModel: string | null;
  editionHour: number | null;
  editionMinute: number | null;
  editionTz: string | null;
  retentionDays: number | null;
  editionScheduleEnabled: boolean | null;
}>;

/**
 * Save settings from the admin UI. An empty string (or null) is stored as
 * null so getSettings() falls back to the environment variable again if the
 * user clears a field.
 */
export async function updateSettings(input: SettingsInput): Promise<void> {
  const data: Record<string, unknown> = {};

  for (const key of STRING_FIELDS) {
    if (key in input) {
      const value = (input as Record<string, unknown>)[key];
      data[key] = typeof value === "string" && value.trim() === "" ? null : value;
    }
  }

  if ("editionHour" in input) {
    const v = input.editionHour;
    data.editionHour = v === null || v === undefined || Number.isNaN(v) ? null : v;
  }
  if ("editionMinute" in input) {
    const v = input.editionMinute;
    data.editionMinute = v === null || v === undefined || Number.isNaN(v) ? null : v;
  }
  if ("retentionDays" in input) {
    // 0 est une valeur volontaire ("illimité"), à bien distinguer de
    // null/undefined (pas réglé -> retombe sur la valeur par défaut).
    const v = input.retentionDays;
    data.retentionDays = v === null || v === undefined || Number.isNaN(v) ? null : v;
  }
  if ("editionScheduleEnabled" in input) {
    // false est une valeur volontaire (désactivé) — à bien distinguer de
    // null/undefined (pas réglé -> retombe sur activé par défaut).
    data.editionScheduleEnabled = input.editionScheduleEnabled === false ? false : input.editionScheduleEnabled;
  }

  await prisma.settings.upsert({
    where: { id: SINGLETON_ID },
    update: data,
    create: { id: SINGLETON_ID, ...data }
  });
}
