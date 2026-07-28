# Samba Ecosystem UX Audit — July 2026

Scope: Agent Portal (`availability_checker` `/`), Owner/Manager Portal (`/portal` + `owner-portal` branch), Kaya CRM / Maya / chat PWA (`kaya-agent-crm`).
Goal: Fortune-500-grade polish — reduce friction, increase intuitiveness, make the agent value proposition instantly clear.

---

## 1. Benchmarks (case studies)

| Product | Pattern we adopt |
|---|---|
| Guesty / Hostaway / Lodgify multi-calendar | Row-per-property horizontal timeline: sticky property column, scrollable date grid, color-coded cells, vertical today line, density controls |
| Airbnb host multi-calendar | Mobile adaptation: week paging, tap-to-focus single property |
| Stripe Dashboard | Tabular numbers on money/dates, restrained single-accent palette, 6px radii, layered shadows, skeleton loaders |
| Linear | Micro-interactions (150ms color / 100ms scale), visible focus rings, speed-as-premium |
| Booking.com extranet | High-density data legibility for professional users |
| Intercom Fin / Front | AI-vs-human message badges, escalation handoff copy, conversation status pills |
| WhatsApp Web | Optimistic send, offline banner, cached history |
| Notion / Asana | Adaptive onboarding checklist, teaching empty states, benefit-first copy |

## 2. Current state — key findings

### Agent Portal (`public/index.html`)
**Works well**: bento card grid with strong photo hierarchy; client-side instant search/filter; share attribution per agent (`/a/:handle`); shortlists; modal detail with 6-month calendar; Hostex iCal sync.

**Friction**:
- **Multi-property scanning lost** — Wave 1 redesign (`ba59f37`) removed calendars from cards; availability now only visible one property at a time inside the modal. (Fixed this cycle: Calendar view.)
- 3–5 taps from grid to WhatsApp enquiry (card → modal → scroll → CTA). (Fixed: card-level quick enquiry.)
- No value proposition anywhere on the browse page — first-time agents see only a search count. (Fixed: dismissible headline.)
- No onboarding/coachmarks; filter FAB (37px) undiscoverable and below the 44px WCAG touch minimum, icon-only without aria-label. (Fixed.)
- Spinner-only loading; no skeletons; modal calendar waits 1–3s on `/api/calendar`. (Fixed: skeleton cards.)
- Availability dot contrast too low (#8FE39A on #FAF8F5). (Fixed: darker fills + labels.)
- "No calendar" state gives no explanation. (Fixed: teaching copy.)
- Mobile: bottom chrome consumes ~96px; modal cramped under 360px.

### Owner Portal (`public/portal.html`, `/dashboard` on `owner-portal` branch)
**Works well**: Google login shared across portals; Paddle billing wired end-to-end; per-property stats with period toggle; notify-agents broadcast with WhatsApp preview.

**Friction**:
- Dark navy theme is a different brand from the agent portal — the ecosystem reads as three unrelated products. (Partially fixed: dark-warm token migration.)
- Landing assumes owners know what "iCal" is; no export instructions. (Fixed: inline help expander.)
- "IDR 150k/month" pricing doesn't say **per villa** up front. (Fixed.)
- No trial/demo mode — payment required before any value is seen. (Roadmap.)
- `owner-portal` branch (accounts, analytics dashboard, notifications) is unmerged. (Roadmap.)

### Kaya CRM / Maya / chat PWA (`kaya-agent-crm`)
**Works well**: clear Maya escalation boundaries (PERSONA_SPEC); dual pipeline (KAYA sales + Samba rentals) in one persona; $0.75/day spend cap; audit trail (`maya_updates`); per-agent broadcast frequency controls with global kill switch; installable PWA with push.

**Friction**:
- **Zero new-agent onboarding**: first-time inbound gets a generic reply; agents never learn what Maya can do, that Samba availability is queryable, or that 10% commission is included in portal price (routinely misunderstood). (Fixed: welcome intro in webhook + persona.)
- Maya-vs-human authorship shown only as tiny `src-tag`; no "Maya is handling this chat" status. (Fixed: badges + header pill.)
- Draft/Hybrid/Auto modes unexplained in UI (hover-only hints). (Fixed: persistent hint line.)
- No indication a reply is coming ("typing"). (Fixed: pseudo-indicator during auto/hybrid.)
- Hardcoded PIN `2468` in page source; no recovery, no rate limit. (Hint added; server-side check on roadmap.)
- Text-only loading; abrupt pane switches. (Fixed: skeleton rows + slide transition.)
- Maya can't process voice notes/images; never proactively reaches out; escalation has no timeout/backup. (Roadmap.)

## 3. Metrics

**Already tracked** (`api/track.js`, Redis counters): page_view, listing_view/details_open, whatsapp_click, photo_download, map_open, share_*; engaged/enquired session funnel; unique agents/day; per-agent share attribution.

**Added this cycle**: `search_used`, `filter_applied`, `sort_changed`, `view_mode`, `calendar_scan_open`, `calendar_row_click`, `enquiry_from_card`.

**Success targets**:
- Taps to enquiry: 5 → 2 (watch `enquiry_from_card` vs `whatsapp_click`).
- Calendar view adoption: % of sessions with `calendar_scan_open` (new baseline).
- details_open → whatsapp_click conversion: up and to the right after quick-enquiry ships.
- Discovery: `search_used`/`filter_applied` rates reveal whether browse tools are found at all.

## 4. Shipped this cycle (premium-polish branches)

1. **Design tokens** — unified type scale, tabular numbers, 6px radii, layered shadows, focus rings, standard transitions, press feedback; contrast + touch-target fixes; skeleton loading.
2. **Calendar view** — row-per-property availability grid (the restored multi-calendar), sticky property column, ~90-day scroll, today line, lazy row loading, filter-aware.
3. **Friction/value prop** — card quick enquiry, value-prop headline, coachmarks, teaching empty states.
4. **Tracking** — 7 new events above.
5. **Chat PWA** — Samba warm reskin, AI/human badges, mode explanations, reply indicator, welcome flow, transitions.
6. **Owner portal quick wins** — dark-warm tokens, iCal help, per-villa pricing clarity.

## 5. Roadmap — status after the July round 2 sweep

Done (round 2, Jul 2026): ~~owner-portal branch merge~~ (was already fully merged — stale item); owner **demo mode** on /portal; **Maya image understanding** (vision on inbound photos; voice notes escalate gracefully — true transcription still open, Anthropic API has no audio); **escalation SLA** (daily Telegram digest of paused chats left unread >3h); **offline app shell** for chat PWA + offline banner; **conversation archiving** (device-local); **webhook hardening** (optional `WEBHOOK_SHARED_SECRET` URL token — set the env var AND update the webhook URL in Meta Business Manager together); **PIN gate removed** per Ikiel (obscure URL only — revisit real auth if the inbox ever gets a second user); <360px modal/calendar polish; **agent share-performance stats** in the profile sheet.

Still open, reprioritized:
1. **Voice-note transcription** — needs a speech-to-text provider (Anthropic API has none); Whisper-API or Google STT.
2. **Proactive Maya** — scoped nudges beyond the existing cron sequences/broadcasts (e.g. "a villa matching your client's dates freed up"); needs stored client date-intents first.
3. **Real auth for chat PWA** — only if the inbox gains users beyond Ikiel.
4. **Meta signature verification (X-Hub-Signature-256)** — requires raw-body access in the Vercel function (bodyParser off); URL-token hardening shipped as the interim.
5. **Swipe gestures** (iOS back-swipe in PWA), bottom-chrome height tuning on the agent portal.
6. ~~Booking-conflict tooling~~ — reconsidered and dropped: Samba takes no bookings itself; iCal + manual ranges are both "booked" sources and are already unioned, so there is no conflict surface to police.

## 6. Design system reference

> **Superseded (Jul 2026):** the shipped design system is `public/brand.css`
> ("Samba Visual Identity Guidelines v1.0") — `--sb-bg:#F4F1ED`,
> `--sb-accent:#E2572B` terracotta, deep-green ink `#131A17`, Satoshi + Inter.
> The palette below was an earlier proposal and does NOT match production;
> kept only for historical context.

- **Palette (historical proposal)**: cream/terracotta identity — `--bg:#FAF8F5`, `--accent:#C46E4B`, ink `#1C1917`. Owner portal uses dark-warm variant (dark clay ink background, same accent). Chat PWA swaps WhatsApp green for the same family.
- **Type**: Geist UI + Playfair display accents; scale 12/14/16/18/24/32; `font-variant-numeric: tabular-nums` for all money and dates.
- **Shape/depth**: 6px radii on controls; cards `0 1px 3px rgba(0,0,0,.1)`, modals `0 10px 25px rgba(0,0,0,.15)`.
- **Motion**: 150ms ease color, 100ms scale; button press scale .98; skeleton shimmer only after 2s.
- **A11y**: 44px touch minimum, 2px focus rings offset 2px, aria-labels on all icon buttons, WCAG AA contrast on status colors.
- **Status colors**: available `#2E7D4F`, booked terracotta-ink, warning amber `#B45309` — always paired with a text label, never color-only.
