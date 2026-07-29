export const sanitizeHtml = (input: string): string => {
  if (!input) return "";
  let out = input;
  // Remove <script>…</script> and <style>…</style> including contents.
  out = out.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu, "");
  // Remove any lone opening/closing script|style tags left over.
  out = out.replace(/<\s*\/?\s*(script|style)\b[^>]*>/giu, "");
  // Strip inline event handlers: on*="…" / on*='…' / on*=value.
  out = out.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "");
  // Neutralize javascript: URLs in href/src.
  out = out.replace(
    /((?:href|src)\s*=\s*)(?:"|')?\s*javascript\s*:[^"'>\s]*(?:"|')?/giu,
    "$1'#'",
  );
  // Neutralize `data:` URLs EXCEPT `data:image/*` — embedded base64 images (logos)
  // are a legitimate, safe use (rendered via <img>, no script execution). But
  // `data:text/html` / `data:image/svg+xml` (SVG can script) and other data types
  // are XSS vectors, so those are still stubbed out.
  out = out.replace(
    /((?:href|src)\s*=\s*)(?:"|')?\s*data\s*:(?!image\/(?:png|jpe?g|gif|webp|bmp)\b)[^"'>\s]*(?:"|')?/giu,
    "$1'#'",
  );
  return out;
};
