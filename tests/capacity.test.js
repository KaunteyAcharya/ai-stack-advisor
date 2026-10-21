import { test } from "node:test";
import assert from "node:assert/strict";
import { gpusNeeded, selectGpu } from "../engine/capacity.js";
import { readFileSync } from "node:fs";

const selfhost = JSON.parse(readFileSync(new URL("../data/selfhost.json", import.meta.url)));
const gpus = {
  l4: { gpu_class: "l4", vram_gb: 24, price: 0.59 },
  l40s: { gpu_class: "l40s", vram_gb: 48, price: 1.09 },
  a100_80gb: { gpu_class: "a100_80gb", vram_gb: 80, price: 1.79 },
};

test("at least one GPU", () => {
  assert.equal(gpusNeeded({ peakRequestsPerSec: 0.01, outTokens: 400, gpuTokensPerSec: 400 }), 1);
});

test("scales with peak tokens/sec and 1.3 headroom", () => {
  // 10 rps × 400 tokens = 4000 tok/s × 1.3 = 5200 / 400 = 13 GPUs
  assert.equal(gpusNeeded({ peakRequestsPerSec: 10, outTokens: 400, gpuTokensPerSec: 400 }), 13);
});

test("high availability needs at least 2 GPUs", () => {
  assert.equal(gpusNeeded({ peakRequestsPerSec: 0.01, outTokens: 400, gpuTokensPerSec: 400, highAvailability: true }), 2);
  assert.equal(gpusNeeded({ peakRequestsPerSec: 10, outTokens: 400, gpuTokensPerSec: 400, highAvailability: true }), 13);
});

test("quality → model size → VRAM → cheapest GPU that fits", () => {
  assert.equal(selectGpu("basic", selfhost, gpus).gpuClass, "l4");
  assert.equal(selectGpu("good", selfhost, gpus).gpuClass, "l40s");
  assert.equal(selectGpu("best_available", selfhost, gpus).gpuClass, "a100_80gb");
});

test("overhead (e.g. real-time voice +30%) raises GPU count", () => {
  assert.equal(gpusNeeded({ peakRequestsPerSec: 10, outTokens: 400, gpuTokensPerSec: 400, overhead: 1.3 }), 17);
});
