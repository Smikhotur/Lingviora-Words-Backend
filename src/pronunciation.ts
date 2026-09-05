const dictionaryEndpoint = "https://api.dictionaryapi.dev/api/v2/entries/en";
const datamuseEndpoint = "https://api.datamuse.com/words";
const requestTimeoutMs = 2_500;

export type Pronunciation = {
  transcription: string | null;
  audioUrl: string | null;
};

type CacheRow = {
  transcription: string | null;
  audioUrl: string | null;
};

type ProviderResult = {
  pronunciation: Pronunciation | null;
  unavailable: boolean;
};

const arpabetVowels: Record<string, string> = {
  AA: "ɑ", AE: "æ", AH: "ʌ", AO: "ɔ", AW: "aʊ", AX: "ə", AXR: "ɚ", AY: "aɪ",
  EH: "ɛ", ER: "ɝ", EY: "eɪ", IH: "ɪ", IX: "ɨ", IY: "i", OW: "oʊ", OY: "ɔɪ",
  UH: "ʊ", UW: "u", UX: "ʉ"
};

const arpabetConsonants: Record<string, string> = {
  B: "b", CH: "tʃ", D: "d", DH: "ð", DX: "ɾ", EL: "l̩", EM: "m̩", EN: "n̩", F: "f",
  G: "ɡ", HH: "h", JH: "dʒ", K: "k", L: "l", M: "m", N: "n", NG: "ŋ", P: "p",
  Q: "ʔ", R: "ɹ", S: "s", SH: "ʃ", T: "t", TH: "θ", V: "v", W: "w", WH: "ʍ",
  Y: "j", Z: "z", ZH: "ʒ"
};

const arpabetOnsets = new Set([
  "B L", "B R", "B Y", "CH R", "D R", "D W", "D Y", "F L", "F R", "F Y",
  "G L", "G R", "G W", "G Y", "HH Y", "K L", "K R", "K W", "K Y", "L Y",
  "M Y", "N Y", "P L", "P R", "P Y", "S F", "S K", "S L", "S M", "S N",
  "S P", "S T", "S TH", "S W", "SH R", "T R", "T W", "T Y", "TH R", "TH W",
  "V R", "S K R", "S K W", "S P L", "S P R", "S T R"
]);

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function withoutIpaDelimiters(value: string) {
  if ((value.startsWith("/") && value.endsWith("/")) || (value.startsWith("[") && value.endsWith("]"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function arpabetOnsetLength(phones: string[]) {
  for (let length = Math.min(3, phones.length); length > 1; length -= 1) {
    if (arpabetOnsets.has(phones.slice(-length).join(" "))) return length;
  }
  return phones.length && phones.at(-1) !== "NG" ? 1 : 0;
}

export function convertArpabetToIpa(value: string) {
  const source = withoutIpaDelimiters(value.trim());
  const rawPhones = source.split(/\s+/).filter(Boolean);
  if (!rawPhones.length) return null;

  const phones = rawPhones.map((rawPhone) => {
    const match = /^([A-Z]+)([012])?$/.exec(rawPhone);
    if (!match) return null;
    const [, phone, stress] = match;
    if (phone in arpabetVowels) {
      let ipa = arpabetVowels[phone];
      if (phone === "AH" && stress === "0") ipa = "ə";
      if (phone === "ER" && stress === "0") ipa = "ɚ";
      return { phone, ipa, stress: stress ?? null, vowel: true };
    }
    if (stress || !(phone in arpabetConsonants)) return null;
    return { phone, ipa: arpabetConsonants[phone], stress: null, vowel: false };
  });
  if (phones.some((phone) => !phone)) return null;

  const parsed = phones as Array<{ phone: string; ipa: string; stress: string | null; vowel: boolean }>;
  const stressBefore = new Map<number, string>();
  let previousVowel = -1;
  parsed.forEach((phone, index) => {
    if (!phone.vowel) return;
    if (phone.stress === "1" || phone.stress === "2") {
      const marker = phone.stress === "1" ? "ˈ" : "ˌ";
      const onsetLength = previousVowel < 0 ? index : arpabetOnsetLength(parsed.slice(previousVowel + 1, index).map((item) => item.phone));
      stressBefore.set(previousVowel < 0 ? 0 : index - onsetLength, marker);
    }
    previousVowel = index;
  });

  return `/${parsed.map((phone, index) => `${stressBefore.get(index) ?? ""}${phone.ipa}`).join("")}/`;
}

export function normalizePronunciationTranscription(value: unknown) {
  const transcription = cleanText(value, 200);
  if (!transcription) return null;
  const converted = convertArpabetToIpa(transcription);
  if (converted) return converted;

  const inner = withoutIpaDelimiters(transcription);
  if (/^[A-Z]+[012]?(?:\s+[A-Z]+[012]?)+$/.test(inner)) return null;
  if ((transcription.startsWith("/") && transcription.endsWith("/")) || (transcription.startsWith("[") && transcription.endsWith("]"))) return transcription;
  return `/${transcription}/`;
}

export function normalizePronunciationAudioUrl(value: unknown) {
  const candidate = cleanText(value, 2_048);
  if (!candidate) return null;
  try {
    const url = new URL(candidate.startsWith("//") ? `https:${candidate}` : candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseDictionaryPronunciation(payload: unknown): Pronunciation | null {
  if (!Array.isArray(payload)) return null;
  let transcription: string | null = null;
  let audioUrl: string | null = null;

  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const dictionaryEntry = entry as { phonetic?: unknown; phonetics?: unknown };
    transcription ??= normalizePronunciationTranscription(dictionaryEntry.phonetic);
    if (!Array.isArray(dictionaryEntry.phonetics)) continue;
    for (const item of dictionaryEntry.phonetics) {
      if (!item || typeof item !== "object") continue;
      const phonetic = item as { text?: unknown; audio?: unknown };
      transcription ??= normalizePronunciationTranscription(phonetic.text);
      audioUrl ??= normalizePronunciationAudioUrl(phonetic.audio);
      if (transcription && audioUrl) return { transcription, audioUrl };
    }
  }

  return transcription || audioUrl ? { transcription, audioUrl } : null;
}

export function parseDatamusePronunciation(payload: unknown, term: string): Pronunciation | null {
  if (!Array.isArray(payload)) return null;
  const expected = cacheKey(term);

  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const result = item as { word?: unknown; tags?: unknown };
    if (typeof result.word !== "string" || cacheKey(result.word) !== expected || !Array.isArray(result.tags)) continue;
    const pronunciationTag = result.tags.find((tag) => typeof tag === "string" && tag.startsWith("pron:"));
    if (typeof pronunciationTag !== "string") continue;
    const transcription = normalizePronunciationTranscription(pronunciationTag.slice(5));
    if (transcription) return { transcription, audioUrl: null };
  }

  return null;
}

function cacheKey(term: string) {
  return term.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

async function readCache(db: D1Database, term: string) {
  return db.prepare("SELECT transcription, audio_url AS audioUrl FROM pronunciation_cache WHERE language = 'en' AND term = ? LIMIT 1")
    .bind(term)
    .first<CacheRow>();
}

async function writeCache(db: D1Database, term: string, pronunciation: Pronunciation | null) {
  await db.prepare(`INSERT INTO pronunciation_cache (language, term, transcription, audio_url, fetched_at)
    VALUES ('en', ?, ?, ?, ?)
    ON CONFLICT(language, term) DO UPDATE SET transcription = excluded.transcription, audio_url = excluded.audio_url, fetched_at = excluded.fetched_at`)
    .bind(term, pronunciation?.transcription ?? null, pronunciation?.audioUrl ?? null, new Date().toISOString())
    .run();
}

async function cachePronunciation(db: D1Database, term: string, pronunciation: Pronunciation | null) {
  try {
    await writeCache(db, term, pronunciation);
  } catch (error) {
    console.warn("Pronunciation cache write failed", { error: error instanceof Error ? error.name : "UnknownError" });
  }
}

async function withTimeout<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDictionaryPronunciation(term: string): Promise<ProviderResult> {
  try {
    const response = await withTimeout((signal) => fetch(`${dictionaryEndpoint}/${encodeURIComponent(term)}`, {
      headers: { accept: "application/json" },
      signal
    }));
    if (response.status === 404) return { pronunciation: null, unavailable: false };
    if (!response.ok) return { pronunciation: null, unavailable: true };
    return { pronunciation: parseDictionaryPronunciation(await response.json()), unavailable: false };
  } catch {
    return { pronunciation: null, unavailable: true };
  }
}

async function fetchDatamusePronunciation(term: string): Promise<ProviderResult> {
  const url = new URL(datamuseEndpoint);
  url.searchParams.set("sp", term);
  url.searchParams.set("qe", "sp");
  url.searchParams.set("md", "r");
  url.searchParams.set("ipa", "1");
  url.searchParams.set("max", "1");
  try {
    const response = await withTimeout((signal) => fetch(url, {
      headers: { accept: "application/json" },
      signal
    }));
    if (!response.ok) return { pronunciation: null, unavailable: true };
    return { pronunciation: parseDatamusePronunciation(await response.json(), term), unavailable: false };
  } catch {
    return { pronunciation: null, unavailable: true };
  }
}

export async function getEnglishPronunciation(db: D1Database, term: string): Promise<Pronunciation | null> {
  const normalizedTerm = cacheKey(term);
  if (!normalizedTerm) return null;

  let cached: CacheRow | null = null;
  try {
    cached = await readCache(db, normalizedTerm);
  } catch (error) {
    console.warn("Pronunciation cache read failed", { error: error instanceof Error ? error.name : "UnknownError" });
  }
  const cachedTranscription = normalizePronunciationTranscription(cached?.transcription);
  if (cachedTranscription) {
    const normalizedCache = { transcription: cachedTranscription, audioUrl: cached?.audioUrl ?? null };
    if (cachedTranscription !== cached?.transcription) await cachePronunciation(db, normalizedTerm, normalizedCache);
    return normalizedCache;
  }

  const [dictionary, datamuse] = await Promise.all([
    fetchDictionaryPronunciation(normalizedTerm),
    fetchDatamusePronunciation(normalizedTerm)
  ]);
  const pronunciation = {
    transcription: dictionary.pronunciation?.transcription ?? datamuse.pronunciation?.transcription ?? null,
    audioUrl: cached?.audioUrl ?? dictionary.pronunciation?.audioUrl ?? null
  };
  const result = pronunciation.transcription || pronunciation.audioUrl ? pronunciation : null;
  if (result) await cachePronunciation(db, normalizedTerm, result);
  if (!result && dictionary.unavailable && datamuse.unavailable) {
    console.warn("Pronunciation providers unavailable", { timeoutMs: requestTimeoutMs });
  }
  return result;
}
