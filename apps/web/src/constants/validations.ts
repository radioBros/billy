import { i18n } from "@/plugins/i18n";

// Call the global translator lazily inside each rule (do NOT destructure `t` at
// module load — that can lose vue-i18n's binding and render raw keys).
const t = (key: string, named?: Record<string, unknown>): string =>
  named ? i18n.global.t(key, named) : i18n.global.t(key);

// Local date helpers (the original `Helpers/Date` module is not part of this
// project). `parseLocalDate` turns a YYYY-MM-DD (or any Date-parseable) string
// into a local Date; `dateValid` reports whether it parses to a real date.
const parseLocalDate = (v: any) => {
  if (v instanceof Date) return v;
  const s = String(v ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
};

const dateValid = (v: any) => !Number.isNaN(parseLocalDate(v).getTime());

const strOf = (v: any): string => (v == null ? "" : String(v).trim());
const isEmpty = (v: any): boolean => strOf(v) === "";

const HOST_RE =
  /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const DECIMAL2_RE = /^\d+(\.\d{1,2})?$/;
const RECIPIENT_CODE_RE = /^[A-Za-z0-9]{6,7}$/;

/** Plain hostname / IPv4 (no scheme, port, path or spaces). */
/** Service base URL: http(s)://host[:port][/path] where host may be a bare container name or localhost
 *  (unlike `url`, which demands a dotted public domain). */
const SERVICE_URL_RE = /^https?:\/\/([A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:\d{1,5})?(\/[^\s]*)?$/;
export const isServiceUrl = (v: any): boolean => SERVICE_URL_RE.test(strOf(v));

export const isHost = (v: any): boolean => HOST_RE.test(strOf(v));
/** Integer within [min, max] (accepts numbers and numeric strings). */
export const isIntBetween = (v: any, min: number, max: number): boolean => {
  const s = strOf(v);
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return n >= min && n <= max;
};
/** Non-negative decimal with at most 2 fraction digits (dot separator). */
export const isDecimal2 = (v: any): boolean => DECIMAL2_RE.test(strOf(v));
/** IBAN: spaces ignored, case-insensitive, structure + mod-97 checksum. */
export const isIban = (v: any): boolean => {
  const s = strOf(v).replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const digits = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
};

const requiredMsg = (v: any): boolean | string =>
  (typeof v === "string" ? v.trim() !== "" : !!v || v === 0) || t("validations.requiredField");
const hostRule = (v: any): boolean | string =>
  isEmpty(v) || isHost(v) || t("validations.hostInvalid");
const portRule = (v: any): boolean | string =>
  isEmpty(v) || isIntBetween(v, 1, 65535) || t("validations.portInvalid");
const ibanRule = (v: any): boolean | string =>
  isEmpty(v) || isIban(v) || t("validations.ibanInvalid");
const decimal2Rule = (v: any): boolean | string =>
  isEmpty(v) || isDecimal2(v) || t("validations.decimalInvalid");
const recipientCodeRule = (v: any): boolean | string =>
  isEmpty(v) || RECIPIENT_CODE_RE.test(strOf(v)) || t("validations.insertValidRecipientCode");
const intBetweenRule =
  (min: number, max: number) =>
  (v: any): boolean | string =>
    isEmpty(v) || isIntBetween(v, min, max) || t("validations.intBetween", { min, max });

/** Account slug — mirrors the API (`trim().toLowerCase()`, then [a-z0-9] with inner hyphens, 2–48 chars). */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const isSlug = (v: any): boolean => {
  const s = strOf(v).toLowerCase();
  return s.length >= 2 && s.length <= 48 && SLUG_RE.test(s);
};
const slugRule = (v: any): boolean | string => isEmpty(v) || isSlug(v) || t("validations.slugInvalid");
/** Login password — mirrors the API PasswordPolicy (8–200 chars, untrimmed, no complexity rules). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

export default {
  names: ["email", "int", "password", "cf", "phone", "url"],
  fileMaxSize: [(v: any) => !v || v.size < 1024 * 1024 * 3 || "Max 3MB"],
  fileMaxSizeMulti: [
    (v: any) =>
      !v ||
      (v &&
        Array.isArray(v) &&
        !v.find((file) => file.size > 1024 * 1024 * 3)) ||
      "Max 3MB per file",
  ],
  fileMaxSize10mb: [(v: any) => !v || v.size < 1024 * 1024 * 10 || "Max 10MB"],
  fileMaxSizeMulti10mb: [
    (v: any) =>
      !v ||
      (v &&
        Array.isArray(v) &&
        !v.find((file) => file.size > 1024 * 1024 * 10)) ||
      "Max 10MB per file",
  ],
  int: [
    (v: any) =>
      !v || (v && v.length && !isNaN(v)) || t("validations.onlyNumbersAllowed"),
  ],
  date: [(v: any) => !v || (v && dateValid(v)) || t("validations.dates.invalid")],
  textOrBool: [
    (v: any) =>
      typeof v == "boolean" ||
      typeof v == "string" ||
      t("validations.dates.invalid"),
  ],
  email: [
    (v: any) =>
      (v &&
        v.length &&
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v)) ||
      !v ||
      !v.length ||
      t("validations.insertValidEmail"),
  ],
  emailArray: [
    (v: any) => {
      if (!v || !v.length) return true;
      let valid = true;
      v.map((mail: string) => {
        valid =
          valid && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(mail);
      });
      return valid || t("validations.insertValidPhone");
    },
  ],
  did: [
    (v: any) =>
      (v &&
        v.length &&
        /(?:([+]\d{1,4})[-.\s]?)?(?:[(](\d{1,3})[)][-.\s]?)?(\d{1,4})[-.\s]?(\d{1,4})[-.\s]?(\d{1,9})/.test(
          v,
        )) ||
      !v ||
      !v.length ||
      t("validations.insertValidPhone"),
  ],
  url: [
    (v: any) =>
      (v &&
        v.length &&
        /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{2,63}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*\/?)$/.test(
          v,
        )) ||
      !v ||
      !v.length ||
      t("validations.insertValidUrl"),
  ],
  domain: [
    (v: any) =>
      (v &&
        v.length &&
        /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z0-9]{2,63}$/.test(
          v,
        )) ||
      !v ||
      !v.length ||
      t("validations.insertValidDomain"),
  ],
  imgUrlPath: [
    (v: any) =>
      (v &&
        v.length &&
        /\/.*\.(png|gif|webp|jpeg|jpg|svg|ico)\??.*$/.test(v)) ||
      !v ||
      !v.length ||
      t("validations.insertValidImgPath"),
  ],
  intPositive: [
    (v: any) =>
      v == null ||
      v === "" ||
      parseInt(v, 10) > 0 ||
      t("validations.requiredField"),
  ],
  cf: [
    (v: any) =>
      (v &&
        v.length &&
        /^(?:[A-Z][AEIOU][AEIOUX]|[B-DF-HJ-NP-TV-Z]{2}[A-Z]){2}(?:[\dLMNP-V]{2}(?:[A-EHLMPR-T](?:[04LQ][1-9MNP-V]|[15MR][\dLMNP-V]|[26NS][0-8LMNP-U])|[DHPS][37PT][0L]|[ACELMRT][37PT][01LM]|[AC-EHLMPR-T][26NS][9V])|(?:[02468LNQSU][048LQU]|[13579MPRTV][26NS])B[26NS][9V])(?:[A-MZ][1-9MNP-V][\dLMNP-V]{2}|[A-M][0L](?:[1-9MNP-V][\dLMNP-V]|[0L][1-9MNP-V]))[A-Z]$/.test(
          v.toUpperCase(),
        )) ||
      !v ||
      !v.length ||
      t("validations.insertValidCF"),
  ],
  piva: [
    (v: any) =>
      (v && v.length && /^[0-9]{11}$/.test(v)) ||
      !v ||
      !v.length ||
      t("validations.insertValidPiva"),
  ],
  pivaCf: [
    (v: any) =>
      (v &&
        v.length &&
        (/^[0-9]{11}$/.test(v) ||
          /^(?:[A-Z][AEIOU][AEIOUX]|[B-DF-HJ-NP-TV-Z]{2}[A-Z]){2}(?:[\dLMNP-V]{2}(?:[A-EHLMPR-T](?:[04LQ][1-9MNP-V]|[15MR][\dLMNP-V]|[26NS][0-8LMNP-U])|[DHPS][37PT][0L]|[ACELMRT][37PT][01LM]|[AC-EHLMPR-T][26NS][9V])|(?:[02468LNQSU][048LQU]|[13579MPRTV][26NS])B[26NS][9V])(?:[A-MZ][1-9MNP-V][\dLMNP-V]{2}|[A-M][0L](?:[1-9MNP-V][\dLMNP-V]|[0L][1-9MNP-V]))[A-Z]$/.test(
            v.toUpperCase(),
          ))) ||
      !v ||
      !v.length ||
      t("validations.insertValidCF"),
  ],
  phone: [
    (v: any) =>
      (v &&
        v.length &&
        /^\(?\+?\d{1,4}?\)?[-.]?\(?\d{1,3}?\)?[-.]?\d{1,4}[-.]?\d{1,4}[-.]?\d{1,9}$/.test(
          v,
        )) ||
      !v ||
      !v.length ||
      t("validations.insertValidPhone"),
  ],
  phoneNoPrefix: [
    (v: any) =>
      (v &&
        v.length &&
        !v.toString().startsWith("00") &&
        !v.toString().startsWith("+")) ||
      !v ||
      !v.length ||
      t("validations.noPrefix"),
    (v: any) =>
      (v && v.length && /^[0-9]+$/.test(v)) ||
      !v ||
      !v.length ||
      t("validations.insertValidPhone"),
  ],
  phoneArray: [
    (v: any) => {
      if (!v || !v.length) return true;
      let valid = true;
      v.map((num: string) => {
        valid =
          valid &&
          /^\(?\+?\d{1,4}?\)?[-.]?\(?\d{1,3}?\)?[-.]?\d{1,4}[-.]?\d{1,4}[-.]?\d{1,9}$/.test(
            num,
          );
      });
      return valid || t("validations.insertValidPhone");
    },
  ],
  host: [hostRule],
  port: [portRule],
  iban: [ibanRule],
  decimal2: [decimal2Rule],
  recipientCode: [recipientCodeRule],
  intBetween: (min: number, max: number) => [intBetweenRule(min, max)],
  serviceUrl: [(v: any) => isEmpty(v) || isServiceUrl(v) || t("validations.insertValidUrl")],
  /** Optional account slug (blank = derived server-side from the name). */
  slug: [slugRule],
  maxLength: (max: number) => (v: any) => {
    if (!v || !v.length) return true;
    return v.length <= max || t("validations.maxLength", { max: max });
  },
  required: {
    serviceUrl: [
      (v: any) => !isEmpty(v) || t("validations.requiredField"),
      (v: any) => isServiceUrl(v) || t("validations.insertValidUrl"),
    ],
    any: [requiredMsg],
    host: [requiredMsg, hostRule],
    port: [requiredMsg, portRule],
    iban: [requiredMsg, ibanRule],
    decimal2: [requiredMsg, decimal2Rule],
    recipientCode: [requiredMsg, recipientCodeRule],
    intBetween: (min: number, max: number) => [requiredMsg, intBetweenRule(min, max)],
    boolean: [
      (v: any) => v === false || v === true || t("validations.requiredField"),
    ],
    int: [
      (v: any) =>
        (v !== "undefined" && v !== null && !isNaN(v)) ||
        t("validations.requiredField"),
    ],
    intPositive: [
      (v: any) =>
        (v !== "undefined" && v !== null && parseInt(v) > 0) ||
        t("validations.requiredField"),
    ],
    notNull: [
      (v: any) =>
        (v !== "undefined" && v !== null) || t("validations.requiredField"),
    ],
    array: [
      (v: any) =>
        Boolean(v && v.length && Array.isArray(v)) ||
        t("validations.requiredField"),
    ],
    date: [(v: any) => (v && dateValid(v)) || t("validations.dates.invalid")],
    /** A YYYY-MM-DD date that is today or later (e.g. a scheduled send date). */
    dateNotPast: [
      (v: any) => (v && dateValid(v)) || t("validations.dates.invalid"),
      (v: any) => strOf(v) >= new Date().toISOString().slice(0, 10) || t("validations.dates.notPast"),
    ],
    /** A money amount strictly greater than zero. */
    amountPositive: [
      requiredMsg,
      (v: any) => (Number.isFinite(Number(v)) && Number(v) > 0) || t("validations.amountPositive"),
    ],
    textOrBool: [
      (v: any) =>
        typeof v == "boolean" ||
        (v && typeof v == "string") ||
        t("validations.invalidValue"),
    ],
    email: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v) ||
        t("validations.insertValidEmail"),
    ],
    emailArray: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) => {
        let valid = true;
        v.map((mail: string) => {
          valid =
            valid && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(mail);
        });
        return valid || t("validations.insertValidPhone");
      },
    ],
    did: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        (v &&
          v.length &&
          /(?:([+]\d{1,4})[-.\s]?)?(?:[(](\d{1,3})[)][-.\s]?)?(\d{1,4})[-.\s]?(\d{1,4})[-.\s]?(\d{1,9})/.test(
            v,
          )) ||
        t("validations.insertValidPhone"),
    ],
    /** A user/admin login password as the API accepts it (8–200 chars). */
    passwordPolicy: [
      (v: any) => (typeof v === "string" && v.length > 0) || t("validations.requiredField"),
      (v: any) => String(v ?? "").length >= PASSWORD_MIN || t("validations.passwordMinLength", { min: PASSWORD_MIN }),
      (v: any) => String(v ?? "").length <= PASSWORD_MAX || t("validations.maxLength", { max: PASSWORD_MAX }),
    ],
    basicPassword: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) => v.length >= 6 || t("validations.basicPasswordFormat"),
    ],
    password: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        /.*^(?=.{8,20})(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*\W).*$/.test(v) ||
        t("validations.passwordFormat"),
    ],
    url: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{2,63}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*\/?)$/.test(
          v,
        ) || t("validations.insertValidUrl"),
    ],
    domain: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        (v &&
          v.length &&
          /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z0-9]{2,63}$/.test(
            v,
          )) ||
        t("validations.insertValidDomain"),
    ],
    imgUrlPath: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        (v &&
          v.length &&
          /\/.*\.(png|gif|webp|jpeg|jpg|svg|ico)\??.*$/.test(v)) ||
        t("validations.insertValidImgPath"),
    ],
    cf: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        (v &&
          v.length &&
          /^(?:[A-Z][AEIOU][AEIOUX]|[B-DF-HJ-NP-TV-Z]{2}[A-Z]){2}(?:[\dLMNP-V]{2}(?:[A-EHLMPR-T](?:[04LQ][1-9MNP-V]|[15MR][\dLMNP-V]|[26NS][0-8LMNP-U])|[DHPS][37PT][0L]|[ACELMRT][37PT][01LM]|[AC-EHLMPR-T][26NS][9V])|(?:[02468LNQSU][048LQU]|[13579MPRTV][26NS])B[26NS][9V])(?:[A-MZ][1-9MNP-V][\dLMNP-V]{2}|[A-M][0L](?:[1-9MNP-V][\dLMNP-V]|[0L][1-9MNP-V]))[A-Z]$/.test(
            v.toUpperCase(),
          )) ||
        t("validations.insertValidCF"),
    ],
    piva: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) => /^[0-9]{11}$/.test(v) || t("validations.insertValidPiva"),
    ],
    pivaCf: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        (v &&
          v.length &&
          (/^[0-9]{11}$/.test(v) ||
            /^(?:[A-Z][AEIOU][AEIOUX]|[B-DF-HJ-NP-TV-Z]{2}[A-Z]){2}(?:[\dLMNP-V]{2}(?:[A-EHLMPR-T](?:[04LQ][1-9MNP-V]|[15MR][\dLMNP-V]|[26NS][0-8LMNP-U])|[DHPS][37PT][0L]|[ACELMRT][37PT][01LM]|[AC-EHLMPR-T][26NS][9V])|(?:[02468LNQSU][048LQU]|[13579MPRTV][26NS])B[26NS][9V])(?:[A-MZ][1-9MNP-V][\dLMNP-V]{2}|[A-M][0L](?:[1-9MNP-V][\dLMNP-V]|[0L][1-9MNP-V]))[A-Z]$/.test(
              v.toUpperCase(),
            ))) ||
        !v ||
        !v.length ||
        t("validations.insertValidCF"),
    ],
    phone: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        /^\(?\+?\d{1,4}?\)?[-.]?\(?\d{1,3}?\)?[-.]?\d{1,4}[-.]?\d{1,4}[-.]?\d{1,9}$/.test(
          v,
        ) || t("validations.insertValidPhone"),
    ],
    phoneNoPrefix: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        (Boolean(v) &&
          !v.toString().startsWith("00") &&
          !v.toString().startsWith("+")) ||
        t("validations.noPrefix"),
      (v: any) =>
        (Boolean(v) && /^[0-9]+$/.test(v)) || t("validations.insertValidPhone"),
    ],
    phoneArray: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) => {
        let valid = true;
        v.map((num: string) => {
          valid =
            valid &&
            /^\(?\+?\d{1,4}?\)?[-.]?\(?\d{1,3}?\)?[-.]?\d{1,4}[-.]?\d{1,4}[-.]?\d{1,9}$/.test(
              num,
            );
        });
        return valid || t("validations.insertValidPhone");
      },
    ],
    filePdf: [
      (v: any) => !!v || t("validations.requiredField"),
      (v: any) =>
        (v && v.type && v.type == "application/pdf") ||
        t("validations.onlyPdfAllowed"),
    ],
    maxToday: [
      (v: any) =>
        (v && parseLocalDate(v).getTime() <= new Date().getTime()) ||
        t("validations.dates.maxToday"),
    ],
    maxLength: (max: number) => (v: any) => {
      if (!v || !v.length) return t("validations.requiredField")
      return v.length <= max || t("validations.maxLength", { max: max });
    },
  },
  regex: {
    email: new RegExp(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/),
    password: new RegExp(
      /^(?=.*\d)(?=.*[A-Z])(?=.*[a-z])(?=.*[^\w\d\s:])([^\s]){6,}$/,
    ),
    url: new RegExp(
      /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{2,63}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*\/?)$/,
    ),
    cf: new RegExp(
      /^(?:[A-Z][AEIOU][AEIOUX]|[B-DF-HJ-NP-TV-Z]{2}[A-Z]){2}(?:[\dLMNP-V]{2}(?:[A-EHLMPR-T](?:[04LQ][1-9MNP-V]|[15MR][\dLMNP-V]|[26NS][0-8LMNP-U])|[DHPS][37PT][0L]|[ACELMRT][37PT][01LM]|[AC-EHLMPR-T][26NS][9V])|(?:[02468LNQSU][048LQU]|[13579MPRTV][26NS])B[26NS][9V])(?:[A-MZ][1-9MNP-V][\dLMNP-V]{2}|[A-M][0L](?:[1-9MNP-V][\dLMNP-V]|[0L][1-9MNP-V]))[A-Z]$/,
    ),
    piva: new RegExp(/^[0-9]{11}$/),
    phone: new RegExp(
      /^\(?\+?\d{1,4}?\)?[-.]?\(?\d{1,3}?\)?[-.]?\d{1,4}[-.]?\d{1,4}[-.]?\d{1,9}$/,
    ),
  },
};
