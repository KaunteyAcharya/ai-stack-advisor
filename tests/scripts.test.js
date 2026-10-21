import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEcb, toUsdBase, checkChanges } from "../scripts/update-fx.mjs";
import { scoringMarkdown } from "../scripts/scoring-table.mjs";

const XML = `<gesmes:Envelope><Cube><Cube time='2026-10-13'>
<Cube currency='USD' rate='1.1188'/><Cube currency='INR' rate='106.6000'/><Cube currency='GBP' rate='0.84460'/>
<Cube currency='CHF' rate='0.9312'/><Cube currency='CAD' rate='1.5933'/><Cube currency='AUD' rate='1.6033'/>
</Cube></Cube></gesmes:Envelope>`;

test("ECB XML → USD base, AED from peg", () => {
  const { date, eur } = parseEcb(XML);
  assert.equal(date, "2026-10-13");
  const r = toUsdBase(eur);
  assert.ok(Math.abs(r.INR - 106.6 / 1.1188) < 1e-5);
  assert.ok(Math.abs(r.EUR - 1 / 1.1188) < 1e-5);
  assert.equal(r.AED, 3.6725);
  assert.deepEqual(Object.keys(r).sort(), ["AED", "AUD", "CAD", "CHF", "EUR", "GBP", "INR", "USD"]);
});

test("missing currency fails", () => {
  assert.throws(() => toUsdBase({ USD: 1.1, INR: 100 }), /GBP/);
});

test("rate moving more than 15% is rejected", () => {
  assert.equal(checkChanges({ INR: 95 }, { INR: 96 }).length, 0);
  assert.equal(checkChanges({ INR: 95 }, { INR: 120 }).length, 1);
});

test("METHODOLOGY.md scoring tables match engine/scoring.js (run npm run docs:scoring)", () => {
  const doc = readFileSync(new URL("../docs/METHODOLOGY.md", import.meta.url), "utf8");
  assert.ok(doc.includes(scoringMarkdown()));
});
