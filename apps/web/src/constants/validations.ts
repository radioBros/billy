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
  maxLength: (max: number) => (v: any) => {
    if (!v || !v.length) return true;
    return v.length <= max || t("validations.maxLength", { max: max });
  },
  required: {
    any: [(v: any) => !!v || v === 0 || t("validations.requiredField")],
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
