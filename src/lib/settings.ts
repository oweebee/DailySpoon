import { prisma } from "./prisma";

const SINGLETON_ID = "singleton";

/**
 * Adresse interne de morss, intégré comme service du même docker-compose que
 * DailySpoon (nom de service "morss", port 8000, voir docker-compose.yml) —
 * cette adresse ne dépend donc jamais du serveur où l'app est déployée, pas
 * besoin d'en faire un réglage configurable depuis /admin/settings.
 */
export const MORSS_BASE_URL = "http://morss:8000";

export type AppSettings = {
  freshrssBaseUrl: string;
  freshrssUsername: string;
  freshrssApiPassword: string;
  /** false par défaut (interrupteur décoché) : tant que ce n'est pas
   *  explicitement activé dans /admin/settings, FreshRSS est traité comme
   *  non configuré, même si l'URL/identifiant/mot de passe sont renseignés
   *  (en base OU via les variables d'environnement FRESHRSS_*) — voir
   *  config() dans freshrss.ts. Contrairement aux autres champs FreshRSS
   *  ci-dessus, PAS de repli sur une variable d'environnement pour ce champ :
   *  on veut que ce soit un choix explicite fait depuis l'admin, jamais
   *  réactivé tout seul par un redeploy. */
  freshrssEnabled: boolean;
  anthropicApiKey: string;
  anthropicModel: string;
  /** "anthropic" (défaut) ou "gemini" — fournisseur IA utilisé pour la
   *  réécriture/résumé/priorisation. Sans effet sur /direct, qui reste
   *  toujours sans IA quel que soit ce réglage. */
  aiProvider: string;
  geminiApiKey: string;
  geminiModel: string;
  editionHour: number;
  editionMinute: number;
  editionTz: string;
  /** Rétention de l'historique en jours. 0 = illimité (jamais purgé). */
  retentionDays: number;
  /** false = génération auto quotidienne (worker) désactivée — dans ce cas
   *  la page d'accueil affiche un bouton pour lancer l'impression à la main. */
  editionScheduleEnabled: boolean;
  /** Style d'écriture appliqué par l'IA lors de la réécriture/résumé des
   *  articles : "normal" (défaut, ton journalistique neutre) ou "ackboo"
   *  (ton sarcastique/passif-agressif façon Ackboo, Canard PC). Sans effet
   *  sur /direct, toujours sans IA quel que soit ce réglage. */
  writingStyle: string;
  /** Intervalle GLOBAL (minutes) de récupération des flux RSS personnalisés
   *  (voir CustomFeed/src/lib/customFeeds.ts) — un seul réglage pour tous
   *  les flux personnalisés confondus, pas par flux/catégorie. Défaut :
   *  60 minutes. */
  customFeedsIntervalMinutes: number;
  /** Rétention (minutes) du journal technique (/admin/logs, LogEntry). 0 =
   *  illimité. Défaut : 1440 (1 jour) — voir src/lib/logger.ts. */
  logRetentionMinutes: number;
  /** Jeton du bot Telegram (@BotFather) et id du chat/canal de destination —
   *  utilisés à la fois pour tester la connexion depuis /admin/settings, et
   *  pour l'envoi effectif des notifications "photo + légende" (flux cochés
   *  notification, voir NotifyFeed et src/lib/telegramNotify.ts). */
  telegramBotToken: string;
  telegramChatId: string;
  /** URL de l'instance LibreTranslate auto-hébergée (conteneur déployé
   *  séparément, voir libretranslate/docker-compose.yml) — SEUL moteur de
   *  traduction des vignettes "En direct" (flux cochés "traduction" dans
   *  /admin/categories). Aucun quota, aucune limite de longueur, aucune
   *  donnée qui sort du serveur. Vide = aucune traduction, les articles
   *  restent dans leur langue d'origine. */
  libretranslateUrl: string;
  /** Clé d'accès à l'instance LibreTranslate, si elle est protégée
   *  (LT_REQUIRE_API_KEY côté conteneur). À renseigner impérativement quand
   *  l'instance est jointe par un domaine public : sans clé, elle est
   *  utilisable par n'importe qui, aux frais de ton serveur. Vide = aucune
   *  clé envoyée. */
  libretranslateApiKey: string;
  /** Intégration Wallabag : mettre un article en favori envoie son lien à
   *  Wallabag pour archivage (voir src/lib/wallabagSend.ts). Wallabag n'a pas
   *  de simple clé API — il exige un flux OAuth2 "password grant", d'où ces 5
   *  champs. wallabagBaseUrl vide (ou l'un des identifiants manquant) =
   *  intégration inactive, le favori ne fait rien de plus qu'avant. */
  wallabagBaseUrl: string;
  wallabagClientId: string;
  wallabagClientSecret: string;
  wallabagUsername: string;
  wallabagPassword: string;
  /** Mot de passe dédié à l'API Google Reader (lecteur externe type Readrops,
   *  voir src/lib/greader.ts). Vide = le ClientLogin accepte le mot de passe
   *  admin (rétrocompat). À privilégier en lettres/chiffres pour éviter les
   *  soucis d'encodage form-urlencoded d'un mot de passe admin complexe. */
  greaderApiPassword: string;
  /** Module VPN optionnel pour le conteneur morss intégré (voir
   *  docker-compose "morss" + morss/entrypoint.sh) : quand activé, morss
   *  route SA PROPRE sortie réseau (pas DailySpoon web/worker) via un tunnel
   *  OpenVPN construit depuis vpnOvpnConfig. Interrupteur explicite, false
   *  par défaut, même logique que freshrssEnabled — jamais activé tout
   *  seul. Nécessite un redémarrage du conteneur morss pour prendre effet
   *  (lu une seule fois au démarrage via /api/internal/vpn-config). */
  vpnEnabled: boolean;
  /** Contenu brut du fichier .ovpn (identifiants/certificats inclus) collé
   *  depuis /admin/settings — vide = pas de VPN configuré, même si
   *  vpnEnabled est coché. */
  vpnOvpnConfig: string;
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
    freshrssEnabled: row?.freshrssEnabled === true,
    anthropicApiKey: row?.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
    anthropicModel: row?.anthropicModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    aiProvider: row?.aiProvider || process.env.AI_PROVIDER || "anthropic",
    geminiApiKey: row?.geminiApiKey || process.env.GEMINI_API_KEY || "",
    geminiModel: row?.geminiModel || process.env.GEMINI_MODEL || "gemini-3.5-flash",
    editionHour: row?.editionHour ?? Number(process.env.EDITION_HOUR ?? 6),
    editionMinute: row?.editionMinute ?? Number(process.env.EDITION_MINUTE ?? 0),
    editionTz: row?.editionTz || process.env.EDITION_TZ || "Europe/Paris",
    retentionDays: row?.retentionDays ?? Number(process.env.RETENTION_DAYS ?? 730),
    editionScheduleEnabled:
      row?.editionScheduleEnabled ?? process.env.EDITION_SCHEDULE_ENABLED !== "false",
    writingStyle: row?.writingStyle || process.env.WRITING_STYLE || "normal",
    customFeedsIntervalMinutes: row?.customFeedsIntervalMinutes ?? 60,
    logRetentionMinutes: row?.logRetentionMinutes ?? 1440,
    telegramBotToken: row?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: row?.telegramChatId || process.env.TELEGRAM_CHAT_ID || "",
    // "/" final retiré (comme wallabagBaseUrl) pour construire proprement
    // "<url>/translate" ensuite, sans double slash.
    libretranslateUrl: (row?.libretranslateUrl || process.env.LIBRETRANSLATE_URL || "").replace(/\/+$/, ""),
    libretranslateApiKey: row?.libretranslateApiKey || process.env.LIBRETRANSLATE_API_KEY || "",
    // On retire un éventuel "/" final de l'URL de l'instance (comme morssBaseUrl)
    // pour construire proprement les chemins ensuite (voir wallabagSend.ts).
    wallabagBaseUrl: (row?.wallabagBaseUrl || process.env.WALLABAG_BASE_URL || "").replace(/\/+$/, ""),
    wallabagClientId: row?.wallabagClientId || process.env.WALLABAG_CLIENT_ID || "",
    wallabagClientSecret: row?.wallabagClientSecret || process.env.WALLABAG_CLIENT_SECRET || "",
    wallabagUsername: row?.wallabagUsername || process.env.WALLABAG_USERNAME || "",
    wallabagPassword: row?.wallabagPassword || process.env.WALLABAG_PASSWORD || "",
    greaderApiPassword: row?.greaderApiPassword || process.env.GREADER_API_PASSWORD || "",
    vpnEnabled: row?.vpnEnabled === true,
    vpnOvpnConfig: row?.vpnOvpnConfig || ""
  };
}

const STRING_FIELDS = [
  "freshrssBaseUrl",
  "freshrssUsername",
  "freshrssApiPassword",
  "anthropicApiKey",
  "anthropicModel",
  "aiProvider",
  "geminiApiKey",
  "geminiModel",
  "editionTz",
  "writingStyle",
  "telegramBotToken",
  "telegramChatId",
  "libretranslateUrl",
  "libretranslateApiKey",
  "wallabagBaseUrl",
  "wallabagClientId",
  "wallabagClientSecret",
  "wallabagUsername",
  "wallabagPassword",
  "greaderApiPassword",
  "vpnOvpnConfig"
] as const;

export type SettingsInput = Partial<{
  freshrssBaseUrl: string | null;
  freshrssUsername: string | null;
  freshrssApiPassword: string | null;
  freshrssEnabled: boolean | null;
  anthropicApiKey: string | null;
  anthropicModel: string | null;
  aiProvider: string | null;
  geminiApiKey: string | null;
  geminiModel: string | null;
  editionHour: number | null;
  editionMinute: number | null;
  editionTz: string | null;
  retentionDays: number | null;
  editionScheduleEnabled: boolean | null;
  writingStyle: string | null;
  customFeedsIntervalMinutes: number | null;
  logRetentionMinutes: number | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  libretranslateUrl: string | null;
  libretranslateApiKey: string | null;
  wallabagBaseUrl: string | null;
  wallabagClientId: string | null;
  wallabagClientSecret: string | null;
  wallabagUsername: string | null;
  wallabagPassword: string | null;
  greaderApiPassword: string | null;
  vpnEnabled: boolean | null;
  vpnOvpnConfig: string | null;
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
  if ("freshrssEnabled" in input) {
    // Ici c'est l'inverse d'editionScheduleEnabled : "true" est la valeur
    // volontaire explicite (activé), tout le reste (false/null/undefined)
    // reste/redevient "non activé" — voir le commentaire sur AppSettings
    // ci-dessus.
    data.freshrssEnabled = input.freshrssEnabled === true;
  }
  if ("customFeedsIntervalMinutes" in input) {
    const v = input.customFeedsIntervalMinutes;
    data.customFeedsIntervalMinutes = v === null || v === undefined || Number.isNaN(v) ? null : v;
  }
  if ("vpnEnabled" in input) {
    // Même logique que freshrssEnabled : "true" est la valeur volontaire
    // explicite, tout le reste (false/null/undefined) reste/redevient
    // "non activé".
    data.vpnEnabled = input.vpnEnabled === true;
  }
  if ("logRetentionMinutes" in input) {
    // 0 est une valeur volontaire ("illimité"), à bien distinguer de
    // null/undefined (pas réglé -> retombe sur le défaut, 1 jour).
    const v = input.logRetentionMinutes;
    data.logRetentionMinutes = v === null || v === undefined || Number.isNaN(v) ? null : v;
  }

  await prisma.settings.upsert({
    where: { id: SINGLETON_ID },
    update: data,
    create: { id: SINGLETON_ID, ...data }
  });
}
