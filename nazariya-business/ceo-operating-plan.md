# Nazariya: CEO operating plan (first 90 days, then 12 months)

Written 2026-10-17. The numbers come from `nazariya-unit-economics.xlsx` (all prices ex-GST). Anything marked *assumption* must be replaced with real data from the first 20 paid jobs.

## 1. What we sell and why it makes money

**One sentence:** "Your buyers walk through the flat on your website before they visit. We shoot it, or you shoot it with your phone, and it goes live in a day."

Unit economics: software costs us almost nothing; people cost money.
- **A self-captured home tour costs us about ₹2 for a year** of processing, storage and delivery: 3.9 MB raw and 15 s of CPU per room, measured on your capture.
- **A done-for-you tour costs about ₹680** (capturer time ₹313, ops review ₹125, camera wear ₹92, travel ₹150).
- So the business is limited by **sales and capture capacity**, not servers.
- **Margins:** 74% on a done-for-you tour (after 10% commission and 2% payment fees), 84–91% on subscriptions.

| Price point (ex-GST) | Price | Our cost | Contribution |
|---|---|---|---|
| DIY home tour, 12 months | ₹999 | ₹2 | ₹977 |
| Done-for-you home tour (≤3BHK) | ₹4,999 | ₹681 | ₹3,718 |
| Villa / large home | ₹9,999 | ₹1,120 | ₹7,680 |
| 3D walkthrough add-on (after GPU validation) | ₹2,999 | ₹179 | ₹2,760 |
| Developer project package / year | ₹49,999 | ₹21,514 | ₹22,485 |
| Hotel package / year | ₹24,999 | ₹6,163 | ₹15,836 |
| Starter / Pro / Business plan per month | ₹1,499 / ₹4,999 / ₹12,999 | ₹135 / ₹574 / ₹2,105 | 91% / 89% / 84% margin |

**Positioning against public prices:**
- TeliportMe is US$19–99/month and Kuula US$20–48/month: software only, no capture, no floor plan measured from depth.
- Matterport is about US$12–355/month and needs its own capture hardware.
- One Indian agency asks ₹1,00,000 per tour.
- We sit between "cheap software you must operate yourself" and "expensive agency shoot". Our edge is guided phone capture plus depth-measured floor plans and a path to true 3D (TeliportMe also supports phone capture, so don't claim to be the only one).

## 2. Fastest money (weeks 1–6): sell the service, not the software

Do not wait for the SaaS to be "finished". The 360° product works today. Sell **done-for-you tours** and **developer and hotel packages** for cash.

| Week | Action | Target |
|---|---|---|
| 1 | Shoot 3 **free showcase tours** in your city: a builder sample flat, a hotel, a premium resale flat. Ask each owner for a testimonial and permission to show it. | 3 live demos |
| 1–2 | Make a list of 100 prospects: new launches in your city (each state's RERA portal lists every registered project and its promoter), the top 30 resale/rental brokers on 99acres/MagicBricks with 50+ listings, 20 hotels/resorts, 20 co-living/PG operators. | 100 names in a sheet |
| 2–6 | **10 visits or calls a day.** Show the tour on your phone, then their own flat on the spot (shoot one room in 3 minutes). Close with: "First flat ₹2,999 this month, then ₹4,999." | 30 meetings → 8–10 paid jobs |
| 3 | **Founding-customer offer for developers:** ₹29,999 for the first project (normally ₹49,999), paid 50% upfront, in exchange for a case study. | 1–2 developers |
| 4–6 | Every broker who buys 3+ tours gets offered Pro at ₹4,999/month. That converts one-off cash into recurring revenue. | 2–3 subscribers |

**Why developers first:**
- One sample flat costs a developer far more than our package. The tour lets out-of-city and NRI buyers "visit" before travelling, and it lives on their website and in WhatsApp campaigns.
- Price on the value of one extra site visit or booking, not on our cost.

**Cash rules:**
- 50% advance on every service job.
- UPI or Razorpay payment link on the spot.
- GST invoices once registered. Registration becomes compulsory above the turnover threshold (₹20 lakh for services in most states); confirm with a CA, since many developers will only pay GST invoices anyway.

## 3. 12-month plan (from the `Plan12M` sheet; edit the blue cells)

**Base case:**
- Monthly revenue grows from ₹25k (M1) to about ₹9 lakh (M12), about ₹55 lakh across 12 months.
- Monthly profit turns positive from M3, assuming founders take no salary.
- Cash never drops below ₹2.3 lakh if you start with ₹3 lakh.

**Downside (set `vol_scale` = 0.5):**
- Revenue is about ₹27 lakh across 12 months.
- Cash goes about ₹2.7 lakh negative by M9.
- So **raise or win at least ₹5–10 lakh of non-dilutive money before hiring the engineer in M5**.

**Break-even** (`BreakEven` sheet): lean costs (₹61k/month, no salaries) need 17 done-for-you tours a month. A full team (2 sales, 1 engineer, 1 ops lead: ₹2.61 lakh/month) needs about 70 tours, or about 59 Pro subscribers, or about 12 developer packages a month.

## 4. Raising money (in this order: cheapest money first)

1. **Revenue** (above). Ten paying customers make every later step easier and raise your valuation.
2. **Non-dilutive grants:**
   - Incorporate a Private Limited company and get **DPIIT recognition**, which is free.
   - Then apply to the **Startup India Seed Fund Scheme** through an incubator. It offers **up to ₹20 lakh as a grant** for proof of concept and product trials, and up to ₹50 lakh as debt or convertible for market entry. The startup must be under 2 years old. Check seedfund.startupindia.gov.in for current rules.
   - Also check your state startup policy (most states run seed grants), and university incubators (IIT/IIM/AIC) for an incubation seat.
3. **Proptech accelerator: Brigade REAP** (Bengaluru, Brigade Group).
   - It is a 16-week programme with pilots with Brigade Group and other developers, plus investor access.
   - It wants an MVP or early transactions; applications are reported as rolling.
   - A pilot with a large developer is worth more than the cheque.
4. **Angels / pre-seed** (after 10+ customers and about ₹3–5 lakh MRR or strong pilots):
   - Target ₹75 lakh–₹1.5 crore at a pre-seed valuation, through Indian angel networks and syndicates and real-estate operators as angels.
   - Antler, which backed Nucleus4D's US$1.5M pre-seed (research ledger E09), also runs an India programme. Verify its current cohort dates.
5. **Use of funds:** 2 sales executives + 1 capture-ops lead + 1 engineer for 12–15 months, plus a validated GPU 3D pipeline and a native iPhone LiDAR capture app.

**Pitch in 6 lines:**
1. Problem: buyers waste site visits, and developers pay for sample flats and brokers for viewings.
2. Product: phone-captured 360° and 3D tours with measured floor plans, embedded on the seller's own site.
3. Proof: N paying customers, ₹X MRR, Y% of viewers enquire.
4. Unit economics: 74–91% gross margin, near-zero software cost per tour.
5. Why us, why now: phone depth sensing plus Gaussian splats make Matterport-class tours possible without dedicated capture hardware. Nucleus4D raised US$1.5M doing this with a rig in the US. In our research we found no Indian product combining phone capture, depth-measured floor plans and 3D (re-check before pitching).
6. Ask and use of funds.

## 5. Team (hire in this order; pay for output)

| When | Role | Cost (*assumption*) | Why |
|---|---|---|---|
| Now | **You: CEO + first salesperson** | — | Founder-led sales for the first 20 customers. Don't delegate it. |
| Now | **Claude Code as engineering** | subscription | Product work, the production blockers list, test automation. |
| Month 1 | **Freelance capturers** (photographers, local students) | ₹300–400 per home, per shoot | Variable cost; trained on the in-app guide + tripod |
| Month 2 | **Sales / BD executive** (real-estate background) | ₹30–35k + 10% commission | Broker and developer calls; target 8+ jobs/month each |
| Month 4 | **Ops lead** | ₹25–30k | QA every tour, onboarding, support, capturer scheduling |
| Month 5 (after grant/seed) | **Full-stack / 3D engineer** | ₹80k–1.2 lakh | Owns the GPU pipeline, native iOS LiDAR app, integrations |
| Advisors | 1 developer-side marketing head, 1 senior broker | 0.25–0.5% equity each, vesting | Introductions and pricing reality checks |

**If there is a co-founder:** split equity by commitment, with 4-year vesting and a 1-year cliff. Put it in a founders' agreement before any money comes in.

## 6. Weekly operating rhythm (how I'll run it with you)

- **Monday:** I update the pricing sheet and pipeline with last week's real numbers (jobs, capture time, GPU minutes, conversion) and re-check the break-even.
- **Daily:** you run 10 sales conversations; I fix the blockers in `production-readiness.md`, in order.
- **Friday:** we review three numbers: **paid jobs, MRR, cash in bank**. Plus one quality metric: share of tours with a capture warning.

## 7. Decisions only you can make (I can't do these for you)

1. **City to start in.** Pick one city and win it before expanding.
2. **Company:** incorporate a Pvt Ltd, open a current account, register for GST, apply for DPIIT recognition. You (with a CA) sign and pay for these.
3. **Final prices.** The sheet proposes them; you test them in the first 10 sales calls and tell me what customers said.
4. **Who to hire and how much equity to give.**
5. **Any message, email or application sent in your name.** I'll draft them; you send them.

## 8. Next 7 days

| Day | You | Me (engineering) |
|---|---|---|
| 1 | Pick the city. Book 3 free showcase shoots. Start the MSG91 DLT registration. | Private repo + CI, OTP env fix, per-IP rate limits |
| 2–3 | Shoot the 3 showcases (tripod!). Build the 100-prospect list. | Hosting + storage driver + monitoring, so showcases live on a real domain |
| 4–5 | 20 calls/visits with the showcase on your phone | Security headers, 404 for drafts, payment links |
| 6 | Rent a GPU for 2 hours (~₹120) with me | Run one real walkthrough → measure `gpu_min_walk` |
| 7 | Weekly review: jobs, cash, objections heard | Update the pricing sheet with real numbers |
