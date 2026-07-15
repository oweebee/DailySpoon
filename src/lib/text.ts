/**
 * FreshRSS's summary/content fields (and some feed titles) are raw HTML
 * straight from the source — paragraphs, links, whole embedded <table>/
 * <img> blocks (Reddit-sourced feeds are especially bad for this), and
 * sometimes that markup arrives HTML-entity-encoded (&lt;span&gt;...) rather
 * than literal. Decode + strip in a small loop (decoding can reveal new
 * literal tags) so the result is always clean plain text, regardless of how
 * the source feed encoded things.
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

  return text.replace(/\s+/g, " ").trim();
}

/** Heuristic: does this text still contain raw or entity-encoded markup that stripHtml should clean? */
export function looksLikeHtml(text: string | null | undefined): boolean {
  if (!text) return false;
  return /<\s*[a-z][a-z0-9]*[\s>/]/i.test(text) || /&lt;\s*[a-z]/i.test(text);
}
