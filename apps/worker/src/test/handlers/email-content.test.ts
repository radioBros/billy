import { describe, it, expect } from "vitest";
import {
  ensureHtmlDocument,
  htmlToText,
  looksLikeHtml,
  normalizeEmailContent,
  safeAttachmentFilename,
} from "@/handlers/email-content.js";

// The exact body Billy sent to Gmail on 2026-11-22 (send-dialog edit): the same
// HTML was used for BOTH parts, so the text/plain part was raw markup → spam.
const SENT_BODY =
  "<!doctype html><html><body><p>Hello,</p><p>Woptima has sent you invoice <strong>8/2026</strong> for <strong>EUR 3500.00</strong>.</p></body></html>";

describe("normalizeEmailContent", () => {
  it("derives a real plain-text part when text is HTML markup", () => {
    const out = normalizeEmailContent({ html: SENT_BODY, text: SENT_BODY });
    expect(out.text).toBe("Hello,\n\nWoptima has sent you invoice 8/2026 for EUR 3500.00.");
    expect(looksLikeHtml(out.text)).toBe(false);
  });

  it("adds a charset head to a full document missing one", () => {
    const out = normalizeEmailContent({ html: SENT_BODY, text: "" });
    expect(out.html).toContain('<meta charset="utf-8">');
    expect(out.html).toContain("<body><p>Hello,</p>");
  });

  it("wraps a bare HTML fragment in a full document", () => {
    const out = normalizeEmailContent({ html: "<p>Ciao</p>", text: "Ciao" });
    expect(out.html).toMatch(/^<!doctype html><html><head><meta charset="utf-8">/);
    expect(out.html).toContain("<body><p>Ciao</p></body></html>");
    expect(out.text).toBe("Ciao");
  });

  it("keeps an existing proper plain-text part untouched", () => {
    const out = normalizeEmailContent({ html: "<p>A</p>", text: "A — 3 < 5 is plain text" });
    expect(out.text).toBe("A — 3 < 5 is plain text");
  });

  it("leaves an empty message empty", () => {
    expect(normalizeEmailContent({ html: "", text: "" })).toEqual({ html: "", text: "" });
  });
});

describe("htmlToText", () => {
  it("keeps link URLs, list items, line breaks and decodes entities", () => {
    const html =
      '<p>Pay here: <a href="https://billy.example/p/1?a=1&amp;b=2">open invoice</a></p><ul><li>One</li><li>Two</li></ul><p>A&nbsp;&amp;&nbsp;B<br>next &euro; &#8364; &#x20AC;</p>';
    expect(htmlToText(html)).toBe(
      "Pay here: open invoice (https://billy.example/p/1?a=1&b=2)\n\n- One\n- Two\n\nA & B\nnext € € €",
    );
  });

  it("does not duplicate a URL that is already the link text", () => {
    expect(htmlToText('<a href="https://x.io">https://x.io</a>')).toBe("https://x.io");
  });

  it("drops style/script/head content", () => {
    expect(htmlToText("<html><head><style>p{color:red}</style></head><body><p>Hi</p><script>x()</script></body></html>")).toBe("Hi");
  });
});

describe("ensureHtmlDocument", () => {
  it("does not touch a document that already has a head", () => {
    const doc = "<html><head><title>t</title></head><body>x</body></html>";
    expect(ensureHtmlDocument(doc)).toBe(doc);
  });
});

describe("safeAttachmentFilename", () => {
  it("replaces path separators and reserved characters", () => {
    expect(safeAttachmentFilename("8/2026.pdf")).toBe("8-2026.pdf");
    expect(safeAttachmentFilename('a\\b:c*d?"e<f>g|h.pdf')).toBe("a-b-c-d-e-f-g-h.pdf");
  });

  it("keeps normal names and falls back when nothing is left", () => {
    expect(safeAttachmentFilename("Fattura 12-2026.pdf")).toBe("Fattura 12-2026.pdf");
    expect(safeAttachmentFilename("../")).toBe("attachment.pdf");
  });
});
