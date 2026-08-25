# Everything DocMint created, what it costs, and how to reap it

Written because infrastructure nobody wrote down is infrastructure that runs
unnoticed. `ops/reap.sh` tears all of it down.

## Monthly cost

| What | Where | Plan | Cost |
|---|---|---|---:|
| DocMint API + PDF converter + site + docs | Render web service `docmint` (`srv-da6l2s61egvs7394d030`), Frankfurt | Starter, 512 MB | **$7.00** |
| Database | Neon project `docmint` (`fragrant-credit-25886270`), aws-us-west-2 | Free tier | **$0.00** |
| npm package | `n8n-nodes-docmint` | public | $0.00 |
| GitHub repos + Actions | `fstandhartinger/docmint`, `fstandhartinger/n8n-nodes-docmint` | public | $0.00 |
| Document libraries | none — the fill engine is ours | — | **$0.00** |
| LibreOffice | MPL-2.0, from the Debian archive | — | **$0.00** |
| Domain | none bought — runs on the Render subdomain | — | $0.00 |
| **Total** | | | **$7.00 / month** |

**This is $7/month on top of what already ran before this project.** Audited with
`ops/reap.sh --list` on 2026-08-25, which lists every service on the account rather
than only ours, because the whole point of writing this down is that nothing hides:

| Service | Plan | Cost | Whose |
|---|---|---:|---|
| `docmint` | starter | $7.00 | **this project** |
| `pdfmint` | starter | $7.00 | the sibling product |
| `agent-as-a-service` | starter | $7.00 | pre-existing |
| `siegi-locator` | starter | $7.00 | pre-existing |
| 22 others | free or suspended | $0.00 | — |
| **Account total** | | **$28.00/month** | |

$14/month of that predates both PDFMint and DocMint and is worth a look if it is
not wanted.

### Why one instance, and when it stops being enough

Measured, not assumed — see DECISIONS.md for the commands:

- Filling a template is pure Node: single-digit milliseconds, a few MB.
- Converting to PDF spawns LibreOffice: **1.02 s warm, 1.25 s cold, 219 MB peak
  RSS**, every time.

219 MB is why `MAX_CONCURRENT_PDF` is 1. Two concurrent conversions in a 512 MB
container is an OOM kill, and an OOM kill reaches the user as a dropped connection
with no error at all — the worst failure mode available. The fill path is not
throttled, so an account that never asks for PDFs is never queued behind one.

**The threshold to watch:** sustained PDF demand above roughly 0.8 conversions per
second. At that point the queue stops draining and `pdf_queue_full` starts being
returned. The fix is the Standard plan (2 GB, $25/month) with
`MAX_CONCURRENT_PDF=4`, not a second service — LibreOffice scales with memory, and
memory is what the plan buys. Do not move up before the logs show it; the log line
`pdf.ok` carries `queued_ms` on every conversion, which is the number that says
whether anyone is actually waiting.

## What exists, precisely

- **Render web service** `docmint` — id `srv-da6l2s61egvs7394d030`, region
  frankfurt, Docker runtime, auto-deploys from `master` of
  `fstandhartinger/docmint`. URL `https://docmint-832s.onrender.com`.
- **Neon project** `docmint` — id `fragrant-credit-25886270`, database `neondb`,
  branch `main` (`br-fancy-salad-a6hv2k58`). Tables: accounts, api_keys,
  templates, template_versions, files, usage_events, sessions, stripe_events.
- **npm** — `n8n-nodes-docmint`, published from GitHub Actions with provenance.
- **GitHub** — `fstandhartinger/docmint`, `fstandhartinger/n8n-nodes-docmint`.

No EC2, no GPU, no queues, no object storage, no CDN, no cron service, no domain.

## Reaping it

```bash
ops/reap.sh --list      # show everything and what it costs, change nothing
ops/reap.sh --suspend   # stop the Render service billing, keep the data
ops/reap.sh --destroy   # delete the Render service and the Neon project
```

`--destroy` asks for confirmation and prints exactly what it will remove first.
It deliberately does **not** unpublish the npm package: unpublishing breaks anyone
who installed it, and after 72 hours npm refuses anyway.
