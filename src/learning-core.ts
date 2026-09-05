import type { LearningMode } from "./types";

const MODE_BITS: Record<LearningMode, number> = { choice: 1, typing: 2, sentence: 4 };

function modeCount(mask: number) {
  let count = 0;
  for (let value = mask; value > 0; value >>= 1) count += value & 1;
  return count;
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!?]+$/g, "");
}

function distance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(previous[rightIndex] + 1, previous[rightIndex - 1] + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function checkAnswer(answer: string, expected: string) {
  const normalized = normalize(answer);
  return expected.split(/[;/|]/).map(normalize).filter(Boolean).some((candidate) => candidate === normalized || (candidate.length >= 6 && distance(candidate, normalized) === 1));
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
    status = correctStreak >= 4 && intervalDays >= 14 && modeCount(practicedModes) >= 2 ? "learned" : "learning";
    nextReviewAt = new Date(now.getTime() + intervalDays * 86_400_000);
  } else {
    repetitions = 0;
    correctStreak = 0;
    intervalDays = 0;
    easeFactor = Math.max(130, easeFactor - 20);
    nextReviewAt = new Date(now.getTime() + 600_000);
  }
  return { status, repetitions, correctStreak, correctCount, attemptCount: input.attemptCount + 1, easeFactor, intervalDays, practicedModes, nextReviewAt };
}
