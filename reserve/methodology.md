# shear-reserve-oracle-v1

Off-chain collector + on-chain feed spec for The Reserve. This is the official-policy index `reservePolicyAverage`. It is **not** a market-overnight feed.

Adding or removing a basket name requires a version bump to **v2**.

## Basket (frozen, 14)

| # | id | Institution | Official rate used |
|---|-----|-------------|--------------------|
| 1 | FED | United States — Federal Reserve | federal funds **target range** (median of lower and upper) |
| 2 | BOE | United Kingdom — Bank of England | Bank Rate |
| 3 | ECB | Euro area — European Central Bank | standing policy corridor: **deposit facility** (lower) and **main refinancing operations** (upper); median of those two. Do **not** use the marginal lending facility |
| 4 | BOJ | Japan — Bank of Japan | policy rate |
| 5 | BOC | Canada — Bank of Canada | overnight target |
| 6 | RBA | Australia — Reserve Bank of Australia | cash rate target |
| 7 | RBNZ | New Zealand — Reserve Bank of New Zealand | OCR |
| 8 | SNB | Switzerland — Swiss National Bank | SNB policy rate |
| 9 | RIKSBANK | Sweden — Sveriges Riksbank | policy rate |
| 10 | NORGES | Norway — Norges Bank | policy rate |
| 11 | DNBANK | Denmark — Danmarks Nationalbank | policy rate |
| 12 | BOK | South Korea — Bank of Korea | base rate |
| 13 | BOI | Israel — Bank of Israel | policy rate |
| 14 | CNB | Czech Republic — Czech National Bank | two-week repo rate |

## Official source URLs

| id | URL |
|----|-----|
| FED | https://www.federalreserve.gov/monetarypolicy/openmarket.htm |
| BOE | https://www.bankofengland.co.uk/monetary-policy |
| ECB | https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html |
| BOJ | https://www.boj.or.jp/en/mopo/outline/index.htm |
| BOC | https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/ |
| RBA | https://www.rba.gov.au/statistics/cash-rate/ |
| RBNZ | https://www.rbnz.govt.nz/monetary-policy/official-cash-rate-decisions |
| SNB | https://www.snb.ch/en/the-snb/mandates-goals/monetary-policy/strategy |
| RIKSBANK | https://www.riksbank.se/en-gb/monetary-policy/the-interest-rate/ |
| NORGES | https://www.norges-bank.no/en/topics/Monetary-policy/Policy-rate/ |
| DNBANK | https://www.nationalbanken.dk/en/what-we-do/stable-prices-in-denmark |
| BOK | https://www.bok.or.kr/eng/main/contents.do?menuNo=400016 |
| BOI | https://www.boi.org.il/en/economic-roles/monetary-policy/ |
| CNB | https://www.cnb.cz/en/monetary-policy/instruments/ |

Optional public API **patterns** (no secrets): FRED `DFEDTARL`/`DFEDTARU` (Fed range bounds only — not `DFF` effective funds); BoE statistical API Bank Rate series. See `sources.json`.

## Rate normalisation

- Single official base rate: use that number.
- Lower and upper official levels: **median** of the range. Fed example: 3.50–3.75 → 3.625. ECB v1 corridor: median(deposit facility, MRO), not the marginal lending facility.

## Integer scale (canonical)

Internals and the contract encoding use **tenths of a basis point** (integer):

- 1% = 100 bp = **1000** tenths-bp
- 3.625% = 362.5 bp = **3625** tenths-bp

`averageInteger` in `latest.json` is this integer. `averageScale` is the string `tenths_of_basis_point`.

`reservePolicyAverage` = unweighted arithmetic mean of the 14 normalised tenths-bp integers, rounded **half-up** to the nearest integer. That integer **is** the 3-decimal-percent encoding: `averagePercent = averageInteger / 1000` (half-up to 3 decimal places, which matches the integer).

## Update rule

`reservePolicyAverage`, the 14-component vector, and `asOf` **must not** change because a calendar day elapsed.

They may change **only when** one or more basket institutions publish a new official base rate, or a new official range whose median differs.

Between official changes: repeat the last average, last component vector, and last `asOf`. `observedAt` may refresh. `changed` is false and `changedBanks` is empty.

Do **not** ingest SOFR, SONIA, €STR, TONA, CORRA, SARON, AONIA, effective federal funds, or any other market overnight print into this series.

## Example (fixture `snapshot_a`)

Fed 3.50–3.75 → 3.625. Fourteen tenths-bp values sum to 36900; half-up mean `36900 / 14` = **2636** tenths-bp = **2.636%**.
