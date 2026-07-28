import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { MORSS_BASE_URL } from "@/lib/settings";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

/**
 * Test manuel de scraping morss depuis /admin/settings (bouton "Tester dans
 * un nouvel onglet", section juste au-dessus du VPN) — reproduit EXACTEMENT
 * ce que fait le fallback automatique en production (voir morssUrlFor dans
 * customFeeds.ts) : même construction d'URL, même instance morss interne.
 * Sert à vérifier le rendu AVANT d'aller coller l'URL dans un flux perso
 * (/admin/categories), plutôt que de le découvrir après coup via
 * lastFetchError. Le navigateur admin ne peut pas appeler morss directement
 * (nom "morss" uniquement valable sur le réseau Docker interne, voir
 * vpn-status/route.ts) — cette route sert donc de relais côté serveur, et
 * renvoie le corps de la réponse TEL QUEL (même statut, contenu texte non
 * modifié) pour que la nouvelle fenêtre affiche exactement ce que morss a
 * produit, erreurs comprises.
 *
 * Content-Type TOUJOURS forcé à text/plain, jamais celui renvoyé par morss
 * (souvent text/xml pour un flux) : un navigateur qui reçoit du text/xml
 * essaie d'appliquer SON PROPRE visualisateur de flux natif (feuille de
 * style XSLT intégrée, ex. Firefox) — ce moteur plante facilement
 * ("Échec de l'analyse d'une feuille de style XSLT") sur des flux par
 * ailleurs parfaitement valides, ce qui n'a RIEN à voir avec la qualité du
 * flux morss lui-même. En texte brut, le contenu s'affiche tel quel dans
 * n'importe quel navigateur, sans dépendre d'un moteur XML tiers.
 */
export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = req.nextUrl.searchParams.get("url")?.trim();
  if (!url) return NextResponse.json({ error: "Paramètre url manquant" }, { status: 400 });

  const morssUrl = `${MORSS_BASE_URL}/${url.replace(/^https?:\/\//, "")}`;

  try {
    const res = await fetch(morssUrl, { signal: AbortSignal.timeout(45000) });
    const body = await res.text();
    return new NextResponse(body, { status: res.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err) {
    return NextResponse.json(
      { error: `Échec de la requête vers morss : ${(err as Error)?.message || "raison inconnue"}` },
      { status: 502 }
    );
  }
}
