'use strict';

const express = require('express');
const Stripe = require('stripe');
const { config, PLANS, planPriceId } = require('./config');
const { query, tx } = require('./db');
const { ApiError } = require('./errors');
const log = require('./log');

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey, {
  apiVersion: '2025-01-27.acacia',
  // Bounded on purpose. The checkout path makes several sequential Stripe
  // calls while it holds a database connection and a row lock, and the pool
  // is small. With the library's defaults (80 s, two retries) one Stripe
  // slowdown would hold every connection long enough to take the whole
  // service down, not just billing.
  timeout: 10000,
  maxNetworkRetries: 1,
}) : null;
const enabled = () => Boolean(stripe);

// The name a buyer sees at the top of the Stripe Checkout page.
const BRAND_NAME = 'DocMint';

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * A stored Stripe customer id is not permanent. It can be deleted in the Stripe
 * dashboard, vanish when an account is switched, or come back `deleted: true`
 * from a restore. Trusting it blindly meant the checkout threw
 * "No such customer" and answered 500 — so the one user who wanted to pay could
 * never pay again. Every use of a stored id goes through here, which verifies it
 * and quietly replaces it if it has gone.
 */
async function isUsableCustomer(customerId) {
  if (!customerId) return false;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return !customer.deleted;
  } catch (e) {
    if (e && (e.code === 'resource_missing' || e.statusCode === 404 || /No such customer/i.test(e.message || ''))) {
      return false;
    }
    throw e; // a network or auth failure is not the same as a missing customer
  }
}

async function createCustomerFor(account, run = query) {
  const customer = await stripe.customers.create({
    email: account.email,
    metadata: { account_id: String(account.id), service: 'docmint' },
  });
  await run(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1`, [account.id, customer.id]);
  return customer.id;
}

async function ensureCustomer(account, run = query) {
  if (await isUsableCustomer(account.stripe_customer_id)) return account.stripe_customer_id;
  if (account.stripe_customer_id) {
    log.warn('stripe.customer_unusable', { account: account.id, customer: account.stripe_customer_id });
  }
  return createCustomerFor(account, run);
}

/**
 * The invoice behind an abandoned first attempt, and whether its payment is
 * still settling.
 *
 * A settling payment must never be voided: the buyer may be on the 3-D Secure
 * step in another tab, and voiding an invoice whose charge is completing is how
 * money is taken for nothing.
 *
 * Where the intent lives depends on the API version, and this was measured
 * rather than assumed on 2026-09-06. On the version this client pins
 * (2025-01-27.acacia) `invoice.payment_intent` is there. On the account's newer
 * default it is gone and the intent sits under
 * `payments.data[].payment.payment_intent`. Both expansions are accepted by both
 * versions, so both are asked for and whichever answers is used — otherwise a
 * future default-version bump silently turns this guard off.
 *
 * `requires_action` and `requires_payment_method` are NOT settling: they are the
 * abandoned 3-D Secure and the declined card, which is exactly what this clears.
 */
const SETTLING = ['processing', 'requires_capture', 'succeeded'];

async function abandonedInvoice(sub) {
  const id = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
  if (!id) return null;
  try {
    const invoice = await stripe.invoices.retrieve(id, {
      expand: ['payment_intent', 'payments.data.payment.payment_intent'],
    });
    const intents = [
      invoice.payment_intent,
      ...(invoice.payments?.data || []).map((entry) => entry.payment?.payment_intent),
    ].filter((intent) => intent && typeof intent === 'object');
    return {
      url: invoice.hosted_invoice_url || null,
      status: invoice.status,
      inFlight: intents.some((intent) => SETTLING.includes(intent.status)),
    };
  } catch (e) {
    // Unreadable is treated as "do not touch": the caller then routes the buyer
    // to the attempt they already have rather than opening a second one.
    log.warn('stripe.abandoned_invoice_unreadable', { subscription: sub.id, message: e.message });
    return null;
  }
}

async function createCheckoutSession(account, planId) {
  if (!enabled()) throw new ApiError(503, 'billing_unavailable', 'Billing is not configured on this deployment.');
  const priceId = planPriceId(planId);
  if (!priceId) {
    throw new ApiError(400, 'unknown_plan', `There is no purchasable plan called "${planId}".`, {
      hint: `Available plans: ${Object.keys(PLANS).filter((p) => planPriceId(p)).join(', ')}.`,
    });
  }
  // The Stripe customer is created and committed in its OWN short transaction.
  // Inside the long one below, any later failure rolled the stored id back while
  // the Stripe object survived — so every failed checkout during a Stripe incident
  // minted another orphaned customer carrying the buyer's email address, and
  // nothing ever reclaimed them.
  //
  // These are two transactions, so the lock taken here is released before the
  // one below starts — an earlier version of this comment claimed otherwise, and
  // that claim was simply false. What keeps two simultaneous clicks to one
  // customer is that BOTH transactions take the row lock and re-read the row
  // under it: the second click blocks here, then reads the customer id the first
  // one committed. Measured 2026-09-06: four simultaneous clicks produced one
  // customer and one checkout session.
  const customerId = await tx(async (client) => {
    const run = client.query.bind(client);
    const { rows } = await run('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
    if (!rows[0]) throw new ApiError(404, 'account_not_found', 'Account not found.');
    return ensureCustomer(rows[0], run);
  });
  // Serialize clicks across all instances, and re-read the authoritative row:
  // two quick clicks on "Choose Pro" used to open two checkouts and could end in
  // two subscriptions on one account, both charged.
  return tx(async (client) => {
    const run = client.query.bind(client);
    const { rows } = await run('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
    account = rows[0];
    if (!account) throw new ApiError(404, 'account_not_found', 'Account not found.');

    // An account that already subscribes is UPGRADED in place. Sending it through
    // Checkout again creates a second subscription next to the first and bills
    // both.
    const listed = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    if (listed.has_more) throw new ApiError(409, 'billing_review_required', 'Please manage subscriptions through the billing portal.');
    // `incomplete` means the very first payment has not cleared. Stripe leaves
    // it that way for about a day before expiring it, and it never granted
    // anything — treating it as "current" sent a buyer whose 3-D Secure failed
    // to a billing portal with nothing to manage, for 24 hours, instead of
    // letting them simply pay again.
    const current = listed.data.filter((sub) => !['canceled', 'incomplete', 'incomplete_expired'].includes(sub.status)
      && sub.items.data.some((item) => planForPriceId(item.price.id)));
    if (current.length > 1) throw new ApiError(409, 'multiple_subscriptions', 'Multiple subscriptions exist. Contact support before changing your plan.');

    // An `incomplete` subscription grants nothing, but its first invoice stays
    // PAYABLE for about a day — so simply ignoring it and opening a second
    // checkout is how one buyer ends up paying for two. Measured on 2026-09-06
    // in test mode against this code: an abandoned $9 attempt, a completed $29
    // checkout, then the abandoned invoice paid afterwards = two active
    // subscriptions, $38 a month, and the account left on the CHEAPER plan's
    // quota because the later event won.
    //
    // The buyer must still be able to pay. What they must not be able to do is
    // pay twice for one intention. So: finish the attempt they made, or make it
    // unpayable — never leave it payable next to a new one.
    const abandoned = listed.data.filter((sub) => sub.status === 'incomplete'
      && sub.items.data.some((item) => planForPriceId(item.price.id)));
    let finish = null;     // the attempt to hand the buyer back to
    let blocked = false;   // ...or one we may not judge, which also forbids a second
    for (const sub of abandoned) {
      const item = sub.items.data.find((entry) => planForPriceId(entry.price.id));
      // eslint-disable-next-line no-await-in-loop
      const attempt = await abandonedInvoice(sub);
      if (attempt && attempt.status !== 'open') continue;   // nothing payable is left
      // Same plan and nothing live to upgrade: finishing the payment they started
      // is the retry they actually want, and it cannot produce a second
      // subscription. An unreadable or still-settling attempt goes the same way,
      // because the one thing worse than a confusing page is a double charge.
      const samePlan = Boolean(item && item.price.id === priceId && !current.length);
      if (samePlan || !attempt || attempt.inFlight) {
        // Remembered, not returned: every OTHER abandoned attempt still has to be
        // made unpayable before this call ends, or it sits there for a day.
        blocked = true;
        if (!finish && attempt && attempt.url) finish = attempt;
        continue;
      }
      // They changed their mind. Cancelling an incomplete subscription voids its
      // open invoice, and Stripe then refuses a late payment outright — measured:
      // "Voided invoices cannot be paid."
      // eslint-disable-next-line no-await-in-loop
      await stripe.subscriptions.cancel(sub.id);
      log.info('stripe.abandoned_attempt_cancelled', {
        account: account.id, subscription: sub.id, price: item && item.price.id,
      });
    }
    if (blocked) {
      return finish
        ? { url: finish.url }
        : stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.publicUrl}/dashboard` });
    }

    if (current.length) {
      const sub = current[0];
      const item = sub.items.data.find((entry) => planForPriceId(entry.price.id));
      // Anything not cleanly active (past_due, unpaid, incomplete, a pending
      // change) is a billing problem, not an upgrade. The portal is where those
      // are solved; guessing here is how a card gets charged twice.
      if (!['active', 'trialing'].includes(sub.status) || sub.pending_update) {
        return stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.publicUrl}/dashboard` });
      }
      if (item.price.id === priceId) {
        // `sub` came from the listing a few lines up, inside this transaction, so it
        // IS the authoritative answer. A second retrieve here would only add a way
        // for a network blip to turn a harmless re-click into a 503 — and this
        // branch is what now absorbs the double click the removed key used to.
        await applySubscription(sub, run, { refresh: false });
        return { url: `${config.publicUrl}/dashboard?checkout=updated` };
      }
      // No idempotency key on the update, for the same reason there is none on the
      // checkout below: a key that spans a window replays the response it stored.
      // PDFMint measured the consequence on this identical code — Starter, Pro,
      // Starter, Pro inside half an hour left STRIPE on Starter while the product
      // granted Pro. Measured here on 2026-09-07 against the deployed image, where
      // the C5 read-back stops the mis-grant, it is the other symptom of the same
      // cause: the third click reached nothing at Stripe, the customer was told
      // "your plan change has been sent", and their plan did not change for half an
      // hour. What collapses a genuine double click is the row lock plus the
      // re-read under it: the second click sees the price the first one set and
      // takes the "already on this plan" branch above.
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: priceId, quantity: item.quantity || 1 }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
        expand: ['latest_invoice'],
      });
      // A pending update is an UNPAID upgrade: Stripe keeps the old price until
      // the prorated invoice clears, so the entitlement stays where it is.
      if (updated.pending_update) {
        const invoiceUrl = updated.latest_invoice?.hosted_invoice_url;
        return { url: invoiceUrl || `${config.publicUrl}/dashboard?checkout=pending` };
      }
      // Stripe just handed back the updated subscription. Verifying it again would
      // mean a blip on a redundant read could throw away a change Stripe has already
      // made and prorated.
      await applySubscription(updated, run, { refresh: false });
      return { url: `${config.publicUrl}/dashboard?checkout=updated` };
    }

    // Reuse the open session so a double click cannot create two subscriptions.
    const open = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 });
    if (open.has_more) throw new ApiError(409, 'billing_review_required', 'Please contact support before starting another checkout.');
    for (const session of open.data) {
      if (session.mode !== 'subscription' || session.metadata?.account_id !== String(account.id)) continue;
      if (session.metadata.plan === planId) return session;
      await stripe.checkout.sessions.expire(session.id);
    }
    const payload = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // The session id comes back so the dashboard can VERIFY the payment with
      // Stripe instead of believing `?checkout=success`. See verifyCheckoutReturn.
      success_url: `${config.publicUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicUrl}/dashboard?checkout=cancelled`,
      // One Stripe account sells several products, so its business name is the
      // portfolio's ("Amazing AI Apps") and a DocMint buyer had no idea who was
      // charging them. This overrides the name on THIS session only; the legal
      // entity, receipts, statement descriptor and support details are
      // account-level and deliberately untouched.
      branding_settings: { display_name: BRAND_NAME },
      allow_promotion_codes: true,
      // An EU business needs its VAT ID on the invoice or its accountant will not
      // accept the receipt. Optional on purpose: Stripe shows an "Add VAT ID" link
      // that a private buyer can simply ignore, so nobody is forced to have one.
      tax_id_collection: { enabled: true },
      billing_address_collection: 'auto',
      // Stripe requires this whenever a session both attaches an existing customer
      // and collects an address or a tax id; without it the session is rejected.
      customer_update: { name: 'auto', address: 'auto' },
      client_reference_id: String(account.id),
      subscription_data: { metadata: { account_id: String(account.id), plan: planId, service: 'docmint' } },
      metadata: { account_id: String(account.id), plan: planId, service: 'docmint' },
    };
    // No idempotency key here, and that is the fix rather than an omission.
    //
    // A key that spans a window replays the response it stored, and the session
    // in that response can be GONE — choosing another plan expires it. Measured
    // on 2026-09-06 against the deployed image: Starter, then Pro, then Starter
    // again handed the buyer the expired Starter session, and Stripe's page told
    // them "You're all done here. You've either completed your payment or this
    // checkout session has timed out." They could not pay. The replayed body is
    // no help either — it still says `status: "open"` while a fresh retrieve of
    // the same id says `expired` — and keying the retry on the dead session's id
    // only moves the problem: that key is replayable too, which is exactly how a
    // second measured run reproduced the dead link through the "fix".
    //
    // What actually stops two sessions is above this line and is measured: the
    // account row is locked for the whole of this transaction, and the second
    // click finds and returns the first click's OPEN session. The Stripe client
    // still generates its own key per request, so a network-level retry inside
    // the SDK cannot duplicate anything either.
    const session = await stripe.checkout.sessions.create(payload);
    if (session.status && session.status !== 'open') {
      // Not reachable through Stripe as it behaves today; if it ever is, the
      // buyer must not be handed a session they cannot pay.
      log.warn('stripe.fresh_session_not_open', { session: session.id, status: session.status });
    }
    return session;
  });
}

async function createPortalSession(account) {
  if (!enabled()) throw new ApiError(503, 'billing_unavailable', 'Billing is not configured on this deployment.');
  if (!account.stripe_customer_id) {
    throw new ApiError(400, 'no_subscription', 'This account has never had a paid subscription.', {
      hint: 'Start a subscription first with POST /v1/billing/checkout; the portal only exists once there is something to manage.',
    });
  }
  if (!(await isUsableCustomer(account.stripe_customer_id))) {
    // Nothing to manage: the customer this account pointed at is gone, so the
    // honest answer is "there is no subscription", not a 500.
    await query(`UPDATE accounts SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = $1`, [account.id]);
    throw new ApiError(400, 'no_subscription', 'There is no billing record for this account any more.', {
      hint: 'Choose a plan to start a new subscription.',
    });
  }
  return stripe.billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${config.publicUrl}/docs#quota`,
  });
}

/** Maps a Stripe price id back to one of our plans. */
function planForPriceId(priceId) {
  for (const id of Object.keys(PLANS)) {
    if (planPriceId(id) === priceId) return PLANS[id];
  }
  return null;
}

/** Asks Stripe what a subscription is now, classifying a failure the same way
 * applySubscription does: transient means the delivery fails and Stripe
 * redelivers; only "no such subscription" is answered instead. */
async function confirmSubscription(id) {
  try {
    return await stripe.subscriptions.retrieve(String(id), { timeout: 5000, maxNetworkRetries: 0 });
  } catch (e) {
    const permanent = Boolean(e && (e.code === 'resource_missing' || e.statusCode === 404));
    log[permanent ? 'error' : 'warn']('stripe.subscription_unverifiable', {
      subscription: id, permanent, message: e.message,
    });
    const failure = new ApiError(503, 'subscription_unverifiable',
      `Could not confirm subscription ${id} with Stripe; refusing to act on the event body.`);
    failure.stripePermanent = permanent;
    throw failure;
  }
}

async function applySubscription(subscription, run = query, { refresh = true } = {}) {
  const accountId = subscription.metadata?.account_id;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

  // One Stripe account serves more than one product, and every endpoint on it
  // receives every event. A subscription whose price is not one of ours belongs
  // to a sibling product; acting on it once downgraded a live, paying PDFMint
  // customer because another product's subscription carried the same account_id.
  // Checked on the event body first, so a foreign subscription costs us neither a
  // row lock nor a Stripe call.
  if (!planForPriceId(subscription.items?.data?.[0]?.price?.id)) {
    log.warn('stripe.foreign_price_ignored', {
      subscription: subscription.id, price: subscription.items?.data?.[0]?.price?.id,
    });
    return { ignored: 'foreign_price' };
  }

  let target = null;
  if (accountId) {
    const { rows } = await run(`SELECT * FROM accounts WHERE id = $1 FOR UPDATE`, [accountId]);
    target = rows[0] || null;
  }
  if (!target && customerId) {
    const { rows } = await run(`SELECT * FROM accounts WHERE stripe_customer_id = $1 FOR UPDATE`, [customerId]);
    target = rows[0] || null;
  }
  if (!target) {
    log.warn('stripe.subscription_unknown_account', { subscription: subscription.id, customer: customerId });
    return;
  }

  // `metadata.account_id` is a number we put there ourselves, and the sibling
  // products on this Stripe account number their accounts from 1 as well. The id
  // alone is therefore not proof of ownership: the subscription must also sit on
  // the Stripe customer this account is bound to.
  if (customerId && target.stripe_customer_id && target.stripe_customer_id !== customerId) {
    log.warn('stripe.foreign_customer_ignored', { subscription: subscription.id, customer: customerId, account: target.id });
    return { ignored: 'foreign_customer' };
  }

  /**
   * The event body is a SNAPSHOT of the moment Stripe emitted it, and Stripe
   * delivers a purchase's four events concurrently, in no particular order.
   * `customer.subscription.created` is emitted the instant the subscription
   * exists — for a card payment, before the card is charged — so its body says
   * `status: "incomplete"` every single time. Acted on as written and processed
   * last, it puts a paying customer back on `free` and clears the subscription
   * id they would cancel with.
   *
   * Measured on the deployed image on 2026-09-06:
   *   plan_applied account=1 plan=free credits=30 status=incomplete
   * on an account whose payment had already succeeded. It survived only because
   * that apply happened to land first; MailMint measured the same race losing on
   * one paid account in two.
   *
   * So the status and the price are read from Stripe as they are NOW, after the
   * row is locked — every one of the four events then asks the same question of
   * the same source and gets the same answer, and delivery order stops deciding
   * anything. Identification stays with the body: those fields do not change.
   *
   * If that read fails, the event is NOT applied and the delivery fails, so Stripe
   * redelivers it. This used to fall back to the snapshot, on the reasoning that an
   * outage must not leave a paying customer with nothing; simulating the outage on
   * 2026-09-07 showed the fallback doing precisely that, because the `created` body
   * says `incomplete` every time. A snapshot we cannot confirm is not a fact.
   */
  let current = subscription;
  if (refresh && subscription.id && stripe) {
    try {
      // Bounded: this call happens with the account row locked, and a Stripe
      // incident must not hold that lock and a pool connection for the client's
      // full 10 s plus a retry.
      // Bounded and deliberately WITHOUT an in-process retry: this runs while the
      // account row is locked and the pool is small, and a 429 carrying Retry-After
      // would hold both for up to a minute. Stripe's redelivery is the retry.
      const fresh = await stripe.subscriptions.retrieve(String(subscription.id), {
        timeout: 5000, maxNetworkRetries: 0,
      });
      if (fresh && fresh.id) {
        // The checkout path stamps account_id onto the body from
        // client_reference_id, and that only exists on what we were handed.
        current = { ...fresh, metadata: { ...(subscription.metadata || {}), ...(fresh.metadata || {}) } };
        if (fresh.status !== subscription.status) {
          log.info('stripe.subscription_refreshed', {
            subscription: subscription.id, snapshot: subscription.status, now: fresh.status,
          });
        }
      }
    } catch (e) {
      /**
       * This used to fall back to the event body, on the reasoning that a snapshot
       * is what the code had always acted on and an outage must not leave a paying
       * customer with nothing. Measured on 2026-09-07 against the deployed image,
       * with Stripe genuinely unreachable from the container, that reasoning was
       * wrong in the worst possible direction: the `created` body says `incomplete`
       * every time, so the fallback took a paying account from `starter / 2000` to
       * `free / 30` with the subscription id cleared — and answered Stripe with
       * HTTP 200, which means no retry, and kept the idempotency marker, which
       * means the retry would have been swallowed anyway.
       *
       * A snapshot we cannot confirm is not a fact. The delivery fails instead, the
       * marker rolls back with the transaction, and Stripe redelivers — which is
       * what its retry schedule is for. The customer's plan is decided a few
       * minutes late rather than wrongly.
       */
      // Including "no such subscription". That answer is almost never the truth
      // about a subscription Stripe itself just sent us an event for — it is what a
      // key in the wrong mode, or a request against the wrong account, looks like —
      // and swallowing it would commit the idempotency marker, so the redelivery
      // that would have healed it comes back as a duplicate and the customer stays
      // stranded with only a warning in a log nobody reads.
      // Transient and permanent are not the same thing. A connection reset, a
      // timeout, a rate limit or a Stripe 5xx will be resolved by redelivery, so the
      // delivery fails and the event id rolls back with it. "No such subscription",
      // a key in the wrong mode or a restricted key will not, and an endpoint that
      // fails continuously eventually gets disabled — which would take the
      // deliveries that DO work down with it. That one is answered instead. Either
      // way nothing is written and the event id is not consumed.
      // Only "no such subscription" is permanent. A wrong or restricted key looks
      // permanent but is fixed by somebody, and Stripe redelivers for three days —
      // answering 200 would destroy those events silently AND hide them from
      // Stripe's own failed-delivery list, which is where an operator would see it.
      const permanent = Boolean(e && (e.code === 'resource_missing' || e.statusCode === 404));
      log[permanent ? 'error' : 'warn']('stripe.subscription_unverifiable', {
        subscription: subscription.id, event_status: subscription.status, permanent, message: e.message,
      });
      const failure = new ApiError(503, 'subscription_unverifiable',
        `Could not confirm subscription ${subscription.id} with Stripe; refusing to act on the event body.`);
      failure.stripePermanent = permanent;
      throw failure;
    }
  }

  const plan = planForPriceId(current.items?.data?.[0]?.price?.id)
    || planForPriceId(subscription.items?.data?.[0]?.price?.id);
  const active = ['active', 'trialing', 'past_due'].includes(current.status);

  // A cancellation only speaks for the subscription it names. When an account has
  // since moved to a different subscription, an older one ending must not revoke
  // the current one.
  if (!active && target.stripe_subscription_id && target.stripe_subscription_id !== subscription.id) {
    log.warn('stripe.stale_subscription_ignored', {
      subscription: subscription.id, status: current.status,
      account: target.id, current: target.stripe_subscription_id,
    });
    return { ignored: 'stale_subscription' };
  }

  const newPlan = active ? plan : PLANS.free;
  await run(
    `UPDATE accounts SET plan = $2, credits_limit = $3, stripe_subscription_id = $4, stripe_customer_id = COALESCE(stripe_customer_id, $5)
     WHERE id = $1`,
    [target.id, newPlan.id, newPlan.credits, active ? subscription.id : null, customerId || null],
  );
  log.info('stripe.plan_applied', {
    account: target.id, plan: newPlan.id, credits: newPlan.credits,
    subscription: subscription.id, status: current.status, event_status: subscription.status,
  });
}

async function handleEvent(event) {
  try {
    return await handleEventInTransaction(event);
  } catch (e) {
    // A failure Stripe will never resolve by redelivering: answered, so a
    // continuously-failing endpoint does not get disabled and take the deliveries
    // that do work with it. Nothing was written and the event id was not consumed,
    // because the transaction rolled back.
    if (e && e.stripePermanent) {
      log.error('stripe.event_unverifiable_permanent', { event: event.id, type: event.type });
      return { ignored: 'subscription_unverifiable' };
    }
    throw e;
  }
}

async function handleEventInTransaction(event) {
  // The idempotency marker and the fulfilment share one transaction. Written
  // separately, a marker that survived a failed fulfilment turned Stripe's retry
  // into `{duplicate:true}` — the customer had paid and nothing was ever applied.
  return tx(async (client) => {
  const run = client.query.bind(client);
  const { rowCount } = await run(`INSERT INTO stripe_events (id) VALUES ($1) ON CONFLICT DO NOTHING`, [event.id]);
  if (!rowCount) return { duplicate: true };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // A completed session is not a paid session. Asynchronous methods finish
      // later, and some finish as a failure; fulfilling here would hand out the
      // quota for a payment that never arrives.
      if (!['paid', 'no_payment_required'].includes(session.payment_status)) {
        log.warn('stripe.session_unpaid', { session: session.id, payment_status: session.payment_status });
        break;
      }
      if (session.subscription) {
        // Same read, same rules: bounded, no in-process retry, and a failure that
        // Stripe will never resolve is answered rather than retried for three days.
        const sub = await confirmSubscription(String(session.subscription));
        if (!sub.metadata?.account_id && session.client_reference_id) {
          sub.metadata = { ...(sub.metadata || {}), account_id: session.client_reference_id };
        }
        // The first lookup precedes the account lock. Re-confirm under that
        // lock so a delayed completion cannot undo a concurrent paid upgrade.
        // Failure rolls back both the entitlement and event marker.
        await applySubscription(sub, run);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(event.data.object, run);
      break;
    case 'invoice.paid': {
      // A renewal starts a new period — but only if the current one has actually
      // ended. rollPeriod() already resets the counter on the calendar 1st, so
      // resetting again on the billing anniversary handed a customer who
      // subscribed mid-month a second full quota every cycle. The number of
      // documents is the only thing being sold, so that was giving it away.
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        await run(
          `UPDATE accounts
              SET credits_used = 0,
                  period_start = date_trunc('month', now() AT TIME ZONE 'UTC')
            WHERE stripe_customer_id = $1
              AND period_start < date_trunc('month', now() AT TIME ZONE 'UTC')`,
          [customerId],
        );
      }
      break;
    }
    default:
      break;
  }
  return { handled: event.type };
  });
}

// Stripe needs the raw body to verify the signature, so this route is mounted
// with express.raw() in server.js before the JSON parser.
router.post('/webhook', asyncRoute(async (req, res) => {
  if (!enabled() || !config.stripe.webhookSecret) return res.status(503).json({ error: { code: 'billing_unavailable' } });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripe.webhookSecret);
  } catch (e) {
    log.warn('stripe.bad_signature', { message: e.message });
    return res.status(400).json({ error: { code: 'invalid_signature' } });
  }
  const out = await handleEvent(event);
  res.json({ received: true, ...out });
}));

/**
 * C3 — what a return from Checkout is actually allowed to claim.
 *
 * `?checkout=success` is a query parameter. Anyone can type it, a bookmark keeps
 * it, and a shared link carries it. It is not evidence of anything. Neither is
 * "this account is on a paid plan": that only says some earlier payment worked,
 * not that the checkout the customer just came back from was paid.
 *
 * So the page asks Stripe. It resolves the session id that Stripe itself put in
 * the URL, checks the session belongs to this account, checks Stripe considers it
 * paid, and checks our own fulfilment has landed. "Payment received" is returned
 * for exactly one state; everything else gets neutral, honest text.
 */
const CHECKOUT_RETURN = {
  paid: { ok: true, message: 'Payment received. Your new quota is live — it is shown below.' },
  activating: { ok: false, message: 'Payment confirmed. We are activating your plan now — this usually takes a few seconds. Reload this page to see it.' },
  pending: { ok: false, message: 'This checkout is not confirmed yet. Nothing has been charged or activated; your plan below is unchanged.' },
  expired: { ok: false, message: 'That checkout link has expired. Nothing was charged. Choose a plan below to start again.' },
  foreign: { ok: false, message: 'We could not match that checkout to this account. Your plan below is unchanged.' },
  unverified: { ok: false, message: 'We could not confirm a payment for this link. Your plan below is unchanged — if you have just paid, reload in a moment.' },
};

async function verifyCheckoutReturn(account, sessionId) {
  const state = (name, extra = {}) => ({ state: name, ...CHECKOUT_RETURN[name], ...extra });
  // No session id (an old bookmark, a hand-typed URL, a forged link) proves nothing.
  if (!sessionId || typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return state('unverified', { reason: 'no_session_id' });
  }
  if (!enabled()) return state('unverified', { reason: 'billing_disabled' });

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  } catch (e) {
    log.warn('stripe.checkout_return_unverifiable', { session: sessionId, message: e.message });
    return state('unverified', { reason: 'lookup_failed' });
  }

  const claimed = session.client_reference_id || session.metadata?.account_id;
  const sessionCustomer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (String(claimed || '') !== String(account.id)) return state('foreign', { reason: 'account_mismatch' });
  if (account.stripe_customer_id && sessionCustomer && sessionCustomer !== account.stripe_customer_id) {
    return state('foreign', { reason: 'customer_mismatch' });
  }
  // All three products live on ONE Stripe account and all three number their
  // accounts from 1, so a matching account id is not proof either: a sibling
  // product's genuinely paid session would otherwise be accepted here and tell
  // someone who has paid US nothing that their payment is being activated. The
  // line item has to be a price we sell.
  const lineItems = session.line_items?.data || [];
  const ourPrice = lineItems.some((item) => planForPriceId(item.price?.id));
  // A price we can read and do not sell is somebody else's session, whatever its
  // state. An EMPTY list is a different thing: it means we could not read the
  // price at all — Stripe returns line items for a limited window — and "we could
  // not match that checkout to this account" would then be a guess dressed up as
  // a fact. Expiry is knowable without the price, so it is answered first.
  if (lineItems.length && !ourPrice) return state('foreign', { reason: 'not_our_price' });
  if (session.status === 'expired') return state('expired');
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) {
    return state('pending', { reason: `payment_status=${session.payment_status}` });
  }
  // Paid, but we cannot see what for. The one thing this must never do is claim
  // a payment: all three products share a Stripe account and number their
  // accounts from 1, so an unpriceable paid session may well be a sibling's.
  if (!ourPrice) return state('unverified', { reason: 'line_items_unavailable' });

  // Stripe says paid. That still does not mean OUR side has applied it — the
  // webhook may not have landed. Claiming a live quota before the row moved is
  // the same lie in a different place.
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  const fulfilled = account.plan !== 'free' && (!subId || account.stripe_subscription_id === subId);
  return fulfilled ? state('paid') : state('activating');
}

/**
 * Finds every account whose stored customer id no longer resolves and clears it,
 * so the next checkout creates a fresh one instead of failing. Runs at boot.
 */
async function healStaleCustomers() {
  if (!enabled()) return { checked: 0, healed: 0 };
  const { rows } = await query(`SELECT id, email, stripe_customer_id FROM accounts WHERE stripe_customer_id IS NOT NULL`);
  let healed = 0;
  for (const row of rows) {
    try {
      if (await isUsableCustomer(row.stripe_customer_id)) continue;
      await query(`UPDATE accounts SET stripe_customer_id = NULL, stripe_subscription_id = NULL WHERE id = $1`, [row.id]);
      healed += 1;
      log.warn('stripe.customer_cleared', { account: row.id, customer: row.stripe_customer_id });
    } catch (e) {
      log.warn('stripe.customer_check_failed', { account: row.id, message: e.message });
    }
  }
  if (rows.length) log.info('stripe.customer_health', { checked: rows.length, cleared: healed });
  return { checked: rows.length, healed };
}

module.exports = {
  router, stripe, enabled, createCheckoutSession, createPortalSession, applySubscription,
  handleEvent, ensureCustomer, isUsableCustomer, healStaleCustomers, verifyCheckoutReturn,
  BRAND_NAME,
};
