# Quiz funnel length variants (A/B/C) — design

Date: 2026-07-24 · Status: approved by Mintaras (chat)

## Goal

Test whether a shorter quiz converts better. Three variants, routed by **separate
URLs** (one per ad campaign), tracked per lead in `quiz_sessions.ab_test_name` /
`ab_test_variant` (columns already exist and flow through `submit-quiz`; nothing
populates them today).

| Variant | URL | Content |
|---|---|---|
| A (control) | `taimotion.com/quiz` | Current full funnel, unchanged |
| B | `taimotion.com/quiz-b` | A minus the entire third progress segment ("Lifestyle" incl. Health & Safety and Almost There sub-parts) |
| C | `taimotion.com/quiz-c` | B minus height/weight/goal-weight inputs and the weight-projection screens |

`ab_test_name`: `quiz_length_2026_07`. Landing page keeps linking to `quiz.html`
(variant A); ads for B/C point directly at the variant pages — the age gate lives
inside the quiz page, so direct entry works.

## Mechanism

**One master config, variant cut-lists, thin pages.**

- `assets/config.js` — add:
  ```js
  window.FUNNEL.abTestName = "quiz_length_2026_07";
  window.FUNNEL.variants = {
    b: { cut: [/* 33 ids below */], copy: { projection_2: { body: "Now let's create your personalized plan." } } },
    c: { cut: [/* B's 33 + 5 below */], copy: { intro_eligible: { blockBody: /* goal-free wording */ } } },
  };
  ```
- `quiz-b.html` / `quiz-c.html` — byte-identical copies of `quiz.html` plus one
  line before `config.js`: `<script>window.QUIZ_VARIANT = "b";</script>`.
- `assets/app.js` (quiz engine) — at boot:
  1. Resolve `V = window.QUIZ_VARIANT || "a"`.
  2. If session has a different `ab_test_variant` and quiz is in progress → reset
     to index 0 (page's variant wins; keeps index-based resume coherent).
  3. Set `S.ab_test_name` / `S.ab_test_variant`; persist (submit-quiz already
     writes both columns; Slack new-lead ping already prints the variant).
  4. Filter screens: `F.screens = FUNNEL.screens.filter(s => !cut.has(s.id))`,
     apply `copy` overrides, and drop `"Lifestyle"` from `SECS` for b/c (progress
     bar shows 2 segments).
  5. Add `variant` to the `quiz_start` / `quiz_step` TM.track props.

Everything downstream of the screen array (back button, femaleOnly skips,
`?autotest=1`, `?step=N`) operates on the filtered list and needs no changes.

## Cut lists

**B cuts (33 ids)** — the whole span from `tension` to `daypart`, including
untagged interim info/loader screens inside it:
`tension, intro_stress, water, mood, intro_focus, rested, sleep_improve,
intro_sleep, diet, produce, intro_nutrition, cravings, habits, tracker,
intro_brain, medications, mobility, intro_safe, menopause,
intro_menopause_weight, loader, intro_goodhands, intro_almost, main_reason,
motivates, motivation_level, obstacles, intro_sustainable, explore, pace,
intro_paced, intro_focus20, daypart`

Kept: `loader_plan`, `email`, `name`, `goals` (capture chain).

**C cuts (B + 5 ids):** `height, weight, goal_weight, projection_1, projection_2`.
Projections must go because their charts render fabricated fallback numbers
(`S.weight_kg || 92`) when weight is absent. `intro_smallchange` (generic 5%
claim, no placeholders) and `intro_eligible` (weight-free chart) stay;
`intro_eligible.blockBody` gets a copy override dropping the `{goal} kg` phrase
(the `{goal}` fallback renders as "your goal kg" — broken English).

## Data-aware rendering (not variant-aware)

- `rGoals` (final goals screen): when `S.weight_kg`/`S.goal_weight_kg` are absent
  → generic headline (no `{goal}kg`, no `{projdate}` — `projDate` is also
  weight-derived), skip the weight chart, keep benefit rows + CTA. The screen
  must stay in C because it sets `status = "completed"` (lead-email drip
  segmentation) and hosts the checkout CTA.
- `checkout.html` already hides the BMI card when `bmi` is null; metabolic age
  falls back to age-band-only. No changes.

## Explicitly out of scope / accepted

- checkout/pay/upsells/edge functions: untouched.
- B and C drop the medications & mobility-restriction questions (user approved;
  general medical disclaimers on quiz/checkout pages remain).
- No random split — assignment is purely by which URL the ad points to.
- PostHog is secondary; analysis runs on `quiz_sessions` grouped by
  `ab_test_variant` (PostHog undercounts this funnel ~20×).

## Testing

- Playwright: run A, B, C end-to-end (age gate → …→ email/name/goals → checkout);
  assert B/C never show a cut screen, C never asks height/weight, progress bar
  shows 2 segments on B/C, goals screen renders weight-free on C.
- Verify `quiz_sessions` rows carry the right `ab_test_name`/`ab_test_variant`
  (then delete test rows).
- `?autotest=1` smoke on each variant page.
- Cache-bust: bump `?v=` on `config.js`/`app.js` script tags in all three quiz
  pages.
