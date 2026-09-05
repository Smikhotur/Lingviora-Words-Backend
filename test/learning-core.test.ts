import assert from "node:assert/strict";
import test from "node:test";
import { calculateReviewState, checkAnswer } from "../src/learning-core";

test("normalizes acceptable answers", () => {
  assert.equal(checkAnswer("  HELLO! ", "hello"), true);
  assert.equal(checkAnswer("colour", "color / colour"), true);
  assert.equal(checkAnswer("bonjour", "hello"), false);
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

test("a wrong answer resets the streak and schedules a short retry", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const state = calculateReviewState({ repetitions: 3, correctStreak: 3, correctCount: 3, attemptCount: 3, easeFactor: 265, intervalDays: 7, practicedModes: 3 }, false, "typing", now);
  assert.equal(state.correctStreak, 0);
  assert.equal(state.nextReviewAt.toISOString(), "2026-01-01T00:10:00.000Z");
});
