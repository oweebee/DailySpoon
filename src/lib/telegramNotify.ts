import fs from "fs";
import path from "path";
import { getSettings } from "./settings";
import { writeLog } from "./logger";

// Image fixe envoyée avec CHAQUE notification (voir public/telegram-notify.png,
// fournie par l'utilisateur) — reproduit le layout du workflow n8n de
// référence ("👼🏾 News - Telegram") : une photo + une légende HTML, plutôt
// qu'un message texte brut. Contrairement à n8n (une image différente par
// flux, hébergée sur Nextcloud), on utilise ICI une seule image pour tous les
// flux, envoyée en pièce jointe directement (pas besoin d'URL publique).
const TELEGRAM_PHOTO_PATH = path.join(process.cwd(), "public", "telegram-notify.png");

// Legende Telegram plafonnée à 1024 caractères par l'API sendPhoto (bien plus
// court que les 4096 d'un message texte classique) — on garde une marge de
// sécurité pour le titre/lien qui encadrent l'extrait.
const MAX_CAPTION_CHARS = 900;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type TelegramNotifyItem = {
  title: string;
  excerpt?: string | null;
  link: string;
};

/**
 * Construit la légende HTML envoyée avec la photo, dans le même format que
 * le workflow n8n "👼🏾 News - Telegram" pris comme référence :
 * <blockquote>⚠ titre</blockquote> puis un extrait, puis le lien. Exporté
 * séparément de l'envoi pour être réutilisé par le bouton de test manuel
 * (/api/admin/settings/test-telegram-notify), qui doit produire EXACTEMENT
 * le même rendu que l'envoi automatique.
 */
export function buildTelegramCaption(item: TelegramNotifyItem): string {
  const title = escapeHtml(item.title || "");
  let excerpt = escapeHtml((item.excerpt || "").trim());
  const budget = MAX_CAPTION_CHARS - title.length - item.link.length - 40;
  if (excerpt.length > Math.max(0, budget)) {
    excerpt = excerpt.slice(0, Math.max(0, budget)).trim() + "…";
  }
  return `<blockquote>⚠ ${title}</blockquote>\n${excerpt}\n\n${item.link}`;
}

export type TelegramSendResult = { ok: boolean; message: string };

/**
 * Poste réellement la photo fixe + la légende sur Telegram. Prend le jeton/
 * l'id de chat en paramètres explicites (plutôt que de relire les réglages
 * enregistrés) pour pouvoir aussi bien servir l'envoi automatique (valeurs de
 * la base) que le bouton de test manuel dans /admin/settings (valeurs tapées
 * dans le formulaire, pas forcément encore enregistrées).
 */
export async function postTelegramPhoto(
  botToken: string,
  chatId: string,
  caption: string
): Promise<TelegramSendResult> {
  try {
    const photo = fs.readFileSync(TELEGRAM_PHOTO_PATH);
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("photo", new Blob([photo]), "telegram-notify.png");

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      body: form
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, message: data?.description || `Échec (${res.status})` };
    }
    return { ok: true, message: "Envoyé." };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message || "Erreur réseau." };
  }
}

/**
 * Pousse une notification Telegram "photo + légende" pour un nouvel article,
 * en utilisant les réglages enregistrés (voir Settings.telegramBotToken/
 * ChatId). Ne fait rien (silencieusement) si le bot n'est pas configuré —
 * appelant (ingestRawItems) déjà responsable de ne déclencher l'appel QUE
 * pour les flux cochés "notification" (NotifyFeed).
 */
export async function sendTelegramNotification(item: TelegramNotifyItem): Promise<void> {
  const settings = await getSettings();
  if (!settings.telegramBotToken || !settings.telegramChatId) return;

  const caption = buildTelegramCaption(item);
  const result = await postTelegramPhoto(settings.telegramBotToken, settings.telegramChatId, caption);
  if (!result.ok) {
    await writeLog("warn", "telegram", `Échec envoi notification Telegram : ${result.message}`, item.link);
  }
}
