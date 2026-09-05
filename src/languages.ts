export const studyLanguageCodes = ["en", "uk", "ru", "pl", "it", "es", "de", "et", "kk", "tr"] as const;

export type StudyLanguageCode = typeof studyLanguageCodes[number];

const languageAliases: Record<string, StudyLanguageCode> = {
  en: "en",
  english: "en",
  англійська: "en",
  английский: "en",
  angielski: "en",
  inglese: "en",
  inglés: "en",
  ingles: "en",
  englisch: "en",
  inglise: "en",
  ағылшын: "en",
  ingilizce: "en",
  uk: "uk",
  ua: "uk",
  ukrainian: "uk",
  українська: "uk",
  ru: "ru",
  russian: "ru",
  русский: "ru",
  pl: "pl",
  polish: "pl",
  polski: "pl",
  it: "it",
  italian: "it",
  italiano: "it",
  es: "es",
  spanish: "es",
  español: "es",
  de: "de",
  german: "de",
  deutsch: "de",
  et: "et",
  estonian: "et",
  eesti: "et",
  kk: "kk",
  kazakh: "kk",
  қазақша: "kk",
  tr: "tr",
  turkish: "tr",
  türkçe: "tr"
};

function aliasKey(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function normalizeStudyLanguage(value: string) {
  const trimmed = value.normalize("NFKC").trim();
  return languageAliases[aliasKey(trimmed)] ?? trimmed;
}

export function isEnglishLanguage(value: string) {
  return normalizeStudyLanguage(value) === "en";
}
