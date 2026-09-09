# Durable terminal notifications and first-rollout protocol

## Delivery contract

A terminal `jobs` row is the durable outgoing record; HTTP delivery does not invoke rendering, usage recording or quota settlement. Its persisted `result`/`error` survives a process restart. At the first claim, the worker freezes the JSON body and stable `X-DocMint-Delivery-Id` (`<job_id>:<terminal_status>`). Retries reuse that exact body and ID. Existing timestamp/HMAC, event, job-ID and content-type headers remain; each HTTP attempt receives a fresh timestamp/signature. Receivers should verify HMAC and deduplicate by delivery ID. Legacy requests have no delivery ID: **the first rollout must drain legacy writers before enabling this dispatcher**.

`GET /v1/jobs/{id}` and listings add `webhook.delivery_id` and `webhook.next_attempt_at`. Status is `delivering` while leased, `pending` after a retryable outcome, `delivered` after acknowledged success, and `failed` after exhaustion. Before first claim the legacy nullable status/ID are retained. Retries wait 4 seconds after failure1, 8 seconds after failure2 (attempt × 4 seconds for higher configured budgets). The attempt budget is `JOB_WEBHOOK_ATTEMPTS` (default3).

This is **bounded, at-least-once-style retry**, not exactly-once effects or unconditional receipt. An attempt is durably reserved before HTTP; a process crash or DB outage can consume that reservation without a send. Repeated crashes can exhaust the budget. Conversely, an acknowledged request whose DB receipt cannot be committed can be sent again. `interrupted` in the attempt history means the HTTP outcome was not durably established, not that the receiver definitely saw nothing. Exhausted and delivered history is not rearmed. Legacy `failed` rows with fewer recorded attempts than the configured budget resume only after staged cutover.

The lease is one total HTTP deadline plus1second. The actual transport deadline includes DNS validation and all redirect hops. After secret lookup, the worker revalidates/refreshes the lease and deducts the DB refresh round-trip from the available HTTP deadline. A replaced lease cannot authorize a late HTTP request or overwrite a newer receipt. Receipt persistence failure leaves a recoverable lease. Stop-the-world host pauses and receiver side effects are not exactly-once guarantees.

Stalled-render recovery and outstanding failed/cancelled refunds run on startup and every60seconds. The refund consumes the reservation and updates the account in one transaction; either both commit or both roll back. Recovery never retries a succeeded job's billing. A zero-charge recovery after a DB outage does not invent a second usage row. This patch does not claim to solve every crash window between rendering, storing files, settling usage and recording terminal results.

Pending/delivering jobs and outstanding refund reservations survive retention. A schema DELETE guard also protects those claims from the old binary's reaper during rollback. Intentional account deletion cascades still remove its jobs. File TTL is unchanged; long outages can leave a replayed result URL expired. The delivery guarantee does not extend file lifetime.

## First rollout: mandatory two-stage gate (all DB-sharing hosts)

**Do not deploy this candidate with the dispatcher enabled while any old direct-sender process exists.** Old ACK writes are unfenced and can overwrite a newer success. An additive schema alone is not a safe rolling upgrade.

1. Parent reviews the frozen commit, exact-image regression and mixed-version proof. Freshly enumerate BOTH canonical Coolify and legacy Render hosts and every additional process sharing this DB. Verify current source/revision, `JOB_WEBHOOK_ATTEMPTS`, timeout and normal health-gated rolling deployment. Keep the old healthy instances and exact old image available; back up DB/schema and pending/terminal jobs. No credentials, SMTP, templates or Stripe config change.
2. Set `JOB_WEBHOOK_DELIVERY_ENABLED=0` on **every host** before deploying the candidate. The old code ignores it. Deploy candidate to both hosts with this value verified in their running configuration. API/rendering remain available; new-code notifications accumulate durably instead of racing old sends. Notification delivery can be delayed during this bounded maintenance stage.
3. Candidate migrations run transactionally with local1second lock timeout and5second per-statement timeout. If a live writer blocks DDL, the new startup fails/rolls back; **do not terminate the old writer**. Retry after that transaction naturally completes. Confirm platform keeps the old healthy instance serving. A failed candidate startup is not a completed deployment.
4. Independently verify exact runtime bytes/revisions on all DB-sharing hosts and retirement of **all legacy processes**, including any old rolling instances. Merely seeing new health200 is not enough. No old process may remain capable of issuing the unfenced ACK UPDATE. There is no safe fixed sleep substitute for this inventory.
5. Enable `JOB_WEBHOOK_DELIVERY_ENABLED=1` and roll only between new-code instances. Concurrent new workers use SKIP LOCKED and lease-token receipt fencing. Verify pending/interrupted states recover with no new render/charge, stable IDs, and bounded attempts; keep a continuous public health probe during both rolling stages.

The local mixed-version regression runs the actual frozen462db08 worker, observes its real HTTP503 receipt/retry pause while the disabled candidate runs concurrently, SIGKILLs only that isolated legacy worker, then enables the candidate and verifies one recovered delivery, one render and one charge. This validates the protocol's critical ownership boundary, not the production platform's rolling behavior; parent must verify that separately.

## Rollback

Prefer a forward correction. If binary rollback is necessary: disable the new dispatcher on every new-code host first; retire/drain enabled new instances and let HTTP deadlines/leases finish; verify no new sender remains. Back up pending records and keep **all additive columns and the DELETE guard**. Then roll old code back with normal health gating. Old code ignores these columns; pending/delivering rows survive its reaper. Do not drop the guard or rewrite attempt histories. New pending notifications pause on an old-only fleet and require a later roll-forward; the old implementation's original lost-hook and refund-write bug are not fixed by rolling back. Legacy failed intermediate retry rows should be adopted/drained by the candidate before rollback when possible; they were not durable under the old contract. No promise of maintained hook service on the old binary.

## Tests

- `node --test --test-reporter=tap --test-concurrency=1 test/*.test.js`
- Job integration requires a **fresh disposable** loopback database named `jobqa` (or `jobqa_*`) via `QA_JOB_DATABASE_URL`, and `QA_JOB_BASELINE` pointing to unchanged `src/jobs.js` from462db08922b1b478723ee924f633624449c6c501. It applies the real schema, uses real HTTP/PG, actual committed Office fixtures, and SIGKILLs only its child workers.
- Billing concurrency uses a separate fresh loopback `billingqa` database via `QA_BILLING_DATABASE_URL`; set `RECOVERY_TEST_DB=1` only against the isolated migrated DB. Recovery mail is injected, not sent.
- Full source tests additionally need the real isolated API, Docker LibreOffice probe and host poppler. An absent tool that causes skip is not a passed acceptance criterion.
