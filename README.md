# Samba Rentals — sambarentals.com

The Samba Realty rentals platform: a public villa-listing site, an agent
portal, an owner/property-manager portal, and an admin console — one Vercel
project, no build step, vanilla JS + serverless functions + Upstash KV.

It started life as a read-only "Hostex availability portal" and grew; the
14 Hostex catalog units (identity in `lib/catalog.js`) now live alongside
owner-submitted custom listings (KV `custom_properties`).

## Surfaces (`public/`, routed via `vercel.json`)

| Page | URL | What it is |
|---|---|---|
| `index.html` | `/` | Agent portal SPA — villa grid, live calendars, sharing, collections |
| `home.html` | `/home` | Owner-facing marketing site |
| `for-agents.html` | `/for-agents` | Agent-facing marketing site |
| `listing.html` | `/l/:slug` | Public single-listing page |
| `portal.html` | `/portal` | Owner portal (Google login: listings, analytics, weekly reports) |
| `admin.html` | `/admin` | Admin console (listing editor, approvals, owner assignment) |
| `dashboard.html` | `/dashboard` | Analytics dashboard (password) |
| `report-view.html` | `/r/:token` | Tokenized no-login weekly villa report |
| `agent.html` | `/a/:handle` | Agent public profile |
| `list-property.html` | `/list-property` | Owner property submission |

Design system: `public/brand.css` (`--sb-*` tokens + legacy aliases). Pages
must NOT re-declare core colour tokens locally — brand.css is the source of
truth; only page-specific extras (e.g. `--rep-serif`) live per page.

## API (`api/`, all action-routed to stay under the 12-function cap)

- `listings.js` — public + admin listing CRUD, `assign-owner`
- `portal.js` — owner/agent portal (auth, properties, analytics, reports, billing)
- `dashboard.js` — analytics + authed feeds for the CRM (`?owner_sync=1`, `?agent_funnel=1`, `?portal_pulse=1`)
- `digest.js` — daily availability digest (consumed by the Maya CRM broadcast)
- `calendar.js`, `ical.js`, `check-availability.js` — availability sources
- `media.js`, `track.js`, `billing.js`, `listing-page.js`, `home-stats.js`

Sibling repo: `~/kaya-agent-crm` (Maya WhatsApp CRM) syncs listings and
owner contacts from here via `LISTING_SYNC_SECRET`-authed endpoints.

## Env vars (Vercel)

`KV_REST_API_URL` / `KV_REST_API_TOKEN` (Upstash), `HOSTEX_TOKEN`,
`GOOGLE_API_KEY` (Drive photos), `GOOGLE_CLIENT_ID` (owner login),
`ADMIN_PASSWORD` / `DASHBOARD_PASSWORD` (no hardcoded fallback),
`LISTING_SYNC_SECRET` (CRM handshake), `CRM_SYNC_URL`, Paddle billing keys.

## Development

```
node dev/devserver.mjs        # local server on :3456, mocked KV/Hostex/Drive
node dev/e2e.test.mjs         # logic tests against the real handlers
```

Deploy: push to `main` → Vercel auto-deploys.
