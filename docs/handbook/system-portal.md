# How sambarentals.com is built and wired

Plain facts about the portal for anyone supporting it. Written for Maya's handbook; keep it current when routes, links or roles change.

## What runs where

- The portal is a dependency-free Node app on Vercel. Data lives in Upstash KV (Redis), bookings come from Hostex, photos live in Google Drive, WhatsApp messages are sent by the CRM (Maya), not by the portal.
- Vercel Hobby allows 12 serverless functions, so each `api/*.js` file serves many actions selected by `?action=` (or `?source=`, `?view=`). `vercel.json` rewrites the public paths to those files.
- Pushing to `main` deploys. There is no build step. The one portal cron is `/api/digest?force=1` at 00:50 UTC, which is 08:50 in Bali, pre-warming the availability digest before Maya's 09:00 broadcast.
- The dev harness `dev/devserver.mjs` runs the real handlers on port 3456 against mocked KV, Hostex, Drive and a mock CRM.

## Public paths

- `/` agent portal (villa grid, filters, shortlists, stories). `/l/<slug>` public villa page. `/a/<handle>` an agent's branded page, `/s/<shareId>` a shared shortlist. These pages never show Samba's own contact, so the agent stays the only path to the villa.
- `/home` (also `/list-property`) the owner pitch, pricing and FAQ. `/for-agents` the agent pitch. `/viewings` how viewings work. `/terms`, `/privacy`, `/refund` the policies. `/brand-kit` the design system.
- `/portal` the owner portal. `/payouts` the management cockpit (Era and Ikiel). `/admin`, `/dashboard`, `/campaigns` are Ikiel-only.
- `/r/<slug>~<sig>` a weekly report. `/st/<group>.<YYYY-MM>~<sig>` a monthly statement. `/m/<group>.<id>~<sig>` one repair to approve or decline. `/j/<id>~<sig>` a tukang job sheet in Indonesian, read-only. `/guides/Samba-Owner-Guide.pdf` and `/guides/Panduan-Housekeeper-Samba.pdf`.

## Signing in

- Owners and agents share one account type. Sign in with Google, or with a WhatsApp number: the portal asks the CRM to send a "Open my portal" button, valid 10 minutes, at most 5 per hour per number. Either way the session is a cookie that lasts 30 days.
- A WhatsApp sign-in only works for a number already on file for a villa. Otherwise the page says to use Google or to message Ikiel to add the number.
- Google One Tap does not work inside the WhatsApp, Instagram or Facebook in-app browsers; the page offers to open in the real browser instead.
- Era and Oli sign in to the cockpit with a WhatsApp magic link too (10 minutes to tap, then a 30-day session). Era's role is `era`: the whole cockpit, actions recorded as hers, nothing in `/admin`. Oli's role is `double8`: payroll for the Double 8 units only. Ikiel's role is `admin`: everything.

## Signed links

- Every no-login link is signed with one shared secret and scoped to exactly one thing, so a forwarded link leaks only that thing. None of them expire; they stop working only if the secret changes, which must never happen casually because every link ever sent would die.
- What each exposes: a report link shows one villa's weekly report; a statement link one month of one property group; a repair link one ticket and can approve or decline it (the signature is the authorisation); a job link one job with no owner or money; an owner invite link claims a group's villas on first sign-in; an admin preview link renders an owner's portal read-only; a record link renders one housekeeping record as a PDF, and the owner version carries no housekeeper name; a calendar link is the whole schedule as an iCal feed.

## The owner portal

- Tabs: My properties, Weekly reports, Statements, Maintenance, Housekeeping, Viewings. Statements, Maintenance and Housekeeping appear only once that owner has data.
- My properties merges the 14 Samba-managed units (from Hostex) with any listing the owner created. Co-owners see the same villa. Report contacts (up to five) get the Monday report.
- A listing created by an owner or by Maya is reviewed by Ikiel before it appears. Owners can unpublish at any time.
- Marketplace listings cost IDR 150,000 per villa per month, billed as US$9.50 by Creem, the merchant of record. The first 25 villas list free with code FOUNDING25. Samba-managed units are never billed.
- Statements can be downloaded as Excel, one month or a whole year. Maintenance tickets can be approved or declined from the tab or from the link Maya sends. Housekeeping shows cleans, photo checks and inspections with photos and a PDF per record; owners never see staff names.

## The management cockpit (`/payouts`)

- Pages: Payouts, one statement, Maintenance, Earnings, Payroll, Properties, Schedule, Records, Team. Each page has a "How to use" guide.
- Statements are synced from Era's Google Sheets, reviewed, published to the owner on WhatsApp, then marked paid. Repairs move from review to owner approval to a tukang to done. The schedule is rebuilt hourly from the booking calendar. Records keep every photo check and inspection permanently.
- Everything the cockpit does is proxied to the CRM with a shared secret that never reaches the browser.

## Data

- KV keys: `listing:<slug>` overrides for managed units; `custom_properties` one hash of every owner-created listing; `owner:<sub>` accounts; `owner_listings:<sub>` the villas an account holds; `session:<token>`; `sub:<slug>` subscriptions; `promo_codes`; analytics counters per day, month and property; `digest:cache`.
- Hostex supplies reservations (guest, channel, amount net of channel commission, check-in, check-out exclusive) and closed dates. The 14 canonical units and their prices are in `lib/catalog.js`.
- The CRM calls the portal for: a listing's weekly report, listing intake from WhatsApp, co-owner additions, Airbnb or Booking page import, listing facts, month statistics, turnovers for the cleaning schedule, which owners have claimed their account, the availability digest and date checks.

## Who to contact

- Anything commercial (pricing, agreements, statements, disputes): Ikiel.
- Anything on the ground (keys, guests, cleaning, repairs, supplies): Era, +62 812 4635 7778.
- Account problems, a number to add, a link that does not open: Ikiel, or reply to Maya and she passes it on.
- Support address on the public pages: support@sambarentals.com.
