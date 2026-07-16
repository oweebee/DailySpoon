"use client";

import { useState } from "react";

/**
 * Illustration pulled from the source feed, rendered noir/sépia to match
 * the vintage newsprint look — desaturated and slightly warmed like an old
 * halftone print. Hides itself if the image fails to load (hotlink
 * blocked, dead link, etc.) instead of showing a broken-image icon.
 *
 * dateLabel, if given, is stamped on top of the photo like an archival
 * press-photo date stamp: rotated, ink-red, with a solid paper-colored chip
 * behind it so it stays readable over ANY photo — including dark/black
 * backgrounds, where a blend-mode stamp would disappear entirely.
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

  return (
    <div className={`relative ${className || ""}`}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="h-full w-full border border-ink object-cover grayscale sepia contrast-125"
      />
      {dateLabel && (
        <span
          className="pointer-events-none absolute bottom-2 right-2 rotate-[-9deg] select-none border-[3px] border-[#c81e1e] bg-paper px-2.5 py-1 font-mono text-[0.85rem] font-bold uppercase tracking-wider text-[#c81e1e] shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
          aria-hidden="true"
        >
          {dateLabel}
        </span>
      )}
    </div>
  );
}
