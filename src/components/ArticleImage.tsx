"use client";

import { useState } from "react";

/**
 * Illustration pulled from the source feed, rendered noir/sépia to match
 * the vintage newsprint look — desaturated and slightly warmed like an old
 * halftone print. Hides itself if the image fails to load instead of
 * showing a broken-image icon.
 *
 * Chargée via /api/image-proxy plutôt que directement depuis le site
 * source : certains sites (TechCrunch, Numerama, ...) bloquent le
 * hotlinking quand la requête vient du navigateur du visiteur (referer non
 * reconnu), mais laissent passer une requête faite par notre serveur. Le
 * proxy récupère l'image côté serveur et la re-sert depuis notre domaine.
 *
 * dateLabel, if given, is stamped on top of the photo like an archival
 * press-photo date stamp: rotated, blood-red, transparent background — just
 * the ink sitting directly over the photo, no solid chip behind it.
 *
 * medal, if true, pins a wax-seal badge on the top-left corner of the photo
 * (feed decorated as "médaillé" in /admin/categories) — vraie image
 * (public/badges/wax-seal.png, fond détouré à partir du visuel fourni par
 * l'utilisateur). Hauteur totale fixée à 71px (= même hauteur que l'ancien
 * badge médaille), largeur automatique (ratio d'origine conservé).
 * Entièrement À L'INTÉRIEUR de la photo (ne la chevauche plus) : 5px de
 * marge avec le bord haut, 5px avec le bord gauche.
 *
 * Repli favicon : certains sites (protégés par Cloudflare ou une protection
 * anti-hotlink un peu trop stricte, ex. Geekzone) bloquent la requête
 * serveur qui va chercher l'image réelle même quand og:image est bien
 * trouvé — un blocage "bot" au niveau du CDN, pas quelque chose qu'un simple
 * en-tête peut contourner de façon fiable. Plutôt que de masquer purement et
 * simplement la photo dans ce cas (régression par rapport à l'ancien
 * comportement, qui affichait au moins le favicon du site), on retente une
 * fois avec le favicon avant d'abandonner.
 */
export function ArticleImage({
  src,
  alt,
  dateLabel,
  medal,
  className
}: {
  src: string;
  alt: string;
  dateLabel?: string | null;
  medal?: boolean;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const [useFaviconFallback, setUseFaviconFallback] = useState(false);
  if (broken) return null;

  let effectiveSrc = src;
  if (useFaviconFallback) {
    try {
      effectiveSrc = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(src).hostname)}&sz=128`;
    } catch {
      setBroken(true);
    }
  }
  const proxiedSrc = `/api/image-proxy?url=${encodeURIComponent(effectiveSrc)}`;

  return (
    <div className={`relative ${className || ""}`}>
      <img
        src={proxiedSrc}
        alt={alt}
        loading="lazy"
        onError={() => {
          if (useFaviconFallback) {
            setBroken(true);
          } else {
            setUseFaviconFallback(true);
          }
        }}
        className="h-full w-full border border-ink object-cover grayscale contrast-125"
      />
      {dateLabel && (
        <span
          className="pointer-events-none absolute bottom-2 right-2 rotate-[-9deg] select-none border-[3px] border-[#8a0303] px-2.5 py-1 font-mono text-[0.85rem] font-bold uppercase tracking-wider text-[#8a0303]"
          aria-hidden="true"
        >
          {dateLabel}
        </span>
      )}
      {medal && (
        <img
          src="/badges/wax-seal.png"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute z-10 select-none"
          style={{ left: "5px", top: "5px", height: "71px", width: "auto" }}
        />
      )}
    </div>
  );
}
