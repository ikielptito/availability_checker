# Design ref — Airbnb "Creating a listing" flow (iOS)

Source: Mobbin — Airbnb iOS → Flows → "Creating a listing from Profile" (29 screens)
https://mobbin.com/flows/ac0a721e-274d-4b18-97eb-403b4c59b394
Reviewed 2 Aug 2026 against the Samba owner-portal listing wizard
(portal.html `WIZ_TITLES`, steps: start → basics → story → photos → pricing → contacts → preview).

## Patterns observed in the Airbnb flow

1. **Roadmap before work starts.** First screen is "It's easy to get started" with
   3 numbered chapters + illustrations (Tell us about your place / Make it stand
   out / Finish up and publish). The owner knows the size of the task before
   committing.
2. **Chapter interstitials.** "Step 1 — Tell us about your place" splash screens
   with 3D art between phases: orientation + a moment of rest.
3. **One decision per screen** on mobile; segmented per-chapter progress bar +
   fixed Back/Next footer.
4. **"Save & exit" and "Questions?" pinned on every screen.** Abandoning is
   visibly safe, help is always one tap away.
5. **Trust microcopy exactly at the anxiety point.** Under the address field:
   "Your address is only shared with guests after they've made a reservation."
6. **Defer complexity everywhere.** "You can add more amenities after you
   publish." / "You'll need 5 photos to get started. You can add more or make
   changes later." / "Have fun with it—you can always change it later."
7. **Guardrails as guidance.** Title input: char counter (14/32) + "Short titles
   work best."
8. **Price shown as outcome.** Big numeral ($50) with expandable "Guest price
   before taxes $57" — the host sees what the guest sees.
9. **Cold-start promotions at publish.** "New listing promotion — 20% off your
   first 3 bookings" pre-checked, plus weekly/monthly discount presets with
   recommended values ("Tip: try 0%"). Solves the no-reviews cold start and
   feels like a gift, not a fee.
10. **Post-publish task card.** After publishing, the listings dashboard shows
    "Confirm a few key details — Required to publish": must-do-now vs
    can-do-later is split, so publishing happens at the earliest moment.
11. **Empty state sells the action.** "Your listings" empty state: playful
    illustration + one CTA ("Get started").

## Prioritized changes for the Samba wizard

1. **Surface draft autosave** — wizard already autosaves drafts silently; add a
   "Saved · exit anytime" indicator / explicit Save & exit affordance (pattern 4).
2. **3-item roadmap on the start step** — basics → photos → live to 250+ agents
   (pattern 1). Cheap HTML.
3. **Trust microcopy** under Location and WhatsApp fields — state exactly who
   sees them and when (pattern 5).
4. **Deferral copy on photos step** — "5 photos gets you live — add or reorder
   anytime" (pattern 6; pricing step already has "You can change these anytime").
5. **Title guidance** — char counter + "short names travel best on WhatsApp"
   (pattern 7).
6. **Publish-moment boost card** — at the preview step, state the real launch
   benefit: "New listings are featured in Maya's next daily broadcast to agents"
   (pattern 9 — we already do this; we just never say it).
7. **Post-publish checklist card** on My properties for optional-but-valuable
   items (iCal link → joins daily broadcast; more photos) instead of burying
   them in strength-meter tips (pattern 10).

Samba's wizard already matches several patterns: conversational step titles with
"why we ask" subtitles, progress bar, import-from-Airbnb start, drafts,
phone-frame preview, strength meter.

## Structural principles (applied Aug 2026)

Beyond the screen-level patterns, the flow's architecture generalizes to every
Samba touchpoint:

1. **Lifecycle, not funnel.** A listing is a durable state machine
   (draft → pending_review → live → performing) and every surface reads/writes
   the same state. Samba: wizard drafts, Maya intake (`pending_review`), admin
   review and the portal all already share the custom_properties store; keep it
   that way — no surface gets a private notion of listing state.
2. **Minimum viable commitment, then improve in the loop.** Publish with the
   minimum (name, area, photos, price, WhatsApp); everything else is a
   post-live improvement queue, not a gate. Wizard: story step is skippable;
   the checklist picks up what was skipped.
3. **One next-best-action engine, many mouths.** `lib/next-actions.js` is the
   single source of truth: `fieldChecklist(rec)` (record-only, cheap) feeds the
   My properties card; `nextActions(rec, stats)` (full stats bundle) feeds the
   weekly report payload (`nextActions`), the portal Reports tab, the public
   tokenized report, and Maya server-side (she fetches the same report
   endpoint). Client `repRecs()` in portal.html/report-view.html is only a
   fallback for old payloads. Add rules in the lib, never in a page.
4. **Propose → confirm, never ask → type.** Import-from-URL, AI photo ranking,
   map search already do this. Future candidates: Maya drafting a listing from
   an owner's photos; suggested pricing from comparable catalog villas;
   pre-drafted gap-filler broadcast messages the owner just approves.
5. **Explain data at the moment of consequence.** Standing rule: any field any
   surface collects carries a one-line answer to "who sees this, when".

Deliberately NOT done: auto-claiming Maya-intake listings into a portal
account by matching the owner's self-declared profile WhatsApp number against
`ownerWa` — unverified numbers are spoofable, so WhatsApp-based claiming needs
a verified handshake (e.g. Maya sends a signed claim link) before it's safe.
Email claiming (`claimByEmail`) stays the only automatic path.
