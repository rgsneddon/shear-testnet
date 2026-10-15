# Genesis basket, observed 15 October 2026

`GENESIS_BPS` was the placeholder **284**. Recomputed from the official policy rates below, just before the v12 cut. The chain does not fetch these pages. The attested integers live in `crypto/reserve_oracle.js` (`BUNDLED_POLICY_TENTHS`) and match `reserve/latest.json`.

Spec (`reserve/methodology.md`): 14 banks, tenths of a basis point (1% = 1000). Fed is the median of the federal funds target range. ECB is the median of the deposit facility and the main refinancing rate, not the marginal lending facility. Denmark's policy rate is the current-account rate. Drop the two lowest and two highest tenths, half-up the middle 10, half-up to whole basis points, then floor at 0.

Sorted tenths: 0, 1250, 1750, 2100, 2250, 2575, 2750, 3000, 3250, 3750, 3750, 3875, 4500, 4600. Drop SNB and BOJ (low) and NORGES and RBA (high). Middle sum **29050**. Half-up ÷ 10 = **2905** tenths. Half-up ÷ 10 = **291** bps.

| id | Official rate | Tenths | Effective | Source |
|----|---------------|--------|-----------|--------|
| FED | 3.75–4.00 (median 3.875%) | 3875 | 2026-09-17 | https://www.federalreserve.gov/monetarypolicy/openmarket.htm |
| BOE | Bank Rate 3.75% | 3750 | 2026-09-17 (held; level since 2025-12-18) | https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate |
| ECB | deposit 2.50, MRO 2.65 (median 2.575%) | 2575 | 2026-09-16 | https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html |
| BOJ | uncollateralized overnight call rate around 1.25% | 1250 | 2026-09-24 (decision 2026-09-18) | https://www.boj.or.jp/en/mopo/mpmdeci/mpr_2026/k260918a.pdf |
| BOC | overnight target 2.25% | 2250 | 2026-09-02 (held; level since 2025-10-30) | https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/ |
| RBA | cash rate target 4.60% | 4600 | 2026-09-30 | https://www.rba.gov.au/statistics/cash-rate/ |
| RBNZ | OCR 2.75% | 2750 | 2026-09-02 | https://www.rbnz.govt.nz/monetary-policy/about-monetary-policy/the-official-cash-rate |
| SNB | SNB policy rate 0.00% | 0 | 2025-06-20 (held 2026-09-24) | https://www.snb.ch/en/the-snb/mandates-goals/statistics/statistics-pub/current_interest_exchange_rates |
| RIKSBANK | policy rate 1.75% | 1750 | 2026-09-30 (held; level since 2025-10-01) | https://www.riksbank.se/en-gb/statistics/interest-rates-and-exchange-rates/policy-rate-deposit-and-lending-rate/ |
| NORGES | policy rate 4.50% | 4500 | 2026-09-25 (decision 2026-09-23) | https://www.norges-bank.no/en/topics/monetary-policy/Monetary-policy-meetings/2026/september-2026 |
| DNBANK | current-account rate 2.10% | 2100 | 2026-09-11 | https://www.nationalbanken.dk/en/news-and-knowledge/press/archive/2026/interest-rate-increase-10-09-2026 |
| BOK | Base Rate 3.00% | 3000 | 2026-08-27 (next meeting 2026-10-22) | https://www.bok.or.kr/eng/bbs/E0000634/view.do?nttId=11064193&menuNo=400069 |
| BOI | interest rate 3.25% | 3250 | 2026-09-01 (next decision 2026-10-21) | https://boi.org.il/en/communication-and-publications/press-releases/01-9-26-en/ |
| CNB | two-week repo rate 3.75% | 3750 | 2026-06-19 (held 2026-08-06 and 2026-09-17) | https://www.cnb.cz/en/monetary-policy/instruments/ |

Old genesis rate: **284** bps. New genesis rate: **291** bps.
