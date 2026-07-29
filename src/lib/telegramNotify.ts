import fs from "fs";
import path from "path";
import { getSettings } from "./settings";
import { writeLog } from "./logger";
import { isPlaceholderImage, isLikelyLogoImage, isRelativeImageUrl } from "./text";

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

// Mêmes heuristiques que le rattrapage d'illustration de generateEdition.ts
// (favicon Google posé en dernier recours, bouche-trou de lazy-load, logo de
// marque/pub, chemin relatif cassé) : sans ce filtre, Telegram aurait fini
// par recevoir un favicon générique ou un logo publicitaire comme si
// c'était la vraie photo de l'article.
function isUsableArticleImage(url: string | null | undefined): boolean {
  if (!url) return false;
  const u = url.trim();
  if (!u) return false;
  if (u.includes("google.com/s2/favicons")) return false;
  if (isRelativeImageUrl(u)) return false;
  if (isPlaceholderImage(u)) return false;
  if (isLikelyLogoImage(u)) return false;
  return true;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Échappement spécifique à l'intérieur d'un attribut HTML entre guillemets
// doubles (href="...") — seuls & et " doivent être neutralisés ici (pas
// < > : ce ne sont pas des délimiteurs d'attribut), sinon un & littéral dans
// l'URL (query string) ou un " cassent l'attribut aux yeux du parseur
// Telegram.
function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export type TelegramNotifyItem = {
  title: string;
  excerpt?: string | null;
  link: string;
  /** Nom du flux source (ex. "Korben") — affiché comme texte cliquable vers
   *  l'article, à la place de l'URL brute en fin de légende. */
  source: string;
  /** Image de l'article (og:image, illustration extraite du contenu, ou
   *  favicon en dernier recours côté generateEdition.ts) — si absente ou
   *  jugée inexploitable (favicon/placeholder/logo, voir isUsableArticleImage
   *  ci-dessus), on retombe sur la bannière fixe telegram-notify.png. */
  imageUrl?: string | null;
};

/**
 * Construit la légende HTML envoyée avec la photo, dans le même format que
 * le workflow n8n "👼🏾 News - Telegram" pris comme référence :
 * <blockquote>⚠ titre</blockquote> puis un extrait, puis un lien cliquable
 * (le nom du flux, pas l'URL brute) vers l'article. Exporté séparément de
 * l'envoi pour être réutilisé par le bouton de test manuel
 * (/api/admin/settings/test-telegram-notify), qui doit produire EXACTEMENT
 * le même rendu que l'envoi automatique.
 */
export function buildTelegramCaption(item: TelegramNotifyItem): string {
  const title = escapeHtml(item.title || "");
  const source = escapeHtml(item.source || "Lire l'article");
  const href = escapeHtmlAttr(item.link);
  // Budget calculé sur le texte VISIBLE (Telegram compte le texte rendu, pas
  // la balise <a href> autour) — le nom du flux, court, remplace l'URL brute
  // qui pesait potentiellement bien plus lourd dans l'ancien calcul.
  let excerpt = escapeHtml((item.excerpt || "").trim());
  const budget = MAX_CAPTION_CHARS - title.length - source.length - 40;
  if (excerpt.length > Math.max(0, budget)) {
    excerpt = excerpt.slice(0, Math.max(0, budget)).trim() + "…";
  }
  return `<blockquote>⚠ ${title}</blockquote>\n${excerpt}\n\n<a href="${href}">${source}</a>`;
}

export type TelegramSendResult = { ok: boolean; message: string };

/**
 * Poste la photo + la légende sur Telegram. Prend le jeton/l'id de chat en
 * paramètres explicites (plutôt que de relire les réglages enregistrés) pour
 * pouvoir aussi bien servir l'envoi automatique (valeurs de la base) que le
 * bouton de test manuel dans /admin/settings (valeurs tapées dans le
 * formulaire, pas forcément encore enregistrées).
 *
 * Si `imageUrl` est fournie ET jugée exploitable (voir isUsableArticleImage),
 * elle est envoyée telle quelle en URL publique (Telegram la télécharge
 * lui-même côté serveur — pas de proxy/téléchargement ici). Sinon, repli sur
 * la bannière fixe telegram-notify.png envoyée en pièce jointe, comme avant
 * cette fonctionnalité — un article sans image utilisable (cas fréquent :
 * favicon générique, logo pub) ne doit jamais afficher une vignette cassée.
 */
export async function postTelegramPhoto(
  botToken: string,
  chatId: string,
  caption: string,
  imageUrl?: string | null
): Promise<TelegramSendResult> {
  const sendWithFixedBanner = async (): Promise<TelegramSendResult> => {
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
      const photo = fs.readFileSync(TELEGRAM_PHOTO_PATH);
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
  };

  if (!isUsableArticleImage(imageUrl)) {
    return sendWithFixedBanner();
  }

  // Image de l'article envoyée en URL publique (Telegram la télécharge
  // lui-même). Si Telegram échoue à la récupérer (site source qui bloque son
  // user-agent, image entre-temps supprimée, etc.), on retente aussitôt avec
  // la bannière fixe plutôt que de laisser la notification échouer
  // silencieusement — l'utilisateur préfère une bannière générique à aucune
  // notification.
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("photo", imageUrl as string);

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      body: form
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return sendWithFixedBanner();
    }
    return { ok: true, message: "Envoyé." };
  } catch {
    return sendWithFixedBanner();
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
  const result = await postTelegramPhoto(settings.telegramBotToken, settings.telegramChatId, caption, item.imageUrl);
  if (!result.ok) {
    await writeLog("warn", "telegram", `Échec envoi notification Telegram : ${result.message}`, item.link);
  }
}
