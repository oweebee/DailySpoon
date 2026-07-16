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
 */
export function ArticleImage({
  src,
  alt,
  dateLabel,
  className
}: {
  src: string;
  alt: string;
  dateLabel?: string | null;
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
        className="h-full w-full border border-ink object-cover grayscale sepia contrast-125"
      />
      {dateLabel && (
        <span
          className="pointer-events-none absolute bottom-2 right-2 rotate-[-9deg] select-none border-[3px] border-[#8a0303] px-2.5 py-1 font-mono text-[0.85rem] font-bold uppercase tracking-wider text-[#8a0303]"
          aria-hidden="true"
        >
          {dateLabel}
        </span>
      )}
    </div>
  );
}
