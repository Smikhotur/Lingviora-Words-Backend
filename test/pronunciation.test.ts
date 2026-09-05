import assert from "node:assert/strict";
import test from "node:test";

import { isEnglishLanguage, normalizeStudyLanguage } from "../src/languages";
import { convertArpabetToIpa, getEnglishPronunciation, normalizePronunciationAudioUrl, normalizePronunciationTranscription, parseDatamusePronunciation, parseDictionaryPronunciation } from "../src/pronunciation";

test("normalizes supported study-language aliases without changing unknown values", () => {
  assert.equal(normalizeStudyLanguage(" English "), "en");
  assert.equal(normalizeStudyLanguage("Англійська"), "en");
  assert.equal(normalizeStudyLanguage("Українська"), "uk");
  assert.equal(normalizeStudyLanguage("Latin"), "Latin");
  assert.equal(isEnglishLanguage("ENGLISH"), true);
  assert.equal(isEnglishLanguage("de"), false);
});

test("extracts transcription and secure audio from Dictionary API payload", () => {
  const pronunciation = parseDictionaryPronunciation([{
    phonetic: "/həˈləʊ/",
    phonetics: [{ text: "/həˈloʊ/", audio: "//api.dictionaryapi.dev/media/pronunciations/en/hello-us.mp3" }]
  }]);

  assert.deepEqual(pronunciation, {
    transcription: "/həˈləʊ/",
    audioUrl: "https://api.dictionaryapi.dev/media/pronunciations/en/hello-us.mp3"
  });
});

test("rejects unsafe audio URLs and malformed Dictionary API responses", () => {
  assert.equal(normalizePronunciationAudioUrl("http://example.com/audio.mp3"), null);
  assert.equal(normalizePronunciationAudioUrl("javascript:alert(1)"), null);
  assert.equal(parseDictionaryPronunciation({ phonetic: "/test/" }), null);
  assert.equal(parseDictionaryPronunciation([{ phonetics: [{ audio: "" }] }]), null);
});

test("converts Datamuse ARPAbet metadata to readable IPA", () => {
  assert.deepEqual(parseDatamusePronunciation([
    { word: "quietly", tags: ["pron:K W AY1 AH0 T L IY0"] },
    { word: "quiet", tags: ["query", "pron:K W AY1 AH0 T"] }
  ], "Quiet"), { transcription: "/ˈkwaɪət/", audioUrl: null });
  assert.equal(parseDatamusePronunciation([{ word: "quietly", tags: ["pron:K W AY1 AH0 T L IY0"] }], "quiet"), null);
});

test("normalizes existing ARPAbet rows without changing IPA", () => {
  assert.equal(convertArpabetToIpa("K W AY1 AH0 T"), "/ˈkwaɪət/");
  assert.equal(normalizePronunciationTranscription("/IH0 M P AO1 R T AH0 N T/"), "/ɪmˈpɔɹtənt/");
  assert.equal(normalizePronunciationTranscription("/hi/"), "/hi/");
});

test("normalizes the requested word before calling Dictionary API", async () => {
  const originalFetch = globalThis.fetch;
  let cacheWrite: unknown[] | null = null;
  const requestedUrls: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => null,
            run: async () => {
              if (sql.includes("INSERT INTO pronunciation_cache")) cacheWrite = values;
              return { success: true };
            }
          };
        }
      };
    }
  } as unknown as D1Database;

  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.startsWith("https://api.dictionaryapi.dev/")) {
      return new Response(JSON.stringify([{ phonetic: "/hiː/" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify([{ word: "he", tags: ["query", "pron:HH IY1"] }]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    assert.deepEqual(await getEnglishPronunciation(db, " He "), { transcription: "/hiː/", audioUrl: null });
    assert.equal(cacheWrite?.[0], "he");
    assert.ok(requestedUrls.includes("https://api.dictionaryapi.dev/api/v2/entries/en/he"));
    assert.ok(requestedUrls.some((url) => url.startsWith("https://api.datamuse.com/words?") && url.includes("sp=he") && url.includes("ipa=1")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Datamuse transcription when Dictionary API is unavailable and ignores a negative cache row", async () => {
  const originalFetch = globalThis.fetch;
  const db = {
    prepare() {
      return {
        bind() {
          return { first: async () => ({ transcription: null, audioUrl: null }), run: async () => ({ success: true }) };
        }
      };
    }
  } as unknown as D1Database;

  globalThis.fetch = async (input) => {
    if (String(input).startsWith("https://api.dictionaryapi.dev/")) throw new DOMException("Unavailable", "AbortError");
    return new Response(JSON.stringify([{ word: "important", tags: ["query", "pron:IH0 M P AO1 R T AH0 N T"] }]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    assert.deepEqual(await getEnglishPronunciation(db, "Important"), {
      transcription: "/ɪmˈpɔɹtənt/",
      audioUrl: null
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
