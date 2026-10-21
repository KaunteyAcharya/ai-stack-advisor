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

```
requests_per_month(m)      = users_per_day × requests_per_user × 30 × (1 + growth)^min(m, growth_months)
conversations_per_month(m) = users_per_day × 30 × (1 + growth)^min(m, growth_months)   (or the value you enter)
```

**Growth stops** after `growth_months` (default 12); volume is flat afterwards. Without this, 5% a month for 36 months grows volume about 5.8×, and the 36-month total depends mostly on the growth guess. Every report also shows **TCO-36 with no growth** next to the grown figure.

**Document processing.** One request per document. Users per day count only toward seat pricing unless "chat over documents" is on.

```
requests_per_month(m)  = documents_per_month × (1 + growth)^m
input_tokens per doc   = pages_per_doc × tokens_per_page
output_tokens per doc  = output tokens per document
```

With **chat over documents**, chat requests (`users_per_day × requests_per_user × 30`) are added, each with the chat token counts. Cost stays exact because the average tokens per request are weighted by request count, and LLM cost is linear in tokens. Nothing is counted twice.

**Peak load** (sizes self-hosted GPUs):

```
peak_requests_per_sec = (requests_per_month / 30) × peak_share / 3600
```

## 2. Option B: API-based (`apiMonthly`)

```
llm_cost_per_request = (in_tokens × (1 − c) × in_price + in_tokens × c × cached_price + out_tokens × out_price) / 1,000,000
llm_monthly          = requests_per_month × llm_cost_per_request
api_monthly          = llm_monthly + managed_db + hosting + vector_db (if RAG)
                       + voice (if voice agent) + OCR (if set) + maintenance_hours_B × engineer_hourly
```

The quality need picks the model tier: `basic` → budget tier, `good` → mid tier, `best_available` → premium tier (`data/prices.json`).

**Prompt caching.** `c` is the share of each request's input that repeats across requests (system prompt, instructions, earlier agent steps) and is served from the provider's cache at the published cached-input price (Gemini 2.5: $0.01 / $0.03 / $0.125 per 1M tokens for Flash-Lite / Flash / Pro). Caching only applies when the average prompt is at least the provider's minimum (2,048 tokens), so short chatbot prompts get no discount. Defaults: 40% for chat and voice, 30% for internal tools, 10% for documents, 40–50% for agents. Storage fees for explicit caches are not modelled; self-hosted prefix caching is not modelled (conservative for options C and D).

## 3. Voice add-on (`voiceMonthly`): voice agents only, every option

```
voice_minutes  = conversations_per_month × minutes_per_conversation
tts_per_minute = tts_price_per_1k_chars × spoken_chars_per_minute / 1000     (assumption: 750 chars/min)
voice_monthly  = voice_minutes × (stt_per_min + tts_per_min + telephony_per_min)
```

Self-hosted speech-to-text and text-to-speech run on the rented GPUs, so the self-hosted option pays **telephony only**. In the hybrid option, the self-hosted share pays telephony only and the API share pays all three.

## 4. Option C: Self-hosted (`selfhostMonthly`, `engine/capacity.js`)

The GPU choice is an explicit chain of **assumptions** in `data/selfhost.json`:

| Quality need | Model size class | VRAM needed | Cheapest GPU that fits |
|---|---|---|---|
| basic | ~8B, 16-bit | 22 GB | L4 24 GB |
| good | ~32B, 4-bit | 40 GB | L40S 48 GB |
| best_available | ~70B, 4-bit | 64 GB | A100 80 GB |

Throughput per GPU class (output tokens/second, batched serving) is also an assumption, stored in `prices.json` as `gpu_throughput`. Open-weight models may trail frontier models on some tasks, so test on your own data.

```
required_tok_per_sec = peak_requests_per_sec × output_tokens
gpus = max(1, ceil(required_tok_per_sec × headroom(1.3) × overhead / gpu_tokens_per_sec))
overhead = 1.3 for a voice agent with real-time latency, else 1
if uptime == high_availability: gpus = max(gpus, 2)

gpu_monthly      = gpus × gpu_hourly × 730            (always on)
ops_monthly      = maintenance_hours_C × engineer_hourly
selfhost_monthly = gpu_monthly + self_managed_db + storage + monitoring + ops_monthly
                   + telephony (voice) + OCR (if set)
```

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

```
hybrid_monthly = selfhost(sized for share_self of peak, ops = maintenance_hours_D)
               + llm_monthly × (1 − share_self)
               + managed_db + hosting + vector_db (if RAG) + voice + OCR
```

**Automatic split.** When you leave the share blank (the default), the engine computes option D's 36-month cost for `share_self` = 10%, 20% … 90% and uses the cheapest. You can also set the share yourself. If data may not leave the company, the hybrid is limited to its self-hosted share (`share_self = 100%`).

## 7. One-time and maintenance costs

| Option | Build hours | Maintenance hours/month |
|---|---|---|
| A. SaaS | 20 | 4 |
| B. API | 120 | 10 |
| C. Self-hosted | 240 | 30 |
| D. Hybrid | 300 | 35 |

`one_time = (build_hours + evaluation_hours) × engineer_hourly`. Evaluation hours (A 8, B 16, C 32, D 32) cover testing quality on your own data before launch; open models need more testing. All of these are editable assumptions. The default engineer hourly cost comes from the region and is a sample value.

## 8. Total cost of ownership (`engine/tco.js`)

```
TCO_12 = one_time + Σ monthly_cost(m), m = 0..11
TCO_36 = one_time + Σ monthly_cost(m), m = 0..35
```

Monthly cost is recomputed every month with the grown volume, so the GPU count (and SaaS tier) can step up.

**Present value.** Options are ranked on present value, not the plain total, because money spent in year 3 is worth less than money spent now:

```
PV_36 = one_time + Σ monthly_cost(m) / (1 + r)^((m + 1) / 12),  m = 0..35      (r = annual discount rate, default 10%)
```

## 9. Break-even: API vs self-hosting (`engine/breakeven.js`)

```
fixed_selfhost_monthly = gpu_monthly(1 GPU, or 2 for high availability) + ops_monthly + self_managed_db
api_cost_per_request   = llm_cost_per_request + per-request share of hosted voice (STT + TTS)
breakeven_requests     = fixed_selfhost_monthly / api_cost_per_request
```

The **cost-vs-volume curve** recomputes every option's month-1 cost at 41 log-spaced volumes from 1,000 to 10,000,000 requests/month. Crossovers are found where two curves change order, interpolated in log-volume.

## 10. Value and ROI (`engine/value.js`)

Headline figures are **conservative**: they use the gross profit on a **first sale** only.

```
gross_profit_per_sale        = ticket × margin
value_per_conversation       = gross_profit_per_sale × conversion_rate
acceptable_ai_cost_per_conv  = value_per_conversation × target_share
ai_cost_per_conversation     = option_monthly / conversations_per_month
sales_per_month              = conversations_per_month × conversion_rate
ai_cost_per_sale             = option_monthly / sales_per_month
ai_cost_pct_of_ticket        = ai_cost_per_sale / ticket
breakeven_extra_sales        = option_monthly / gross_profit_per_sale      (shown rounded UP)
breakeven_uplift_pp          = breakeven_extra_sales / conversations_per_month × 100
support_savings              = conversations_per_month × human_share × deflection × human_cost_per_conversation
roi(uplift_pp)               = (extra_sales(uplift) × gross_profit_per_sale + support_savings − option_monthly) / option_monthly
payback_months(uplift_pp)    = one_time / net_monthly_benefit      ("never" if benefit ≤ 0)
```

`human_share` is the share of conversations that reach a person today (default 20%, set per industry preset). Without it, every chatbot conversation would count as a saved human conversation, which overstates savings for high-volume chat.

**LTV line (repeat buyers).** The second figure uses the value a new customer brings over 12 months:

```
customer_value_12m      = gross_profit_per_sale × purchases_per_year       (or the value you enter)
ltv_customers_needed    = ceil(option_monthly / customer_value_12m)
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

**Tokens per task.** A task runs `s` LLM steps. Each step re-reads the base prompt plus everything produced so far:

```
input(step i)        = base + (i − 1) × growth
average input / call = base + growth × (s − 1) / 2
LLM calls / month    = tasks × s        (+ replies, for the content engine)
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

```
hours_saved   = tasks × success_rate × minutes_per_task / 60
review_hours  = tasks × review_share × review_minutes / 60
net_hours     = hours_saved − review_hours            FTE = net_hours / hours_per_FTE
benefit       = net_hours × staff_hourly − tasks × error_rate × cost_per_error
net           = benefit − AI monthly cost              payback = build cost / net
break-even success rate = (AI cost + review cost + error cost) / (tasks × minutes / 60 × staff_hourly) × 100
```

Staff hourly cost and hours per FTE (160, or 192 in India) come from the region and are sample assumptions. A sensitivity table shows the result at 50%, 70% and 90% completion. Agent use cases use the profile `automation`, with a cost weight of 50%.

## 10c. Internal tools (data assistant, internal copilot)

Internal tools don't make sales, so they are valued on **staff time saved**:

```
hours_saved = requests × minutes_saved_per_request / 60        (default 3 minutes, editable)
benefit     = hours_saved × staff_hourly
break-even minutes per request = AI monthly cost / (requests / 60 × staff_hourly)
```

Per-seat SaaS for internal tools charges a seat for every daily user (`max(seats, users per day)`). A sensitivity table shows the result at half and double the minutes saved.

## 10d. Several workloads: one stack or a mix (`engine/portfolio.js`)

Any number of workloads, up to one per use case (11), are compared together, for example a chatbot, a data assistant and an invoice agent. Country, data rules, team, tax and growth are shared; use case, volume, quality and value are per workload.

**Up to 5 workloads, every combination** of options and workloads is evaluated (4ⁿ, at most 1,024; options a workload can't use are skipped). **From 6 workloads** (4¹¹ ≈ 4 million combinations), a local search starts from each single stack and from each workload's own best option, then moves one workload at a time to another option while the score improves; the report says how many combinations it checked. On five workloads it finds the same answer as the full search (tested). Workloads on the same stack share its fixed costs:

```
stack_monthly = Σ workload usage costs (LLM, voice, media, OCR, per-task fees, SaaS plans)
              + shared infrastructure once (databases, hosting, vector DB, storage, monitoring)
              + pooled GPUs (C, D): ceil(Σ peak tokens/sec × headroom / throughput of the largest model needed)
              + maintenance hours × (1 + (n − 1) × extra_effort) × engineer_hourly
build cost    = build hours × (1 + (n − 1) × extra_effort) × engineer_hourly      (per stack)
extra_effort  = 50% by default
```

Mixing stacks therefore pays each stack's base build and maintenance effort, which is the real cost of running two vendors and two skill sets.

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

Each option gets a score from 0 to 5 per criterion. The default weights are privacy 25%, time to launch 20%, team fit 20%, quality 15%, lock-in 10% and scalability 10%; all are adjustable.

```
non_cost_score = Σ(weight × score) / (5 × Σ weight)          → 0..1
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
| Time to launch | A | 5 | Configure and launch in days. |
| Time to launch | B | 4 | A few weeks of integration work. |
| Time to launch | C | 2 | GPU setup, model serving and evaluation take months. |
| Time to launch | D | 1 | Needs both the API build and the self-hosted stack, plus routing. |
| Team capability fit | A | 5 | Needs almost no engineering. |
| Team capability fit | B | 4 | Needs at least one developer. |
| Team capability fit | C | 3 | Needs DevOps/MLOps skills to run GPUs. |
| Team capability fit | D | 3 | Needs DevOps/MLOps skills plus API integration. |
| Quality fit | A | 4 | Good vendor models, limited customisation. |
| Quality fit | B | 5 | Direct access to frontier models. |
| Quality fit | C | 4 | Open models are good for routine tasks. |
| Quality fit | D | 4 | Frontier models for hard requests, open models for routine ones. |
| Vendor lock-in (higher = less lock-in) | A | 1 | Workflows, data and pricing tied to one vendor. |
| Vendor lock-in (higher = less lock-in) | B | 3 | Prompts are portable, but the code targets one provider's API. |
| Vendor lock-in (higher = less lock-in) | C | 5 | Open weights; you can move providers any time. |
| Vendor lock-in (higher = less lock-in) | D | 4 | Mostly portable; the API part can be swapped. |
| Scalability | A | 3 | Scales, but cost rises with volume and plan limits. |
| Scalability | B | 5 | Provider scales automatically. |
| Scalability | C | 3 | You add GPUs yourself as traffic grows. |
| Scalability | D | 4 | API absorbs peaks above self-hosted capacity. |

### Rules

| Rule | Effect | Reason |
|---|---|---|
| `data_must_stay` | exclude A, B; note D | SaaS and API send data outside the company, which the requirement forbids. |
| `no_training_only` | privacy: A-1, B-1; note A, B | Only paid tiers with no-training terms are allowed, which narrows vendor choice. |
| `personal_data_external` | privacy: A-1, B-1; note B | Personal data at an external provider adds compliance work. |
| `residency_required` | privacy: A-1, B-1; note A, B | External vendors may not offer processing in the required region. |
| `no_engineers` | teamFit: B=1, C=0, D=0; warn B, C, D | Custom builds need engineers the company does not have. |
| `small_team` | teamFit: B=5 | A small team handles an API build comfortably. |
| `no_devops` | teamFit: C=1, D=1; warn C, D | Running GPUs without DevOps/MLOps skills is high-risk. |
| `strong_devops` | teamFit: C=5, D=4 | Strong DevOps makes self-hosting a good team fit. |
| `best_quality` | quality: C=2, D=3; note C | Open models may trail frontier models when the best quality is needed. |
| `open_model_gap` | note C | Open models may trail frontier models; worth testing before committing. |
| `basic_quality` | quality: C=5, D=5 | Open models are fully adequate for basic quality needs. |
| `realtime_voice` | scalability: C-1; note C | Real-time voice on a small GPU pool risks latency at peak. |
| `ha_without_devops` | scalability: C-1, D-1; note C | High availability needs on-call operations. |
<!-- SCORING-TABLE:END -->

## 12. Recommendation (`engine/recommend.js`)

```
decision_cost = PV_36 + PV of the value given up through lower answer quality
cost_score    = lowest decision_cost among viable options / this option's decision_cost     → 0..1
final_score   = cost_weight × cost_score + (1 − cost_weight) × non_cost_score
cost_weight   = 50%, or 25% for high-ticket profiles (adjustable)
```

**Quality-adjusted cost.** Open-weight models may complete fewer tasks than frontier API models. The **open-model quality gap** (default 10 percentage points, an assumption you should replace with your own evaluation) lowers, for self-hosted (and for the hybrid's self-hosted share): the completion rate of agents, the minutes saved by internal tools, and the deflection rate (support savings) of chat. The benefit an option loses compared with the best option, grown with volume and discounted like costs, is added to its decision cost. The comparison table shows this as "Decision cost". Several workloads (section 10d) are ranked on present value; the quality gap is not yet applied there.

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
| Open-model quality gap | 0 points | your value | max(20, your value) |
| Inputs you marked "Not sure" | band from section 10e | your value | band from section 10e |

The report shows how often each option is recommended ("Robust" at 90% or more, otherwise "Close call"), and the 10th, 50th and 90th percentiles of the recommended option's monthly cost, net monthly benefit and 36-month present value. Net benefit is time saved (agents, internal tools) or support savings with no sales uplift (chat), minus AI cost. Runs are seeded, so the same inputs always give the same result. Quantities are drawn independently; correlations (e.g. all prices rising together) are not modelled.

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

**Token counts** (`scripts/count-tokens.mjs`, `data/samples`, `data/token-measurements.json`). Four representative sample texts (a chatbot request with knowledge-base excerpts, a two-page invoice, a support ticket, a report step with a month of data) are counted. Without an API key the script estimates (characters ÷ 4); with `GEMINI_API_KEY` set it measures with Google's free `countTokens` endpoint, and the register marks the counts verified. By the estimate, the samples come out at 0.3–0.6 × the current defaults; the defaults are kept (higher token counts are the conservative direction for API cost) until measured counts are available.

## 13. Tax (`engine/tax.js`, `data/taxes.json`)

Vendor prices exclude indirect tax. Each country has one or more tax variants (for example Canadian provinces, or US states that do or do not tax SaaS). Each variant lists its components with a rate, whether it is reclaimable, and an official source.

```
counted(component)   = not component.reclaimable  OR  business is not registered / is exempt
non_reclaimable_pct  = Σ rate of counted components
tax_line(option)     = (option_monthly − labour) × non_reclaimable_pct
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
