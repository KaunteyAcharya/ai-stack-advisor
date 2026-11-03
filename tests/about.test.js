import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generated, fill, inline, methodHtml, mathHtml, lastUpdated, loadData, DESCRIPTION } from "../scripts/build-about.mjs";

const page = readFileSync(new URL("../about.html", import.meta.url), "utf8");
const md = readFileSync(new URL("../docs/METHODOLOGY.md", import.meta.url), "utf8");

test("about.html is in sync with METHODOLOGY.md and the data (run npm run docs:about)", () => {
  assert.equal(fill(page, generated()), page);
});

test("every methodology section and formula block appears on the about page", () => {
  const sections = [...md.matchAll(/^## (\d+[a-z]?)\. /gm)].map((m) => m[1]);
  assert.ok(sections.length >= 20);
  for (const n of sections) assert.ok(page.includes(`id="method-${n}"`), `section ${n} missing`);
  const math = (md.match(/^```math$/gm) || []).length;
  assert.ok(math >= 20);
  assert.equal((page.match(/<div class="formula math"><math /g) || []).length, math);
  assert.equal((md.match(/^```/gm) || []).length / 2, math, "every formula block is LaTeX (```math)");
});

test("every in-page link points to an element on the page", () => {
  const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of page.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(id), `#${id} has no target`);
});

test("every price and assumption is listed with its source", () => {
  const d = loadData();
  for (const e of d.prices.entries) {
    assert.ok(page.includes(e.label.replace(/&/g, "&amp;")), `${e.id} missing`);
    if (/^https:/.test(e.source_url)) assert.ok(page.includes(`href="${e.source_url.replace(/&/g, "&amp;")}"`), `${e.id} source missing`);
  }
  for (const e of d.assumptions.entries) assert.ok(page.includes(e.label.replace(/&/g, "&amp;")), `${e.id} missing`);
});

test("structured data matches the visible page", () => {
  const ld = JSON.parse(page.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  const article = ld["@graph"].find((x) => x["@type"] === "TechArticle");
  const updated = lastUpdated(loadData());
  assert.equal(article.dateModified, updated);
  assert.ok(page.includes(`<time datetime="${updated}">`));
  assert.ok(page.includes(`<meta name="description" content="${DESCRIPTION}">`));
  assert.equal((page.match(/<h1[\s>]/g) || []).length, 1);
});

test("markdown conversion: code, links, emphasis and section links", () => {
  assert.equal(inline("`a < b` and **bold**"), "<code>a &lt; b</code> and <strong>bold</strong>");
  assert.equal(inline("[code](../engine)"), '<a href="https://github.com/KaunteyAcharya/ai-stack-advisor/tree/main/engine" rel="noopener">code</a>');
  assert.equal(inline("see section 10d"), 'see <a href="#method-10d">section 10d</a>');
  assert.equal(inline("an *assumption*"), "an <em>assumption</em>");
  const { html, toc } = methodHtml("# T\n\n## 3. Voice (`voiceMonthly`): extra\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.deepEqual(toc, [{ id: "method-3", title: "3. Voice: extra" }]);
  assert.ok(html.includes('<span class="code-ref"><code>voiceMonthly</code></span>'));
  assert.ok(html.includes("<td>1</td><td>2</td>"));
});

test("formulas are rendered as MathML at build time, with the LaTeX kept for copying", () => {
  const html = mathHtml(String.raw`\text{TCO} = \sum_{m=0}^{35} c_m`);
  assert.match(html, /^<div class="formula math"><math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML" display="block">/);
  assert.match(html, /<annotation encoding="application\/x-tex">/);
  assert.ok(!/katex/i.test(page.match(/<head>[\s\S]*<\/head>/)[0]), "the page loads no maths script or stylesheet");
  assert.throws(() => mathHtml(String.raw`\frac{1}`));
});
