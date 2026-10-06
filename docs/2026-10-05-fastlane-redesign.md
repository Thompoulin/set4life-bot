# 2026-10-05: SureLC portal redesign vs the Fastlane and E&O drivers

Build seen: "BGA (1.124.024 - 201b4a)". After `/surecrm/producers/{id}/model` and the `/profile` bearer
fallback, the first real run failed at `Fastlane 'One Producer Many Carriers' tile not found`, and at the
E&O tab with `Add Existing Policy button not found`.

## What changed on SureLC's side

Seen live (read-only, house account, nothing selected or saved):

- `/bga/fastlane` is three tiles, each a `<bga-mass-contracting-action-link>`. The wanted one is the 2nd
  ("ONE PRODUCER -> MULTIPLE CARRIERS", button START REQUEST). The 3rd tile (Data Express, button SEND UPDATES)
  carries the same two phrases.
- The words have NO spaces in the DOM (`oneproducer...multiplecarriers`; CSS lays them out), so
  `text=/One Producer.*Multiple Carriers/` matched nothing. That is the tile failure.
- START REQUEST goes to `/bga/fastlane/multiCarriers/new/producer/info`. Step 1 is unchanged in structure:
  `<sb-search-filter>` (input `placeholder="Search"`, which now also finds a producer by email),
  `<bga-producer-card>` with `.producer__name`, SELECT button. The list is paginated (100 of 300) and virtual.
  Nav: `button.nav__button` "1 Producer / 2 Carriers / 3 States / 4 Products / 5 Preview", active one has
  `.nav__button--active`; NEXT is disabled until the step validates.
- The old Material-label lookup for the search box matches nothing now (the field has a placeholder, no label);
  the placeholder fallback was what kept working.

Read from the JS bundle (reaching these needs a producer selected, which is a write):

- Carriers: `sb-list-multi-select`, rows `div.items__item.item#item-<carrierId>` with `button.item__select-button`
  (ADD). Selected rows are the same classes without an id. Virtual scroll: only rows near the viewport exist, so the
  step's own "Search by Carrier name" filter is used when a row is not in the DOM. Carriers with a
  `disallowedMessage` have no ADD button.
- States / Products: default to everything checked; at least one of each per carrier; a carrier may cap states.
- Preview ("Contracting Request Preview"): Sending Email (defaults to the producer's email), `Carriers (N)`,
  then SUBMIT replaces NEXT. SUBMIT opens "Processing Contracting Requests": one row per carrier
  (`.grid__row--success` / `--error`), then DONE. The hidden MISC step (DBA / schedule) is disabled in this build.
- E&O tab, producer with no policy: no ADD button. The tab is the `sb-eno-policy-uploader` card ("Upload the
  declaration page of your E&O policy.") with a dropzone and one hidden file input.

## What the bot does now

- Finds the tile with `findOneProducerManyCarriersStart` (fastlaneUi.ts): exactly one match, never Data Express, else
  "tile not found".
- Confirms every NEXT by reading the active nav step; a step that does not advance fails with the step name and
  SureLC's validation text. No button is force-enabled any more (SUBMIT especially).
- Before leaving Carriers: `Selected (N)` must equal the number of carriers added.
- At Preview, before SUBMIT: Sending Email must be one of the emails SureLC holds for the producer
  (`producer_identity_unverified` otherwise) and `Carriers (N)` must equal the number added.
- After SUBMIT: waits for the Processing dialog and reports per-carrier errors (`ok:false`). If the dialog never
  finishes, the request has still been posted and botRunner's post-submit verification decides.
- E&O: if the uploader card is on screen, skips the ADD step and uploads through the dropzone's filechooser.

## Not verified without a write

Everything after step 1: carrier row ids/ADD, the cart counter, States/Products pass-through, Preview readings,
the Processing dialog, and the E&O dropzone upload. The first real run is the test.

## Traps

- Playwright `hasText` / `text=` regexes run on textContent, which has no spaces between words here. Use `\s*`, and
  `[\s\S]*` rather than `.*`.
- Under `tsx` (tests), `page.evaluate` bodies with nested functions need `window.__name = f => f`. Compiled output
  does not.
- `loginAdmin` logs `storageKeys` on a failed token check. One of those keys embeds a JWT
  (`announcements-eyJ...`). Scrub before shipping those logs anywhere.
