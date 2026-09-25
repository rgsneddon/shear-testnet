# DINS share-DAG

Fail-closed. `DINS_ENABLED` in `crypto/share_dag.js` is false. pool/src and
node/src do not import this model. The live sealer does not call `sealShareDag`.

Membership is the blue set. Arrival order does not change the payout.
Omitting an eligible foreign blue returns `omit_eligible_foreign`.
A passing seal pays the spine pot once plus each eligible share's hash nanos
once. That is the sole mint (pot + hash). `soleMint` rejects a pull-book hash
credit together with those leaves. With the flag off, the pool still books
the lag-1 round and does not call the seal.

Share relay budgets, when a later enable adds them, are
`SHARE_STEM_MAX_HOPS`, `SHARE_FLUFF_MIN_MS`, and `SHARE_FLUFF_MAX_MS`.
Payment `STEM_MAX_HOPS`, `FLUFF_MIN_MS`, and `FLUFF_MAX_MS` stay 3, 1000, 3000.
