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
 * medal, if true, pins a war-honor-medal-style badge on the top-left corner
 * of the photo (feed decorated as "médaillé" in /admin/categories) — it
 * overflows slightly outside the photo's bounds, like it's physically
 * clipped/pinned onto it rather than printed on it.
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
  if (broken) return null;

  const proxiedSrc = `/api/image-proxy?url=${encodeURIComponent(src)}`;

  return (
    <div className={`relative ${className || ""}`}>
      <img
        src={proxiedSrc}
        alt={alt}
        loading="lazy"
        onError={() => setBroken(true)}
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
        <div
          className="pointer-events-none absolute -left-3 -top-4 z-10 rotate-[-10deg] select-none"
          aria-hidden="true"
        >
          <WarMedal />
        </div>
      )}
    </div>
  );
}

/**
 * Badge "médaille d'honneur de guerre" : ruban épinglé (rivet + reflet) qui
 * porte un médaillon doré (dégradé + relief) frappé d'une couronne à joyaux
 * rouges. Dessiné en SVG (dégradés + ombre portée) plutôt qu'en CSS plat
 * pour une vraie texture métallique à cette petite taille.
 */
function WarMedal() {
  return (
    <svg viewBox="0 0 60 84" width="42" height="59">
      <defs>
        <radialGradient id="medalGold" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#fff3c4" />
          <stop offset="35%" stopColor="#e8c250" />
          <stop offset="70%" stopColor="#b8860b" />
          <stop offset="100%" stopColor="#7a5a0a" />
        </radialGradient>
        <linearGradient id="ribbonRed" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#a81f1f" />
          <stop offset="50%" stopColor="#7a0f0f" />
          <stop offset="100%" stopColor="#5c0808" />
        </linearGradient>
        <filter id="medalShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="1.5" dy="2.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.55" />
        </filter>
      </defs>

      <g filter="url(#medalShadow)">
        {/* Ruban, centré sur l'axe du médaillon (x=30) */}
        <path d="M22,4 L38,4 L38,40 L30,32 L22,40 Z" fill="url(#ribbonRed)" stroke="#3d0505" strokeWidth="0.75" />
        <path d="M22,4 L38,4 L38,9 L22,9 Z" fill="#c9a227" opacity="0.85" />
        <circle cx="30" cy="6" r="3.2" fill="#d9d9d9" stroke="#4a4a4a" strokeWidth="0.6" />
        <circle cx="29" cy="5" r="1" fill="#fff" opacity="0.8" />

        {/* Médaillon */}
        <circle cx="30" cy="56" r="21" fill="url(#medalGold)" stroke="#6b4e0a" strokeWidth="2" />
        <circle cx="30" cy="56" r="16.5" fill="none" stroke="#6b4e0a" strokeWidth="1" opacity="0.7" />
        <circle cx="30" cy="56" r="16.5" fill="none" stroke="#fff3c4" strokeWidth="0.6" opacity="0.5" />

        {/* Couronne centrale, en léger relief, joyaux rouges assortis au ruban */}
        <path
          d="M16,60 L44,60 L44,52 L37,57 L30,44 L23,57 L16,52 Z"
          fill="#7a5a0a"
          stroke="#4d3a06"
          strokeWidth="0.5"
        />
        <rect x="16" y="60" width="28" height="5" rx="0.8" fill="#7a5a0a" stroke="#4d3a06" strokeWidth="0.5" />
        <path d="M16,60 L44,60 L44,52 L37,57 L30,44" fill="none" stroke="#e8c250" strokeWidth="0.6" opacity="0.6" />
        <circle cx="16" cy="52" r="1.8" fill="#8a0303" stroke="#4d3a06" strokeWidth="0.4" />
        <circle cx="30" cy="44" r="2.1" fill="#8a0303" stroke="#4d3a06" strokeWidth="0.4" />
        <circle cx="44" cy="52" r="1.8" fill="#8a0303" stroke="#4d3a06" strokeWidth="0.4" />
      </g>
    </svg>
  );
}
