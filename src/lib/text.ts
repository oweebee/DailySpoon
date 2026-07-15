/**
 * FreshRSS's summary/content fields (and some feed titles) are raw HTML
 * straight from the source — paragraphs, links, whole embedded <table>/
 * <img> blocks, and sometimes that markup arrives HTML-entity-encoded
 * (&lt;span&gt;...) rather than literal. Some feeds also hand back content
 * pre-truncated by the publisher mid-tag (e.g. "...<a href=" with no
 * closing ">" at all) — decode + strip in a loop for well-formed tags,
 * then a final pass mops up any dangling, unclosed tag fragments so nothing
 * broken ever reaches the page.
 */
export function stripHtml(html: string): string {
  let text = html;

  for (let i = 0; i < 3; i++) {
    const before = text;
    text = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/<(script|style|table)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    if (text === before) break;
  }

  // Anything still starting with "<" or "</" at this point is a broken,
  // never-closed tag fragment (e.g. a source feed truncated its own
  // content mid-markup) — the well-formed-tag loop above can't match it
  // since there's no closing ">" to find. Strip through to the next "<"
  // (or end of string) rather than leave raw markup visible.
  text = text.replace(/<\/?[a-zA-Z][^<]*/g, " ");

  return text.replace(/\s+/g, " ").trim();
}

/** Heuristic: does this text still contain raw or entity-encoded markup that stripHtml should clean? */
export function looksLikeHtml(text: string | null | undefined): boolean {
  if (!text) return false;
  return /<\s*[a-z][a-z0-9]*[\s>/]/i.test(text) || /&lt;\s*[a-z]/i.test(text);
}

/**
 * Best-effort first <img> src found in raw (possibly entity-encoded) HTML —
 * decodes entities first for the same reason stripHtml does.
 */
export function extractFirstImageSrc(html: string | null | undefined): string | null {
  if (!html) return null;
  const decoded = html
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&amp;/gi, "&");
  const match = decoded.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}
