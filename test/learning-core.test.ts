import assert from "node:assert/strict";
import test from "node:test";
import { calculateReviewState, checkAnswer } from "../src/learning-core";

test("normalizes acceptable answers", () => {
  assert.equal(checkAnswer("  HELLO! ", "hello"), true);
  assert.equal(checkAnswer("colour", "color / colour"), true);
  assert.equal(checkAnswer("colour", "color, colour"), true);
  assert.equal(checkAnswer("зв'язок", "зв’язок"), true);
  assert.equal(checkAnswer("звʼязок", "зв'язок"), true);
  assert.equal(checkAnswer("look  forward\u00a0to", "look forward to"), true);
  assert.equal(checkAnswer("bonjour", "hello"), false);
});

test("a choice accepts the whole displayed translation and rejects partial labels", () => {
  const expected = "контакт, зв’язок; зв’язуватися";
  assert.equal(checkAnswer(expected, expected, "choice"), true);
  assert.equal(checkAnswer("контакт, зв'язок; зв'язуватися", expected, "choice"), true);
  assert.equal(checkAnswer("зв’язуватися", expected, "choice"), false);
  assert.equal(checkAnswer("зв’язок", expected, "choice"), false);
  assert.equal(checkAnswer("color / colour", "color / colour", "choice"), true);
});

test("typing never rewards misspellings, missing accents, or changed hyphens", () => {
  assert.equal(checkAnswer("contakt", "contact"), false);
  assert.equal(checkAnswer("entertainmen", "entertainment"), false);
  assert.equal(checkAnswer("resume", "résumé"), false);
  assert.equal(checkAnswer("up to date", "up-to-date"), false);
  assert.equal(checkAnswer(" ", ""), false);
  assert.equal(checkAnswer("!", "!"), false);
});

test("marks a word learned only after varied successful recall", () => {
  let state: { repetitions: number; correctStreak: number; correctCount: number; attemptCount: number; easeFactor: number; intervalDays: number; practicedModes: number; status: "learning" | "learned"; nextReviewAt: Date } = { repetitions: 0, correctStreak: 0, correctCount: 0, attemptCount: 0, easeFactor: 250, intervalDays: 0, practicedModes: 0, status: "learning", nextReviewAt: new Date() };
  state = { ...state, ...calculateReviewState(state, true, "choice") };
  state = { ...state, ...calculateReviewState(state, true, "typing") };
  state = { ...state, ...calculateReviewState(state, true, "choice") };
  state = { ...state, ...calculateReviewState(state, true, "typing") };
  assert.equal(state.status, "learned");
  assert.equal(state.intervalDays, 19);
});

test("four typing recalls can graduate a single-word list without choice distractors", () => {
  let state = { repetitions: 0, correctStreak: 0, correctCount: 0, attemptCount: 0, easeFactor: 250, intervalDays: 0, practicedModes: 0 };
  for (let review = 1; review <= 4; review += 1) {
    const result = calculateReviewState(state, true, "typing");
    assert.equal(result.status, review === 4 ? "learned" : "learning");
    state = result;
  }
});

test("choice-only recall never automatically graduates a word", () => {
  let state = { repetitions: 0, correctStreak: 0, correctCount: 0, attemptCount: 0, easeFactor: 250, intervalDays: 0, practicedModes: 0 };
  for (let review = 0; review < 8; review += 1) {
    const result = calculateReviewState(state, true, "choice");
    assert.equal(result.status, "learning");
    state = result;
  }
});

test("a wrong answer resets the streak and schedules a short retry", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const state = calculateReviewState({ repetitions: 3, correctStreak: 3, correctCount: 3, attemptCount: 3, easeFactor: 265, intervalDays: 7, practicedModes: 3 }, false, "typing", now);
  assert.equal(state.correctStreak, 0);
  assert.equal(state.practicedModes, 0);
  assert.equal(state.nextReviewAt.toISOString(), "2026-01-01T00:10:00.000Z");
  let retry = state;
  for (let review = 0; review < 4; review += 1) retry = calculateReviewState(retry, true, "choice");
  assert.equal(retry.status, "learning", "typing before a mistake cannot satisfy the new streak");
});
