/** Integer minor units → PASSO decimal string (`1234` → `"12.34"`, negatives kept). */
export const minorToDecimal = (minor: number): string => {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
};

/** Plain number → decimal string with at most `maxDecimals`, at least `minDecimals`. */
export const numberToDecimal = (n: number, minDecimals: number, maxDecimals: number): string => {
  const fixed = n.toFixed(maxDecimals);
  let [int, frac = ""] = fixed.split(".") as [string, string?];
  frac = (frac ?? "").replace(/0+$/u, "");
  while (frac.length < minDecimals) frac += "0";
  return frac.length > 0 ? `${int}.${frac}` : int;
};

/** Percentage → `"22.00"` (PASSO wants exactly two decimals). */
export const rateToDecimal = (rate: number): string => rate.toFixed(2);

/** Half-away-from-zero rounding of a number to integer minor units. */
export const roundMinor = (n: number): number => Math.sign(n) * Math.round(Math.abs(n));

/** Compare decimal strings like `"77.47"` as integer cents (2dp inputs only). */
export const decimalToMinor = (s: string): number => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?/u.exec(s.trim());
  if (!m) return NaN;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
};
