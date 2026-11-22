/**
 * Outgoing-email content hygiene, applied at the single send point (the worker)
 * so EVERY path is covered: template defaults, the send dialog's edited body,
 * and recurring auto-sends.
 *
 * Why: spam filters (Gmail especially) penalise
 *   - a text/plain part that is really HTML markup (the send dialog's
 *     RichTextEditor body used to be copied verbatim into both parts),
 *   - an HTML part that is a bare fragment with no document/charset,
 *   - attachment names with path separators (`8/2026.pdf` from an invoice number).
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  copy: "©",
  reg: "®",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  laquo: "«",
  raquo: "»",
  egrave: "è",
  eacute: "é",
  agrave: "à",
  igrave: "ì",
  ograve: "ò",
  ugrave: "ù",
};

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });

/** True when the string contains HTML tags (not just a stray `<`). */
export const looksLikeHtml = (s: string): boolean => /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(s);

/** Convert an HTML body to a readable plain-text alternative. */
export const htmlToText = (html: string): string => {
  let s = html;
  s = s.replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<!doctype[^>]*>/gi, "");
  // Links: keep the text, append the URL when it differs from the text.
  s = s.replace(/<a\s[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    const url = decodeEntities(href.trim());
    if (!url || url.startsWith("#") || url.startsWith("mailto:") || decodeEntities(label) === url) return inner;
    return `${inner} (${url})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|h[1-6]|ul|ol|table|blockquote|section|article|header|footer)>/gi, "\n\n");
  s = s.replace(/<\/tr>/gi, "\n");
  s = s.replace(/<\/t[dh]>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
};

/** Ensure the HTML part is a full document with a UTF-8 charset declaration. */
export const ensureHtmlDocument = (html: string): string => {
  if (!html.trim()) return html;
  const head = '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>';
  if (!/<html[\s>]/i.test(html)) {
    return `<!doctype html><html>${head}<body>${html}</body></html>`;
  }
  if (!/<head[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1>${head}`);
  }
  return html;
};

/**
 * Normalise the rendered parts: HTML becomes a full document; the text part is
 * derived from the HTML whenever it is missing or is itself HTML markup.
 */
export const normalizeEmailContent = (rendered: { html: string; text: string }): { html: string; text: string } => {
  const html = rendered.html.trim() ? ensureHtmlDocument(rendered.html) : rendered.html;
  let text = rendered.text;
  if (!text.trim() || looksLikeHtml(text)) {
    text = htmlToText(html.trim() ? html : text);
  }
  return { html, text };
};

/** Make an attachment filename safe: no path separators / reserved characters. */
export const safeAttachmentFilename = (name: string): string => {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\-\s]+/, "");
  return cleaned || "attachment.pdf";
};
