# Collections P&L calculator for Arrowhead

A lead magnet for lenders in South India. A collections head enters their overdue book and calling setup, and sees for the month:

- **their AI vendor against Arrowhead** on the accounts the vendor works today: collections, cost and P&L, before and after
- how much of their surge-day calling the RBI 8 am to 7 pm window can actually fit
- their whole calling operation against Arrowhead running calls on its own, and Arrowhead with escalation to their agents

Submitting the form sends the lender's numbers, current motion and buyer type to Clay, so the first sales email opens with their own figures.

## Run it

Requires Node 18 or later. No dependencies.

```bash
npm start            # http://localhost:4173
npm test             # engine tests
```

To send leads to Clay, start the server with a Clay webhook URL:

```bash
CLAY_WEBHOOK_URL="https://api.clay.com/v3/sources/webhook/..." npm start
```

Without it, leads are appended to `leads.jsonl` in the project folder.

### Fonts

The page uses General Sans, served from this site rather than a font CDN, so visitors' browsers only ever contact this domain. Its license (the ITF Free Font License) allows self-hosting but not redistributing the files through a public repository, so they are not committed. `scripts/fetch-fonts.mjs` downloads the official files from Fontshare into `web/fonts/` (git-ignored) and checks each against a pinned SHA-256. `npm start` runs it first and falls back to system fonts if you're offline; `npm run fonts` runs it on its own. If Fontshare ships new versions, the hash check fails and prints the new hashes to review.

## Deploy on Vercel

The repo deploys as a static site plus one function. The only build step fetches the fonts (`node scripts/fetch-fonts.mjs`); if that fails, the build fails and the previous deployment stays live.

1. In Vercel, import this GitHub repository, or connect it to an existing project under **Settings → Git**. Every push to `main` then deploys automatically.
2. Optional: add `CLAY_WEBHOOK_URL` under **Settings → Environment Variables** to send leads to Clay. Without it, leads are written to the function logs.

`vercel.json` serves the page at `/`, and `api/lead.js` handles the lead form. `server.js` is only for running locally, and `.vercelignore` keeps it and the tests out of the deployment.

## Security

The lead endpoint is public, so `lib/lead.js` treats every request as untrusted:

- Only same-origin `application/json` posts are accepted, so other sites can't submit leads from a visitor's browser.
- Bodies are capped at 16 KB and every string is length-capped before validation.
- The record sent to Clay is rebuilt from known fields only. Extra fields are dropped, and text starting with `=`, `+`, `-` or `@` is prefixed with `'` so spreadsheets and Clay tables don't run it as a formula.
- A hidden `website` field catches simple bots; those submissions are dropped without an error.
- Webhook failures return a generic message; details go to the server log.
- Every response carries a Content-Security-Policy that allows scripts, styles and fonts from this site only, `X-Frame-Options: DENY`, `nosniff`, a referrer policy and a permissions policy (`vercel.json` on Vercel, `server.js` locally).
- On Vercel, a firewall rule limits `POST /api/lead` to 5 requests per IP per minute. It lives in the project's Firewall settings, not in this repo.
- Locally the server listens on `127.0.0.1` only. Set `HOST=0.0.0.0` to share it on your network.

## Layout

| Path | What it holds |
|---|---|
| `engine/model.js` | The calculation engine, including the vendor-vs-Arrowhead view. Pure functions, no DOM, so it runs in the browser and in Node. |
| `data/benchmarks.js` | Arrowhead's published collections results and price range. |
| `data/demo-lender.js` | Kaveri Finance, a fictional lender used as the demo. Every value is illustrative. |
| `web/` | The landing page. |
| `server.js` | Local static server plus the `/api/lead` endpoint. |
| `api/lead.js` | The `/api/lead` endpoint as a Vercel function. |
| `lib/lead.js` | Lead validation and webhook delivery shared by both. |
| `vercel.json` | Vercel routing and caching. |
| `test/` | Engine tests (`node --test`). |

## Model rules

1. **Only the collection-rate lift creates rupees.** Arrowhead's published result (20% above human agents, measured on AI-only motions) is applied to the lender's human collection rate in each bucket, capped at 100% of the overdue amount.
2. **Arrowhead's figures are fixed.** The two published lifts and the price are shown on the page but can't be edited, so no visitor can change Arrowhead's claims. They live in `data/benchmarks.js`.
3. **The connection lift explains the result and never adds to it.** Applying it on top of the collection lift would count the same effect twice.
4. **Escalated calls are credited at the lender's own human rate**, minus borrowers lost in the transfer. Arrowhead's lift is not applied to work done by the lender's agents.
5. **The transfer leg is billed by the lender's telco** at the lender's rate. Arrowhead's price covers its own calls, telephony included, and is applied at ₹4.00, the top of its ₹3.50 to ₹4.00 range.
6. **Escalations queue on the seats the lender keeps.** Extra seats are costed only when the surge-day queue needs more than that.
7. **P&L impact is credit cost avoided minus the change in collection cost.** A collected EMI is cash. The P&L gain is the share of it that would otherwise have become provisions or write-offs, set per bucket by the lender.
8. **Arrowhead against an incumbent AI vendor is derived, never assumed.** Before is the vendor's own collection rate on its accounts. After is the lender's human collection rate in the same bucket × (1 + lift). A lender with no human agents left enters the human rate from before it moved to AI, and the page flags that the benchmark is historical. With no human rate at all, the comparison stays blank and the call to action is a pilot.
9. **Hang-ups within 10 seconds are a diagnostic.** Value at risk = hang-ups × share the lender believes is recoverable × rupees collected per conversation that continues. It is never added to collections.
10. **Break-even lift** is the collection-rate lift at which Arrowhead's P&L impact is zero, solved numerically with the 100% cap applied.

## Sources

- Arrowhead collections results (20% higher collection rate, 50% higher connection rate, 4x ROI on write-offs): Arrowhead website, collections case panel.
- Arrowhead pricing, ₹3.50 to ₹4.00 per connected minute, all-in; the calculator applies ₹4.00.
- RBI recovery directions dated 6 August 2026, effective 1 January 2027: recovery calls between 8 am and 7 pm unless the borrower asks otherwise. Index to RBI Circulars, RBI/2026-27/229: https://rbi.org.in/Scripts/BS_CircularIndexDisplay.aspx?Id=13671

## Known limits

- A historical human rate comes from a different period, when the book and borrowers were different.
- The 20% lift comes from one published deployment. Applying it to another lender's agents is an assumption the page states.
- Collections are assumed to scale with conversations when splitting escalated and non-escalated calls.
- The surge-day gap and hang-up leak use the lender's own inputs and are only as good as their dialer data.
- Written-off accounts are out of scope.
