# Methodology

This document explains every calculation in AI Stack Advisor in plain language. The code lives in [`engine/`](../engine); each section names the file.

**Conventions**

- All money is computed in **USD** and converted to the display currency only when shown.
- A month is **30 days** and **730 hours**.
- Percentages in the inputs are 0–100. Month index `m = 0` is month 1.
- Every number marked *assumption* can be edited in the advisor's form.

---

## 1. Volume (`engine/costs.js` → `volume`)

Volume depends on the use case.

**Chatbot, voice agent, data assistant, internal copilot**

```math
\begin{aligned}
\text{requests per month}(m) &= \text{users per day} \times \text{requests per user} \times 30 \times (1 + g)^{\min(m,\ M)} \\
\text{conversations per month}(m) &= \text{users per day} \times 30 \times (1 + g)^{\min(m,\ M)} \quad \text{(or the value you enter)}
\end{aligned}
```

Here *m* is the month (*m* = 0 is month 1) and *g* the monthly growth. **Growth stops** after *M* months (`growth_months`, default 12); volume is flat afterwards. Without this, 5% a month for 36 months grows volume about 5.8×, and the 36-month total depends mostly on the growth guess. Every report also shows **TCO-36 with no growth** next to the grown figure.

**Document processing.** One request per document. Users per day count only toward seat pricing unless "chat over documents" is on.

```math
\begin{aligned}
\text{requests per month}(m) &= \text{documents per month} \times (1 + g)^{m} \\
\text{input tokens per document} &= \text{pages per document} \times \text{tokens per page} \\
\text{output tokens per document} &= \text{the value you enter (default 800)}
\end{aligned}
```

With **chat over documents**, chat requests (`users_per_day × requests_per_user × 30`) are added, each with the chat token counts. Cost stays exact because the average tokens per request are weighted by request count, and LLM cost is linear in tokens. Nothing is counted twice.

**Peak load** (sizes self-hosted GPUs):

```math
\text{peak requests per second} = \frac{(\text{requests per month} \div 30) \times \text{peak-hour share}}{3600}
```

## 2. Option B: API-based (`apiMonthly`)

```math
\begin{aligned}
\text{LLM cost per request} &= \frac{\text{input} \times (1 - c) \times \text{input price} + \text{input} \times c \times \text{cached price} + \text{output} \times \text{output price}}{1{,}000{,}000} \\
\text{LLM monthly} &= \text{requests per month} \times \text{LLM cost per request} \\
\text{API monthly} &= \text{LLM monthly} + \text{managed DB} + \text{hosting} + \text{vector DB}_{\text{(if RAG)}} \\
&\quad + \text{voice}_{\text{(voice agent)}} + \text{OCR}_{\text{(if set)}} + \text{maintenance hours}_B \times \text{engineer hourly}
\end{aligned}
```

The quality need picks the model tier: `basic` → budget tier, `good` → mid tier, `best_available` → premium tier (`data/prices.json`).

**Provider** (`llmCandidates`, `llmModelFor`). Prices are held for four providers (Google Gemini, OpenAI, Anthropic Claude, Mistral), each with a budget and a mid model and, except Mistral, a premium model. With the default setting, "Cheapest for this workload", every provider's model for the tier is priced on this workload's own request (input, output and cached tokens, at batch prices where batch is on) and the cheapest is used; providers with no model at that tier are left out. If you choose a provider, its model is used, falling back to its mid model when it has none at the tier. The analyst view lists every provider's cost per request and in month 1. Option D's API share uses the same model. Prices that change on a known date (an introductory price) are stored with that date; the later price is used, because it applies to almost all of a 36-month plan.

**Prompt caching.** *c* is the share of each request's input that repeats across requests (system prompt, instructions, earlier agent steps) and is served from the provider's cache at the published cached-input price (about a tenth of the input price for most models). Caching only applies when the average prompt is at least the provider's minimum (4,096 tokens for Gemini, 1,024 for OpenAI, 512 for Anthropic, none listed for Mistral), so short prompts may get no discount from some providers. Defaults: 40% for chat and voice, 30% for internal tools, 10% for documents, 40–50% for agents. Storage fees for explicit caches are not modelled. Self-hosted servers cache repeated prefixes too, with no minimum: the same share *c* skips prompt reading on the GPU (section 4).

## 2b. Option E: Hosted open model (`hostedOpenMonthly`)

```math
\begin{aligned}
\text{open monthly} &= \text{requests per month} \times \text{LLM cost per request}_{\text{(open-weight model's price)}} \\
&\quad + \text{managed DB} + \text{hosting} + \text{vector DB}_{\text{(if RAG)}} + \text{voice} + \text{OCR} \\
&\quad + \text{maintenance hours}_E \times \text{engineer hourly}
\end{aligned}
```

The same open-weight model size that self-hosting would run (`data/selfhost.json`: small, medium or large for the quality need), bought per token from an inference provider instead of on rented GPUs (`llm_open_hosted` in `data/prices.json`). There is no fixed GPU cost, so it scales from zero like option B, but it carries the full open-model quality gap like option C (section 12). Data is processed by the inference provider, so option E is excluded when data must stay in-house. If no open-model price is in the data, option E is shown as unavailable.

## 3. Voice add-on (`voiceMonthly`): voice agents only, every option

```math
\begin{aligned}
\text{voice minutes} &= \text{conversations per month} \times \text{minutes per conversation} \\
\text{TTS per minute} &= \text{TTS price per 1,000 characters} \times \frac{\text{spoken characters per minute (assumption: 750)}}{1000} \\
\text{voice monthly} &= \text{voice minutes} \times (\text{STT per minute} + \text{TTS per minute} + \text{telephony per minute})
\end{aligned}
```

Self-hosted speech-to-text and text-to-speech run on the rented GPUs, so the self-hosted option pays **telephony only**. In the hybrid option, the self-hosted share pays telephony only and the API share pays all three.

## 4. Option C: Self-hosted (`selfhostMonthly`, `engine/capacity.js`)

The GPU choice is an explicit chain of **assumptions** in `data/selfhost.json`:

| Quality need | Model size class | VRAM needed | Cheapest GPU that fits |
|---|---|---|---|
| basic | ~8B, 16-bit | 22 GB | L4 24 GB |
| good | ~32B, 4-bit | 40 GB | L40S 48 GB |
| best_available | ~70B, 4-bit | 64 GB | A100 80 GB |

A request uses the GPU twice: **reading the prompt** (prefill, limited by compute) and **writing the answer** (decode). Both share the same GPU time, so their loads add up. Requests in flight also keep their context in GPU memory (the KV cache), so long prompts can need more GPUs for memory than for compute. Speeds per GPU class are assumptions in `prices.json` (`gpu_throughput`): answer writing in output tokens/second with batching, and prompt reading from the NVIDIA datasheet:

```math
\begin{aligned}
\text{prompt-reading speed (tokens/s)} &\approx \frac{\text{dense FP16 TFLOPS} \times 50\%\ \text{utilisation}}{2 \times \text{parameters}} \\[6pt]
\text{L4, 8B model:} &\quad \frac{121 \times 0.5}{16\ \text{GFLOP per token}} \approx 3{,}800 \\
\text{L40S, 32B model:} &\quad \frac{362 \times 0.5}{64} \approx 2{,}800 \\
\text{A100, 70B model:} &\quad \frac{312 \times 0.5}{140} \approx 1{,}100
\end{aligned}
```

Memory per GPU and per token (`data/selfhost.json`, assumptions): 90% of VRAM is usable; the weights take 16 / 18 / 40 GB; the KV cache takes 128 / 256 / 320 KB per token (from the layouts of Llama 3.1 8B, Qwen 2.5 32B and Llama 3.3 70B at 16 bits). One answer is written at about 30 tokens/second while batched.

```math
\begin{aligned}
\text{prompt seconds} &= \frac{\text{input tokens} \times (1 - c)}{\text{prompt-reading tokens/s}} \quad \text{(cached share } c \text{ skips this)} \\
\text{prefill load} &= \text{peak requests/s} \times \text{prompt seconds} \times \text{overhead} \quad \text{(GPUs busy reading prompts)} \\
\text{decode load} &= \text{peak requests/s} \times \frac{\text{output tokens}}{\text{GPU output tokens/s}} \times \text{overhead} \\
\text{concurrent} &= \text{peak requests/s} \times \left(\text{prompt seconds} + \frac{\text{output tokens}}{30}\right) \quad \text{(Little's law)} \\
\text{KV room (GB)} &= \text{VRAM} \times 0.9 - \text{weights (GB)} \\
\text{memory load} &= \frac{\text{concurrent} \times (\text{input tokens} + \text{output tokens} / 2) \times \text{KV MB per token}}{1024 \times \text{KV room (GB)}} \\
\text{GPUs} &= \text{round up}\big(\max(\text{prefill load} + \text{decode load},\ \text{memory load}) \times 1.3\big) \\
&\quad \text{(30\% headroom; at least 1 GPU, or 2 with high availability)} \\
\text{overhead} &= 1.3 \text{ for a voice agent with real-time latency, otherwise } 1 \\[6pt]
\text{GPU monthly} &= \text{GPUs} \times \text{GPU hourly price} \times 730 \quad \text{(always on)} \\
\text{ops monthly} &= \text{maintenance hours}_C \times \text{engineer hourly} \\
\text{self-host monthly} &= \text{GPU monthly} + \text{self-managed DB} + \text{storage} + \text{monitoring} + \text{ops monthly} \\
&\quad + \text{telephony}_{\text{(voice)}} + \text{OCR}_{\text{(if set)}}
\end{aligned}
```

The report says which limit sets the GPU count (reading prompts, writing answers, or memory). The cheapest GPU class that holds the model is used, unless one request's full context does not fit in its KV cache; then the next GPU class that holds it is used, and if none does, a warning says larger GPUs or a model split across GPUs would be needed (not costed). With several workloads (section 10d), the three loads are added up on the largest model's GPUs. Serving engines, quantisation and batching change these speeds a lot: benchmark your own setup and replace the assumptions.

## 5. Option A: SaaS (`saasMonthly`)

Three pricing types are modelled. Each plan in `prices.json` lists the use cases it fits.

| Type | Cost per month | Example |
|---|---|---|
| `per_seat` | max(seats, min_seats) × seat price; only if seats ≤ max seats | AI assistant seats for internal copilots |
| `per_conversation` | tier price; only if conversations ≤ tier limit | Chatbot with N AI conversations included |
| `per_resolution` | max(seats, min_seats) × seat price + conversations × deflection × price per resolution | AI agent billed per resolved conversation plus required agent seats |

Seat prices follow the chosen **billing period**: annual (the default) uses the vendor's listed annual seat price where one exists, otherwise the single listed price.

The **cheapest plan whose limits fit** is used. If no plan fits the volume, the cheapest one is shown with the flag "volume exceeds plan limit; contact the vendor". If no plan fits the use case at all (for example document processing), SaaS is excluded. Maintenance labour (`maintenance_hours_A × engineer_hourly`) and voice costs are added. All SaaS prices are **list prices**; volume customers usually negotiate.

## 6. Option D: Hybrid (`hybridMonthly`)

```math
\begin{aligned}
\text{hybrid monthly} &= \text{self-host monthly}\big(\text{sized for } s \text{ of peak traffic},\ \text{ops} = \text{maintenance hours}_D\big) \\
&\quad + \text{LLM monthly} \times (1 - s) \\
&\quad + \text{managed DB} + \text{hosting} + \text{vector DB}_{\text{(if RAG)}} + \text{voice} + \text{OCR}
\end{aligned}
```

**Automatic split.** When you leave the share blank (the default), the engine computes option D's 36-month cost for a self-hosted share *s* = 10%, 20% … 90% and uses the cheapest. You can also set the share yourself. If data may not leave the company, the hybrid is limited to its self-hosted share (*s* = 100%).

## 7. One-time and maintenance costs

| Option | Build hours | Maintenance hours/month |
|---|---|---|
| A. SaaS | 20 | 4 |
| B. API | 120 | 10 |
| C. Self-hosted | 240 | 30 |
| D. Hybrid | 300 | 35 |
| E. Hosted open model | 120 | 10 |


```math
\text{one-time} = (\text{build hours} + \text{evaluation hours}) \times \text{engineer hourly}
```

Evaluation hours (A 8, B 16, C 32, D 32, E 32) cover testing quality on your own data before launch; open models need more testing. All of these are editable assumptions. The default engineer hourly cost comes from the region and is a sample value.

## 8. Total cost of ownership (`engine/tco.js`)

```math
\begin{aligned}
\text{TCO}_{12} &= \text{one-time} + \sum_{m=0}^{11} \text{monthly cost}(m) \\
\text{TCO}_{36} &= \text{one-time} + \sum_{m=0}^{35} \text{monthly cost}(m)
\end{aligned}
```

Monthly cost is recomputed every month with the grown volume, so the GPU count (and SaaS tier) can step up.

**Prices that change over time.** AI token prices (options B, D, E, and the AI part of SaaS per-task plans) and GPU rental prices (options C and D) are multiplied each month by

```math
\text{price factor}(m) = (1 + \text{yearly change})^{m/12} \quad \text{(AI default } {-30\%} \text{ a year, GPUs } {-15\%}\text{; month 1 uses today's price)}
```

Labour, hosting, databases and SaaS seat prices are kept at today's price. The defaults are estimates from recent price cuts, not forecasts; set both to 0 for today's prices throughout. The report shows the 36-month cost both ways.

**Present value.** Options are ranked on present value, not the plain total, because money spent in year 3 is worth less than money spent now:

```math
\text{PV}_{36} = \text{one-time} + \sum_{m=0}^{35} \frac{\text{monthly cost}(m)}{(1 + r)^{(m + 1)/12}} \quad (r = \text{annual discount rate, default } 10\%)
```

## 9. Break-even: API vs self-hosting (`engine/breakeven.js`)

```math
\begin{aligned}
\text{fixed self-host monthly} &= \text{GPU monthly}_{\text{(1 GPU, or 2 for high availability)}} + \text{ops monthly} + \text{self-managed DB} \\
\text{API cost per request} &= \text{LLM cost per request} + \text{hosted voice (STT + TTS) per request} \\
\text{break-even requests} &= \frac{\text{fixed self-host monthly}}{\text{API cost per request}}
\end{aligned}
```

The **cost-vs-volume curve** recomputes every option's month-1 cost at 41 log-spaced volumes from 1,000 to 10,000,000 requests/month. Crossovers are found where two curves change order, interpolated in log-volume.

## 10. Value and ROI (`engine/value.js`)

Headline figures are **conservative**: they use the gross profit on a **first sale** only. Extra sales come from the conversion uplift you test (see the sensitivity tables below).

```math
\begin{aligned}
\text{gross profit per sale} &= \text{ticket} \times \text{margin} \\
\text{value per conversation} &= \text{gross profit per sale} \times \text{conversion rate} \\
\text{acceptable AI cost per conversation} &= \text{value per conversation} \times \text{target share} \\
\text{AI cost per conversation} &= \frac{\text{option monthly}}{\text{conversations per month}} \\
\text{sales per month} &= \text{conversations per month} \times \text{conversion rate} \\
\text{AI cost per sale} &= \frac{\text{option monthly}}{\text{sales per month}} \\
\text{AI cost as a share of ticket} &= \frac{\text{AI cost per sale}}{\text{ticket}} \\
\text{break-even extra sales} &= \text{round up}\left(\frac{\text{option monthly}}{\text{gross profit per sale}}\right) \\
\text{break-even uplift (points)} &= \frac{\text{break-even extra sales}}{\text{conversations per month}} \times 100 \\
\text{support savings} &= \text{conversations} \times \text{human share} \times \text{deflection} \\
&\quad \times \text{human cost per conversation} \times \text{cash share} \\
\text{ROI} &= \frac{\text{extra sales} \times \text{gross profit per sale} + \text{support savings} - \text{option monthly}}{\text{option monthly}} \\
\text{payback months} &= \frac{\text{one-time}}{\text{net monthly benefit}} \quad \text{(never, if the benefit is 0 or less)}
\end{aligned}
```

**Time freed vs money saved.** Staff time freed (support savings here, agents and internal tools below) becomes money saved only through fewer hires, less overtime or fewer contractors, or time sold as paid work. The cash share ("Share of time freed that becomes money saved", default 100%, an estimate) sets how much of it counts; the rest is shown as extra capacity. Error costs (agents) are real costs and always count in full.

The human share is the share of conversations that reach a person today (default 20%, set per industry preset). Without it, every chatbot conversation would count as a saved human conversation, which overstates savings for high-volume chat.

**LTV line (repeat buyers).** The second figure uses the value a new customer brings over 12 months:

```math
\begin{aligned}
\text{customer value over 12 months} &= \text{gross profit per sale} \times \text{purchases per year} \quad \text{(or the value you enter)} \\
\text{new customers needed} &= \text{round up}\left(\frac{\text{option monthly}}{\text{customer value over 12 months}}\right)
\end{aligned}
```

It is shown as "~17 new customers/month, value realised over 12 months".

**Sensitivity tables**

- ROI and payback at conversion uplifts of 0, 0.5, 1, 2 and 5 percentage points.
- Deflection rates of 20, 40, 60 and 80%. Deflection changes both support savings and the per-resolution SaaS cost.

**Business profile.** Thresholds are in USD-equivalent so they behave the same in every currency:

| Profile | Rule |
|---|---|
| `high_ticket` | ticket ≥ USD 10,000 |
| `low_ticket_high_volume` | ticket < USD 100 and conversations > 10,000/month |
| `mid_ticket` | everything else |

## 10b. Workflow agents (`engine/agents.js`, `agentValue` in `engine/value.js`)

Six agent workflows are modelled: invoice processing, lead qualification, report generation, ticket triage, stock data → report, and an end-to-end content engine. They are priced **per task** and valued on **time saved**, not on sales.

**Tokens per task.** A task runs *s* LLM steps. Each step re-reads the base prompt plus everything produced so far:

```math
\begin{aligned}
\text{input}(\text{step } i) &= \text{base} + (i - 1) \times \text{growth} \\
\text{average input per call} &= \text{base} + \text{growth} \times \frac{s - 1}{2} \\
\text{LLM calls per month} &= \text{tasks} \times s \quad (+\ \text{replies, for the content engine})
\end{aligned}
```

So cost grows faster than the number of steps: that is why long agents are expensive.

**Batch prices.** Work that can wait (invoices, leads, reports) uses the provider's published batch prices (about 50% lower) for the API and hybrid options. The workflow-SaaS option uses standard prices, because the tool calls your API key directly.

**Costs every option pays** (they do not depend on where the LLM runs):

| Workflow | Extra cost lines |
|---|---|
| Invoice processing | OCR: pages × price per page (your assumption) |
| Lead qualification | External API fee per task, e.g. enrichment lookups (your assumption) |
| Stock data → report | Market data feed per month (sample: business licences cost more; get a quote) |
| Content engine | AI video (seconds × price per second), AI images, X API (posts and replies × price per request, plus owned reads) |

**Content engine scope.** Only replies to comments on **your own** posts are modelled, through official APIs. Automated comments on other accounts' posts break Instagram, X and TikTok rules.

**Workflow SaaS (option A).** A workflow tool priced by task tiers (each step is one tool task) plus your own LLM API key at standard prices. The smallest tier that fits `tasks × tool steps per task` is used; annual or monthly billing follows the billing input.

**Value.**

```math
\begin{aligned}
\text{hours saved} &= \frac{\text{tasks} \times \text{success rate} \times \text{minutes per task}}{60} \\
\text{review hours} &= \frac{\text{tasks} \times \text{review share} \times \text{review minutes}}{60} \\
\text{net hours} &= \text{hours saved} - \text{review hours} \qquad \text{FTE} = \frac{\text{net hours}}{\text{hours per FTE}} \\
\text{time value} &= \text{net hours} \times \text{staff hourly} \quad \text{(capacity freed)} \\
\text{benefit} &= \text{time value} \times \text{cash share} - \text{tasks} \times \text{error rate} \times \text{cost per error} \\
\text{net} &= \text{benefit} - \text{AI monthly cost} \qquad \text{payback} = \frac{\text{build cost}}{\text{net}} \\
\text{break-even success rate} &= \frac{\text{AI cost} + \text{review cost} \times \text{cash share} + \text{error cost}}{\text{tasks} \times \frac{\text{minutes per task}}{60} \times \text{staff hourly} \times \text{cash share}} \times 100
\end{aligned}
```

Staff hourly cost and hours per FTE (160, or 192 in India) come from the region and are sample assumptions. A sensitivity table shows the result at 50%, 70% and 90% completion. Agent use cases use the profile `automation`, with a cost weight of 50%.

## 10c. Internal tools (data assistant, internal copilot)

Internal tools don't make sales, so they are valued on **staff time saved**:

```math
\begin{aligned}
\text{hours saved} &= \frac{\text{requests} \times \text{minutes saved per request}}{60} \quad \text{(default 3 minutes, editable)} \\
\text{benefit} &= \text{hours saved} \times \text{staff hourly} \times \text{cash share} \\
\text{break-even minutes per request} &= \frac{\text{AI monthly cost}}{(\text{requests} \div 60) \times \text{staff hourly} \times \text{cash share}}
\end{aligned}
```

Per-seat SaaS for internal tools charges a seat for every daily user (`max(seats, users per day)`). A sensitivity table shows the result at half and double the minutes saved.

## 10d. Several workloads: one stack or a mix (`engine/portfolio.js`)

Any number of workloads, up to one per use case (11), are compared together, for example a chatbot, a data assistant and an invoice agent. Country, data rules, team, tax and growth are shared; use case, volume, quality and value are per workload.

**Up to 5 workloads, every combination** of options and workloads is evaluated (4ⁿ, at most 1,024; options a workload can't use are skipped). **From 6 workloads** (4¹¹ ≈ 4 million combinations), a local search starts from each single stack and from each workload's own best option, then moves one workload at a time to another option while the score improves; the report says how many combinations it checked. On five workloads it finds the same answer as the full search (tested). Workloads on the same stack share its fixed costs:

```math
\begin{aligned}
\text{stack monthly} &= \textstyle\sum \text{workload usage costs (LLM, voice, media, OCR, per-task fees, SaaS plans)} \\
&\quad + \text{shared infrastructure, once (databases, hosting, vector DB, storage, monitoring)} \\
&\quad + \text{pooled GPUs (C, D): every workload's loads added on the largest model's GPUs} \\
&\quad + \text{maintenance hours} \times \big(1 + (n - 1) \times e\big) \times \text{engineer hourly} \\
\text{build cost} &= \text{build hours} \times \big(1 + (n - 1) \times e\big) \times \text{engineer hourly} \quad \text{(per stack)}
\end{aligned}
```

Here *n* is the number of workloads on the stack and *e* the extra effort for each one beyond the first (50% by default). Mixing stacks therefore pays each stack's base build and maintenance effort, which is the real cost of running two vendors and two skill sets.

**Score per combination:** cost score (lowest 36-month TCO ÷ this one) and the average non-cost score of each workload on its option, weighted as for a single workload. The report names the recommended combination, the best single stack, the best mix, the cheapest, and the gap between single and mix.

**Per-workload value:** each stack's cost is split across its workloads in proportion to their own usage costs (equally if none), then valued with that workload's own model (sales, time saved or support savings).

**Pooling:** the report says from which month one self-hosted stack for everything becomes cheaper than one API stack, and whether any workload would get there on its own.

## 10e. "Not sure?" ranges (`engine/ranges.js`)

Any of these inputs can be marked **not sure**. The analysis then runs twice more, with every uncertain input at the low end of its band and then at the high end, and the summary shows the spread of each result (monthly cost, 36-month cost, time saved, net benefit, payback, break-even sales, support savings) and whether the recommendation changes.

| Input | Low end | High end |
|---|---|---|
| Users per day, tasks per month | × 0.6 | × 1.5 |
| Monthly growth | 0% | × 2 (at least 5%) |
| Tasks done without a person | − 20 points | + 10 points |
| Minutes per task today | × 0.7 | × 1.3 |
| Minutes saved per request | × 0.5 | × 1.5 |
| Conversion rate | × 0.7 | × 1.3 |
| Share the AI handles | − 20 points | + 15 points |
| Conversations reaching a person | × 0.5 | × 1.5 |

Percentages are kept between 0 and 100. With several workloads, a marked input moves in every workload. Moving all uncertain inputs together gives the outer bounds, not a probability range.

## 11. Non-cost scoring (`engine/scoring.js`)

Each option gets a score from 0 to 5 per criterion *k*, with weight *w*. The default weights are privacy 25%, time to launch 20%, team fit 20%, quality 15%, lock-in 10% and scalability 10%; all are adjustable.

```math
\text{non-cost score} = \frac{\sum_k w_k \times \text{score}_k}{5 \times \sum_k w_k} \quad \in [0, 1]
```

The tables below are **generated from the code** (`node scripts/scoring-table.mjs --write`), and a test fails if they drift out of sync.

<!-- SCORING-TABLE:START (generated by scripts/scoring-table.mjs --write) -->
### Base scores (0–5, before rules)

| Criterion | Option | Score | Reason |
|---|---|---|---|
| Data privacy & compliance fit | A | 2 | Data sits with a third-party vendor under its standard terms. |
| Data privacy & compliance fit | B | 3 | Data goes to an API provider, but you control storage and prompts. |
| Data privacy & compliance fit | C | 5 | Data never leaves infrastructure you control. |
| Data privacy & compliance fit | D | 4 | Most traffic stays in-house; complex requests go to an API. |
| Data privacy & compliance fit | E | 3 | Data goes to an inference provider, as with an API build. |
| Time to launch | A | 5 | Configure and launch in days. |
| Time to launch | B | 4 | A few weeks of integration work. |
| Time to launch | C | 2 | GPU setup, model serving and evaluation take months. |
| Time to launch | D | 1 | Needs both the API build and the self-hosted stack, plus routing. |
| Time to launch | E | 4 | Same integration work as an API build; no GPUs to set up. |
| Team capability fit | A | 5 | Needs almost no engineering. |
| Team capability fit | B | 4 | Needs at least one developer. |
| Team capability fit | C | 3 | Needs DevOps/MLOps skills to run GPUs. |
| Team capability fit | D | 3 | Needs DevOps/MLOps skills plus API integration. |
| Team capability fit | E | 4 | Needs at least one developer; the provider runs the GPUs. |
| Quality fit | A | 4 | Good vendor models, limited customisation. |
| Quality fit | B | 5 | Direct access to frontier models. |
| Quality fit | C | 4 | Open models are good for routine tasks. |
| Quality fit | D | 4 | Frontier models for hard requests, open models for routine ones. |
| Quality fit | E | 4 | Open models are good for routine tasks. |
| Vendor lock-in (higher = less lock-in) | A | 1 | Workflows, data and pricing tied to one vendor. |
| Vendor lock-in (higher = less lock-in) | B | 3 | Prompts are portable, but the code targets one provider's API. |
| Vendor lock-in (higher = less lock-in) | C | 5 | Open weights; you can move providers any time. |
| Vendor lock-in (higher = less lock-in) | D | 4 | Mostly portable; the API part can be swapped. |
| Vendor lock-in (higher = less lock-in) | E | 4 | Open weights served by many providers, or later on your own GPUs. |
| Scalability | A | 3 | Scales, but cost rises with volume and plan limits. |
| Scalability | B | 5 | Provider scales automatically. |
| Scalability | C | 3 | You add GPUs yourself as traffic grows. |
| Scalability | D | 4 | API absorbs peaks above self-hosted capacity. |
| Scalability | E | 5 | Provider scales automatically. |

### Rules

| Rule | Effect | Reason |
|---|---|---|
| `data_must_stay` | exclude A, B, E; note D | SaaS and API send data outside the company, which the requirement forbids. |
| `no_training_only` | privacy: A-1, B-1, E-1; note A, B, E | Only paid tiers with no-training terms are allowed, which narrows vendor choice. |
| `personal_data_external` | privacy: A-1, B-1, E-1; note B, E | Personal data at an external provider adds compliance work. |
| `residency_required` | privacy: A-1, B-1, E-1; note A, B, E | External vendors may not offer processing in the required region. |
| `no_engineers` | teamFit: B=1, C=0, D=0, E=1; warn E, B, C, D | Custom builds need engineers the company does not have. |
| `small_team` | teamFit: B=5, E=5 | A small team handles an API build comfortably. |
| `no_devops` | teamFit: C=1, D=1; warn C, D | Running GPUs without DevOps/MLOps skills is high-risk. |
| `strong_devops` | teamFit: C=5, D=4 | Strong DevOps makes self-hosting a good team fit. |
| `best_quality` | quality: C=2, D=3, E=2; note C, E | Open models may trail frontier models when the best quality is needed. |
| `open_model_gap` | note C, E | Open models may trail frontier models; worth testing before committing. |
| `basic_quality` | quality: C=5, D=5, E=5 | Open models are fully adequate for basic quality needs. |
| `realtime_voice` | scalability: C-1; note C | Real-time voice on a small GPU pool risks latency at peak. |
| `ha_without_devops` | scalability: C-1, D-1; note C | High availability needs on-call operations. |
<!-- SCORING-TABLE:END -->

## 12. Recommendation (`engine/recommend.js`)

```math
\begin{aligned}
\text{decision cost} &= \text{PV}_{36} + \text{PV of the value given up through lower answer quality} \\
\text{cost score} &= \frac{\text{lowest decision cost among viable options}}{\text{this option's decision cost}} \quad \in [0, 1] \\
\text{final score} &= w_{\text{cost}} \times \text{cost score} + (1 - w_{\text{cost}}) \times \text{non-cost score} \\
w_{\text{cost}} &= 50\%, \text{ or } 25\% \text{ for high-ticket profiles (adjustable)}
\end{aligned}
```

**Quality-adjusted cost.** Open-weight models may complete fewer tasks than frontier API models. The **open-model quality gap** (default 10 percentage points, an assumption you should replace with your own evaluation) lowers, for self-hosted and the hosted open model (and for the hybrid's self-hosted share): the completion rate of agents, the minutes saved by internal tools, and the deflection rate (support savings) of chat. The benefit an option loses compared with the best option, grown with volume and discounted like costs, is added to its decision cost. The comparison table shows this as "Decision cost". Several workloads (section 10d) are ranked on present value; the quality gap is not yet applied there.

**Your own test results.** If you run the same set of real examples through an API model and an open model and enter both results (% of tasks each got right), they replace the assumed gap:

```math
\begin{aligned}
\text{gap} &= \max(0,\ \text{API result} - \text{open result}) \quad \text{(percentage points)} \\
\text{agents: completion rate} &= \text{API result}
\end{aligned}
```

**Cost per successful task.** When there is a success rate to go on (agents, or any use case with test results), the comparison table adds:

```math
\begin{aligned}
\text{cost per success} &= \frac{\text{month-1 cost}}{\text{units} \times \text{success rate}} \qquad \text{units} = \text{tasks (agents) or requests} \\
\text{success rate} &= \begin{cases} \text{API result} & \text{options A, B} \\ \text{API result} - \text{gap} & \text{options C, E} \\ \text{API result} - \text{gap} \times s & \text{option D} \end{cases}
\end{aligned}
```

**Switch point** (`switchPoint`). With growth, another option can become cheaper later. The report names the first month from which another option costs less per month than the recommended one for every remaining month, and the volume then. Options already cheaper in month 1 are left out, because they lost on other criteria. Without a switch, an API-based recommendation shows the break-even volume from section 9.

Excluded options get no score. The explanation is built from fixed sentence templates; no AI-generated text is used.

**Robustness check.** Each criterion weight, and the cost weight, is moved 10 percentage points up and down, one at a time. If the top option never changes, the report says **"Robust"**. Otherwise it says **"Close call, decided by X"** and names the weight that flips it.

## 12b. How sure is this? Simulation and tornado (`engine/simulate.js`)

**Simulation.** The analysis is re-run 300 times. Each run draws every uncertain quantity from a triangular distribution (low, typical, high):

| Quantity | Low | Typical | High |
|---|---|---|---|
| LLM API prices | × 0.8 | × 1 | × 1.25 |
| GPU rental prices | × 0.75 | × 1 | × 1.3 |
| GPU throughput (assumption) | × 0.7 | × 1 | × 1.3 |
| Engineer hourly cost | × 0.75 | × 1 | × 1.3 |
| Build and maintenance hours | × 0.7 | × 1 | × 1.5 |
| Staff hourly cost (time-valued use cases) | × 0.75 | × 1 | × 1.3 |
| Open-model quality gap | 0 points | your value (or your test result) | max(20, your value) |
| Share of time freed that becomes money saved | min(50%, your value) | your value | 100% |
| Yearly change in AI prices | min(−60%, your value) | your value | max(+10%, your value) |
| Yearly change in GPU prices | min(−35%, your value) | your value | max(+5%, your value) |
| Inputs you marked "Not sure" | band from section 10e | your value | band from section 10e |

The report shows how often each option is recommended ("Robust" at 90% or more, otherwise "Close call"), and the 10th, 50th and 90th percentiles of the recommended option's monthly cost, net monthly benefit and 36-month present value. Net benefit is time saved (agents, internal tools) or support savings with no sales uplift (chat), minus AI cost. Runs are seeded, so the same inputs always give the same result. Related quantities move together: each correlated pair shares a normal draw (a Gaussian copula), giving a correlation of about 0.5 between AI API and GPU rental prices (one hardware market), 0.6 between their yearly trends, and 0.7 between engineer and staff pay (one labour market). These correlations are judgements; everything else is drawn independently. With test results entered, the quality gap is varied by moving the open model's result.

**Tornado.** Each quantity, including every applicable input whether marked or not, is moved alone to its low and its high end. Bars show the net monthly benefit at each end, sorted by swing; ⚑ marks a quantity that changes the recommendation. The longest bars are the assumptions worth checking first.

## 12c. Assumption register, labour costs and token counts

**Assumption register** (`engine/register.js`, `data/assumptions.json`). Every number a result rests on is listed with its value, source, last-reviewed date and a confidence level:

| Confidence | Meaning | Examples |
|---|---|---|
| verified | Taken from an official or primary source | Vendor price pages, tax authorities, ECB exchange rates, caching minimum |
| benchmark | An official statistic used as a proxy | Average labour cost per hour from national statistics offices |
| estimate | A reasoned judgement or sample value | Build hours, completion rates, GPU throughput, the open-model quality gap |

Inputs show the confidence of their default value (hover for the source). The report lists every figure behind the result, estimates first, with counts per level. The confidence card names the assumptions that move the result most (from the tornado) and are still estimates: **check these first**.

**Staff hourly costs** (`data/labour.json`) come from official statistics, fully loaded with employer on-costs:

| Region | Statistic | Period | On-costs |
|---|---|---|---|
| United States | BLS ECEC, office and administrative support, total compensation per hour | June 2026 | included |
| Eurozone (8 countries) | Eurostat average hourly labour cost, whole economy (`lc_lci_lev`) | 2025 (Belgium 2024) | included |
| United Kingdom | ONS ASHE median hourly earnings, full time | April 2025 | employer NI 15% above £5,000 + 3% pension (verified): × 1.156 |
| Canada | Statistics Canada LFS average hourly wage | September 2026 | × 1.10 (estimate) |
| Australia | ABS full-time adult ordinary time earnings ÷ 38 hours | May 2026 | 12% super guarantee (verified): × 1.12 |
| Switzerland | FSO median gross monthly wage ÷ 173.2 hours | 2024 | × 1.15 (estimate) |
| India | PLFS 2025 regular wage/salaried monthly earnings (mean of men's and women's figures) ÷ 192 hours | 2025 | × 1.13 EPF (estimate) |
| UAE | No official statistic found | — | sample value (estimate) |

These are whole-economy or occupation-group averages, a proxy for the person doing the work today; your own payroll figure is better. The US engineer cost uses BLS "professional and related" total compensation ($74.42/hour); other regions' engineer costs are still estimates. A test checks that `labour.json` and the region defaults agree.

**Keeping the data current** (`.github/workflows/data-refresh.yml`). Every Monday a workflow:

- cross-checks each AI model price (`scripts/update-prices.mjs`) against OpenRouter's price for that provider's own endpoint and LiteLLM's model price file. Prices match within 0.5% rounding (an introductory price counts while it runs). When both sources agree on a different price, and the change is under 80%, the price is updated; batch and cached prices that neither source reports are scaled by the same ratio. Anything else (the sources disagree, only one reports it, a large change, an introductory period) is listed and never changed;
- refreshes labour costs (`scripts/update-labour.mjs`) from the Eurostat `lc_lci_lev` API (eight euro-area countries) and the BLS ECEC API (US staff, series `CMU1010000220000D`, and engineers, `CMU1010000120000D`). Changes over 25% are listed, not applied. USD figures are recalculated when the exchange rate has moved more than 2% since they were computed. The other countries' statistics have no open API and are listed for a manual check;
- runs the tests on the result and opens a pull request whose description lists every change with links to the official price pages. Nothing reaches the site until a person merges it. When nothing changed but something needs a look, it updates an issue instead.

**Token counts** (`scripts/count-tokens.mjs`, `data/samples`, `data/token-measurements.json`). Four representative sample texts (a chatbot request with knowledge-base excerpts, a two-page invoice, a support ticket, a report step with a month of data) are counted. Without an API key the script estimates (characters ÷ 4); with `GEMINI_API_KEY` set it measures with Google's free `countTokens` endpoint, and the register marks the counts verified. By the estimate, the samples come out at 0.3–0.6 × the current defaults; the defaults are kept (higher token counts are the conservative direction for API cost) until measured counts are available.

## 13. Tax (`engine/tax.js`, `data/taxes.json`)

Vendor prices exclude indirect tax. Each country has one or more tax variants (for example Canadian provinces, or US states that do or do not tax SaaS). Each variant lists its components with a rate, whether it is reclaimable, and an official source.

```math
\begin{aligned}
\text{counted}(\text{component}) &= \text{not reclaimable, or the business is not registered or is exempt} \\
\text{non-reclaimable rate} &= \textstyle\sum \text{rates of the counted components} \\
\text{tax line}(\text{option}) &= (\text{option monthly} - \text{labour}) \times \text{non-reclaimable rate}
\end{aligned}
```

| Country | Tax on cloud / SaaS purchases | Reclaimable by a registered business? |
|---|---|---|
| India | GST 18% (IT / OIDAR services) | Yes (input tax credit) |
| United States | State + local sales tax, where the state taxes SaaS (you enter the rate) | No |
| Canada | GST 5% or HST 13–15% by province; plus QST 9.975% (Quebec) or PST/RST 6–7% (BC, Saskatchewan, Manitoba) | GST/HST/QST yes; PST/RST no |
| Australia | GST 10% | Yes |
| UAE | VAT 5% | Yes |
| United Kingdom | VAT 20% | Yes |
| Switzerland | VAT 8.1% | Yes |
| Eurozone | VAT: DE 19%, NL 21%, IE 23%, FR 20%, BE 21%, AT 20%, FI 25.5%, LU 17% | Yes |

Labour (build and maintenance hours) is treated as in-house staff and carries no tax. Healthcare and education presets default to "not reclaimable" because those sectors are often VAT/GST-exempt. Rates that could not be checked against an official page are flagged as samples and listed by the weekly price check. This is not tax advice.

The API vs self-hosting break-even applies the same tax to external spend on both sides.

## 14. Exchange rates

`data/fx.json` holds units of each currency per 1 USD, derived from the ECB euro reference rates (`rate_X_per_USD = EUR_X / EUR_USD`). The ECB does not publish AED, so AED uses its fixed peg of 3.6725 per USD. A weekly workflow updates the file through a pull request and refuses any rate that moved more than 15% since the last update.
