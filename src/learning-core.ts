import type { LearningMode } from "./types";

const MODE_BITS: Record<LearningMode, number> = { choice: 1, typing: 2, sentence: 4 };
export const REQUIRED_CORRECT_STREAK = 4;

export function normalizeAnswer(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[’‘ʼ`]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!?]+$/g, "").trim();
}

export function checkAnswer(answer: string, expected: string, mode: LearningMode = "typing") {
  const normalized = normalizeAnswer(answer);
  if (!normalized) return false;
  // A choice is the entire displayed label, even if it contains several translations.
  if (normalized === normalizeAnswer(expected)) return true;
  if (mode === "choice") return false;
  // Only explicitly stored variants are accepted; spelling errors never count as recall.
  return expected.split(/[;,/|]/).map(normalizeAnswer).filter(Boolean).includes(normalized);
}

type ReviewInput = { repetitions: number; correctStreak: number; correctCount: number; attemptCount: number; easeFactor: number; intervalDays: number; practicedModes: number };

export function calculateReviewState(input: ReviewInput, correct: boolean, mode: LearningMode, now = new Date()) {
  let { repetitions, correctStreak, correctCount, easeFactor, intervalDays, practicedModes } = input;
  let status: "learning" | "learned" = "learning";
  let nextReviewAt: Date;
  if (correct) {
    repetitions += 1;
    correctStreak += 1;
    correctCount += 1;
    practicedModes |= MODE_BITS[mode];
    intervalDays = repetitions === 1 ? 1 : repetitions === 2 ? 3 : repetitions === 3 ? 7 : Math.min(180, Math.max(14, Math.round(intervalDays * (easeFactor / 100))));
    easeFactor = Math.min(300, easeFactor + 5);
    const recalledWithoutChoices = Boolean(practicedModes & (MODE_BITS.typing | MODE_BITS.sentence));
    status = correctStreak >= REQUIRED_CORRECT_STREAK && recalledWithoutChoices ? "learned" : "learning";
    nextReviewAt = new Date(now.getTime() + intervalDays * 86_400_000);
  } else {
    repetitions = 0;
    correctStreak = 0;
    practicedModes = 0;
    intervalDays = 0;
    easeFactor = Math.max(130, easeFactor - 20);
    nextReviewAt = new Date(now.getTime() + 600_000);
  }
  return { status, repetitions, correctStreak, correctCount, attemptCount: input.attemptCount + 1, easeFactor, intervalDays, practicedModes, nextReviewAt };
}
