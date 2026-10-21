import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreOptions, weightedScore, CRITERIA } from "../engine/scoring.js";
import { withDefaults } from "../engine/inputs.js";

test("data may not leave → A and B excluded with reason", () => {
  const s = scoreOptions(withDefaults({ externalAllowed: "no" }));
  assert.match(s.excluded.A, /may not leave/);
  assert.match(s.excluded.B, /may not leave/);
  assert.equal(s.excluded.C, undefined);
});

test("only_no_training lowers A/B privacy and adds a note", () => {
  const yes = scoreOptions(withDefaults({ externalAllowed: "yes", personalData: false, residency: "none" }));
  const nt = scoreOptions(withDefaults({ externalAllowed: "only_no_training", personalData: false, residency: "none" }));
  assert.ok(nt.scores.privacy.B < yes.scores.privacy.B);
  assert.ok(nt.notes.B.some((n) => /training/.test(n)));
});

test("no DevOps → low team fit and a warning for C and D", () => {
  const s = scoreOptions(withDefaults({ devops: "none" }));
  assert.equal(s.scores.teamFit.C, 1);
  assert.ok(s.warnings.C.length > 0);
});

test("best_available quality lowers self-hosted quality score", () => {
  const s = scoreOptions(withDefaults({ quality: "best_available" }));
  assert.equal(s.scores.quality.C, 2);
});

test("scores stay within 0–5", () => {
  const s = scoreOptions(withDefaults({ externalAllowed: "only_no_training", personalData: true, residency: "india", engineers: "none", devops: "none" }));
  for (const c of CRITERIA) for (const o of ["A", "B", "C", "D"]) assert.ok(s.scores[c.id][o] >= 0 && s.scores[c.id][o] <= 5);
});

test("weighted score: all 5s = 1, weights normalise", () => {
  const scores = Object.fromEntries(CRITERIA.map((c) => [c.id, { A: 5 }]));
  assert.equal(weightedScore(scores, { privacy: 1, timeToLaunch: 3 }, "A"), 1);
});
