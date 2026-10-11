# sous at the pass: art direction v3, page v4 ("evening service")

A late-evening pass seen by the server: warm heat-lamp pools on cool steel and deep shadow, drawn with the
restraint of a modern pixel game (Dave the Diver: few outlines, rich ramps, light that does the storytelling).
Every label is readable, one thing happens at a time, and the brigade visibly nests: a head lead, station leads
with their own cooks, plates merged one by one into your order.
v3 folds in the owner's round-1 direction (O1 to O6 below) and the round-1 review (REVIEW-1.md); it
supersedes v2. The v1 diagnosis is retired: v1 is fully replaced.

## 0. Owner direction (binding)

- O1 Nesting: show that a lead can run a whole team under it, several levels deep. In the scene, two station
  leads (chefs de partie), each directing their own cooks, plus a brigade board on the back wall. On the page,
  a section with a clear tree diagram.
- O2 Orders: a readable live order ticket in HTML under the scene shows the goal and its parts, and ticks
  parts off as plates come out, in sync with the animation. Canvas tickets stay as decoration.
- O3 One type system: pixels only in the artwork. IBM Plex Sans everywhere else (wordmark, headings, tags,
  stats), and IBM Plex Mono for commands. No pixel webfont is loaded.
- O4 Cooks are just cooks. No harness names (Claude Code, Codex, Pi) in the scene, tags, key or portraits,
  and no harness colours. Colours mean stations (teams). The copy may name harnesses once.
- O5 Commands are proper components (section 8.4).
- O6 The bell rings when a plate has been merged into your order and its check has passed: that part is
  ready for you. The scene, the key and the live ticket all say so.

## 1. Palette

Each scene ramp is light to dark. Outlines use the darkest step of the local ramp; no `#000`, no `#3d2f4a`.

| Ramp | Values |
|---|---|
| steel | `#eef2f4` `#c3ccd4` `#8d9aa8` `#5d6a7c` `#3b4558` `#252c3c` |
| steelLit (inside lamp pools) | `#f2dcc0` `#d4b796` `#a88c72` `#76624f` |
| shadow | `#3a4256` `#2b3144` `#1f2434` `#161a26` `#0f121b` |
| tile / brick | `#4a5468` `#3c4559` grout `#2c3345` |
| wood (walnut) | `#c98a52` `#9a6236` `#6e4226` `#4a2a1a` `#2e1a12` |
| lamp | `#fff4d6` `#ffd98a` `#ffb347` `#e8892b`, coil `#ff6a3a` |
| skin A / B | `#f3c9a6` `#dca07c` `#b7775a` `#7f4c3a` / `#c58c62` `#9b6343` `#6e4230` `#4a2a20` |
| hair | `#6b4a3a` `#4a3128` `#2e1e19` |
| coat lit / shadow | `#fbf6ec` `#e9e1d3` `#c8bfb3` / `#9a9cab` `#6f7287` `#4b4e63` |
| apron (sous) | `#5d6a7c` `#3b4558` `#252c3c` |
| paper | `#f4ecdc` `#e2d6c0` `#bfae93`, ink `#2a2430` |
| food | pasta `#f6d27a` `#e2b04f` `#b9832f`; tomato `#e0483b` `#a82e2e`; herb `#8fcf5a` `#4f8a34` `#2f5a26`; salmon `#ffb08a` `#f07a4e` `#b8502e`; sear `#8a4a2a` `#5a2c1a`; rice/puree `#f7f1e3` `#ddd2bc`; sauce `#7a2a1f` |
| brass | `#fff0b0` `#f2c94c` `#c9962a` `#8a6418` `#5a3f10` |
| sous / head lead (red) | `#ffb0a6` `#f07a6e` `#d6453f` `#9c2b32` `#5e1a22` |
| station A (amber) | `#ffc98a` `#f0a04b` `#d97a2b` `#a8561b` `#6e3510` |
| station B (blue) | `#a9d4fa` `#6fb3f2` `#3f86d6` `#2a5ea3` `#1b3c6e` |
| check (only for the chit and ticks) | `#c8f0a0` `#7fcf5a` `#3f8f3a` |

Page tokens:

| Token | Value | Contrast |
|---|---|---|
| `--night` `--night-2` | `#1b1f2c` `#262b3b` | hero, scene frame, tags, command cards |
| `--linen` `--panel` `--panel-2` | `#efe7da` `#f8f3ea` `#e3d9c8` | body, cards |
| `--ink` / `--text-2` / `--text-3` | `#1f2230` / `#3d3a45` / `#4a4540` | see 7.4; `--muted #5c564f` is retired for text (v4) |
| `--on-night` / `--on-night-muted` | `#f3ece0` / `#b3adbf` | 14.0 and 7.5 on night, 12.0 and 6.5 on night-2 |
| `--lamp` / `--lamp-ink` | `#ffb347` / `#9a4a12` | lamp only on dark (9.2); lamp-ink for links on light (5.1) |
| `--paper` / `--paper-ink` / `--paper-muted` | `#f4ecdc` / `#2a2430` / `#5c564f` | 12.8 / 6.2 (live ticket) |
| station text on light | A `#9a4a12`, B `#2a6a9e` (4.9), sous `#b3402f` (4.8), check `#2f7442` (4.8) | bold 14 px and up only |
| `--line` | `#2b2f40` | borders |
| footer | `#3a2418`, text `#f3ece0` (12.4), muted `#d9b48c` (7.5) | |

No text pair below 4.5:1. Never use the light ramp colours (`#f0a04b`, `#6fb3f2`) as text on light.

## 2. Lighting and depth

- Layers: back kitchen (lightness 10 to 45%, cool, at most `#9a9cab` except flames and 1 px rim lights),
  mid (sous, station leads, range: 15 to 85%), front (pass, plates, bell, hand, tickets: 10 to 100%).
- Heat lamps hang at x 172, 268, 364 and light only downward. Pools on the pass are ellipses (rx 46, ry 12,
  centre y 194) painted in steelLit: grain tone 0 → steelLit[1], tone 1 → steelLit[3], plain → steelLit[2].
  A core ellipse (rx 22, ry 5) is one step lighter, with 3 to 5 broken 1 px `#fff4d6` streaks along the grain.
  2 px checker edge to `steel[3]`. Front lip inside |x−lx| ≤ 40 uses steelLit[0]/[1]. The additive `#ffb347`
  layer is used only over pools, at 6/10/14%. No glow on the back wall.
- The sous's toque, face, shoulders and hands take the lit ramps; his apron and lower coat do not.
- Back kitchen: graded with `#0f121b` at 35%. Burner glow is a 28x4 band at y 144 to 147 over each active
  pan, in two quantised `lamp[3]` steps. Each cook has a 1 px `lamp[3]` rim on the side toward the burner.
- Shadows are solid ramp steps: plate 2 px ellipse, 6 px `shadow[3]` band under the top shelf, the sous's
  4 px shadow on the back of the pass, a 3 px shadow under the hand. Plates and the bell reflect 4 to 6 px
  into the pass at 25%.
- Ticket paper outside pools is `paper[1]`, with only the top 6 rows in `paper[0]`. Fewer than 3,000 pixels
  in the ticket area may exceed 90% lightness.

## 3. Typography and legibility (O3)

- Artwork (canvas, pixel icons, portraits) is the only pixel type: the 5x7 ticket numbers, drawn natively.
  No other words are painted.
- UI: IBM Plex Sans 400/500/600/700 for everything (wordmark 700 at 64 to 96 px with −0.02em tracking;
  h2 600 at 28 to 40 px; tags 600 13 px; stats 600 tabular). IBM Plex Mono 400/600 only for commands, paths
  and code. Do not load Pixelify or Nunito.
- Tags over the scene: 13 px (12 px minimum), `--on-night` on `--night` at 92%, 1 px `#3b4558` border,
  radius 3 px, 4x8 padding, a 6 px square in the role colour. Positioned in percentages of the 480x270 frame.
  Below 860 px they become 18 px numbered markers that match the key.
- Canvas scaling: backing store `480*k` with `k = ceil(cssWidth*dpr/480)`, CSS width 100%, aspect 16/9,
  `image-rendering: pixelated`, no horizontal scroll at any width. Scene scale 2 (960 CSS px) at desktop.

## 4. Motion budget

Time-based, 10 s per plate, positions snapped to integer pixels, sprites at 8 fps. At most 2 event motions
plus 3 ambient loops at once. easeOutCubic for arrivals, easeInCubic for exits, easeInOutCubic for slides.

Pools: 172 = landing for station A's plates, 268 = tasting and pick-up, 364 = landing for station B's
plates. Bell at x 210 to 235 in front of the sous. Plates come from station B two times out of three.
The cycle starts with a plate already resting at 268.

| t (s) | Beat | What moves |
|---|---|---|
| 0.0 | Call | the sous turns his head toward the station that plates next; the live ticket marks that part "cooking" |
| 0.3 | Relay (O1) | that station's lead turns and points at one of their cooks (2 frames, 0.4 s); the cook starts stirring |
| 1.4 to 2.1 | Taste | the sous leans in 3 px; the spoon dips once into the plate at 268 |
| 2.4 | Check | the chit pops onto the rim (0.15 s, 1 px overshoot) |
| 2.8 to 3.3 | Bell (O6) | left hand strikes; plunger down 2 px for 2 frames; three 1 px arcs in 3 steps; the live ticket ticks the part, and the matching node on the brigade board fills |
| 3.8 to 5.0 | Take | the hand rises, grips the rim, and exits with the plate |
| 5.4 to 5.95 | Slide | the waiting plate slides from its landing pool to 268 (96 px) |
| 6.4 to 6.95 | Land | the called cook's plate lands in their station's pool (dy −18 → 0) |
| 7.0 to 10 | Rest | ambient only |

When the last part of an order is ticked, add a beat at 7.4: the canvas ticket lifts off the rail onto the spike
(0.4 s), and the next ticket slides in from the left (0.6 s). The live ticket shows "Order complete"
for 2 s, then swaps to the next order. Ambient loops: range steam (≤ 6 wisps), one stirring cook, and the
sous's 1 px breath every 2.4 s. Nothing flickers faster than 4 Hz. Pause button required. The loop stops when
the scene is off-screen or the tab is hidden. Reduced motion: one composed still and "Next beat" stills, no tweens.

## 5. Characters and details (logical pixels)

- **Sous (head lead), x 198 to 262.** Toque top y 74, face y 104 to 126, shoulders y 130, cut by the pass at
  176. Torso tapers from 64 px at the shoulders to 54 px. Sleeves to the elbow at y 152, then a 3 px rolled cuff
  and a 20 px forearm angled 3 px inward, with hands on the lip at x 214 and 252. A dark waist apron from y
  150 (`apron` ramp, folds every 9 to 12 px, a 2 px tie with a knot at x 236). Red neckerchief, 2x3 brass
  buttons, moustache, no blush. Poses: idle, look-left, look-right, lean-taste, strike.
- **Station leads (O1).** Two of them, 34x56, a toque 6 px taller than the cooks' caps, a 8x10 clipboard
  with paper, and a neckerchief and apron in their station colour. Station A's lead stands at x 64, with 1 cook
  at x 132 at a prep counter (top y 150, x 44 to 192). Station B's lead stands at x 316, with 2 cooks at x 386
  and 446 at the range. Poses: idle, turn, point (arm toward the cook).
- **Cooks, 34x52.** Skin A/B mixed, short toques (base `#6f7287`, 3 pleats `#4b4e63`, a 3 px `#9a9cab` band),
  station-colour apron and neckerchief, and a pan, pot or board. No individual names.
- **Brigade board (O1).** Dark board 56x34 at x 290 to 345, y 54 to 87, with a 1 px `wood[3]` frame, between
  lamps 268 and 364 above station B's lead. It shows the tree in 1 px chalk lines (`#8d9aa8`): a red root
  4x4 at (316,58); station nodes 4x4 at (300,68) amber and (332,68) blue; cook nodes 3x3 at (300,79) and at
  (326,79) and (338,79). A cook node fills with `check[2]` when its part is ticked, and the board resets with
  each new order. No text.
- **Tickets.** 34x52 at pitch 37: x 8, 45, 82, 119, at y 30/31 alternating. A 4 px header band in red for
  the whole order. `#0144` in 5x7, then one scribble row per part, each with a 3x3 box ticked in `check[2]`
  as parts pass. The leftmost (current) ticket's ticks match the live ticket.
- **Plates.** 56x16 with a 2-step rim, a well shadow and a specular when in a pool. Three dishes rotate:
  - pasta nest with tomato and basil
  - seared salmon 22x7 (crosshatched sear, 3 fat lines) on an 18x6 puree quenelle, with 3 sauce dots
  - risotto mound
  The flag is a 1x14 pick with a 10x7 flag in the station colour. The check chit is 10x8 with a 5x4 tick.
- **Pass (y 176 to 212):** brushed steel grain, a 3 px bevelled lip, lamp pools.
- **Server side (y 212 to 270):** walnut front. A spike at x 24 (12x3 base, 30 px rod) that holds finished
  order tickets as 8x2 slips. A towel draped over the lip at x 58 (16 px wide, hanging to y 238, a 2 px red
  stripe at y 230).
- **Bell:** brass, 20x16 on a 24x4 dark base. Only the plunger and arcs move.
- **Hand:** the sleeve enters diagonally from (slot+20, 270), 18 px wide, in `shadow[2..4]`, with an 18x5
  cuff in `coat[0..2]`. The hand is 20x18 with four 3 px fingers and a 4x7 thumb. Poses: open, grip, carry.

## 6. Composition (480x270)

```
y   0 ┌ top shelf: plate stacks, bottles (dark) ─────────────────────────────────────────┐
   24 ├ fascia + rail ── lamp@172 ─────────── lamp@268 ──────────── lamp@364 ───────────┤
   30 │ [T][T][T][T] x8–153                                 board x290–345 y54–87      │
   74 │                         SOUS toque top                                         │
  100 │ St.A lead x64  cook x132       face y104–126        St.B lead x316 cooks x386,446│
  150 │ prep counter y150 ───────────  apron ───────────── range y150–176 ────────────│
  176 ├ pass: pool 172 (A lands) │ bell 210–235 │ pool 268 (taste, take) │ pool 364 (B) ┤
  212 ├ walnut: spike x24, towel x58 ──────── hand rises at x 268 ─────── "You" tag ───┤
  270 └──────────────────────────────────────────────────────────────────────────────────┘
```

The eye lands first on the sous's lit face and the plate at 268, then follows the nesting outward (sous →
station lead → cook) and down to the bell and the hand. Keep 8 px clear around faces. Tags (at most 8):
Orders, Sous · head lead, Station lead (on B's lead), Cooks (on B's cooks), Brigade board, Check, Bell,
You. They must not overlap at any beat, and the hand must never cross one.

## 7. Page (v4: one grid, short copy)

7.1 **One column.** Every block on the page uses the same outer edges: hero text, install card, scene frame,
live ticket, every h2, every component and the footer text.
- `--col` is the frame's outer width: 976 px (scene at scale 2: 960 + 2×2 border + 2×6 padding), or 1456 px
  (scale 3) under `@media (min-width: 1520px) and (min-height: 1000px)`.
- Every block is `width: min(var(--col), 100% - 32px); margin-inline: auto`. There are no other max-widths on
  blocks: no 70ch leads and no 976 inset for the scene.
- Below 1008 px the column is the viewport minus 16 px gutters. There, and only there, the scene scales
  fluidly as in section 3.
- Expected edges (L/R in CSS px, for verifying from screenshots):
  - 1280 wide: 152 / 1128
  - 1600 wide (height < 1000): 312 / 1288
  - 1600x1000 or taller: 72 / 1528
  - 2000 wide, height 1000 or more: 272 / 1728
  - 2000 wide, height under 1000: 512 / 1488
  - 390 wide: 16 / 374
- Inside a block, content is left-aligned to the column. Grids fill the full column width (`1fr` tracks),
  so their right edge is the column's right edge. A single line of prose may end early. Nothing is centred
  inside the column except the scene itself.
- Verify on the published artifact as well as with render.cjs. The owner saw a left-hugging column at about
  2000 px that render.cjs does not reproduce (it centres at 272/1728). Compare the published page's
  screenshot edges against this table.

7.2 **Vertical rhythm** (8 px base; tokens `--s1` to `--s7` = 8, 12, 16, 24, 32, 64, 96):
- hero top padding 48; wordmark → tagline 12; hero row → scene 32; scene → ticket 16; ticket → end of hero 64
- section → section 96 (64 below 760 px)
- h2 → intro line 12; intro → component 24; inside components 16
- footer padding 32/48
- No other margins. Delete the per-element `margin-top` values from v4.

7.3 **Type sizes:**
- wordmark 96/0.95 700 (64 on phones)
- tagline 20/1.45
- h2 32/1.2 600 (26 on phones)
- section intro: one line, 18/1.5 `--ink`
- component label 16/1.3 600
- component line 15/1.45 `--text-2`
- caption or metadata 14/1.4 `--text-3`
- No paragraph longer than 2 lines at the column width; the copy budgets are in COPY v4.

7.4 **Text colour (WCAG AA, no pale grey on white):**

| Use | On linen `#efe7da` / panel `#f8f3ea` | On night `#1b1f2c` / night-2 `#262b3b` | On paper `#f4ecdc` |
|---|---|---|---|
| primary | `--ink #1f2230` (12.9 / 14.3) | `#f3ece0` (14.0 / 12.0) | `#2a2430` (12.8) |
| secondary (`--text-2`) | `#3d3a45` (9.1 / 10.1) | `#d6d0de` (10.9 / about 9.5) | `#3d3a45` (about 9.5) |
| tertiary (`--text-3`, 14 px+ only) | `#4a4540` (7.7 / 8.6) | `#b3adbf` (7.5 / 6.5) | `#4a4540` (about 8) |
| link / accent | `#9a4a12` (5.1 / 5.7) | `#ffb347` (9.2) | `#9a4a12` |

- `#5c564f` (`--muted`) is retired for text.
- No text on light backgrounds lighter than `#4a4540`.
- Descriptions use `--text-2`, never tertiary.

7.5 **Section order** (shorter page; text from COPY v4, and a section the copy drops is dropped here too):
1. Hero (wordmark, tagline, install card), scene, live ticket.
2. Read the pass: the key strip (8.5).
3. Teams under a lead: one intro line plus the brigade diagram (8.2).
4. One service in five beats: the beat row (8.6).
5. A real service: the stat row (8.7) plus one line.
6. Get started: one prerequisite line plus 3 command cards (8.4, 8.8).
7. Footer.
"The brigade", "What you control" and "Built for a real service" are removed as sections. If COPY v4 keeps up
to 6 short facts, they use the fact grid (8.9) inside section 6 or 5. No tall `dl` panels.

## 8. Components

8.1 **Live order ticket.** As built in v4, but at full column width. The footer note's text is `--text-2`
on paper (`#3d3a45`), not muted.

8.2 **Brigade diagram.**
- Markup and nodes as before.
- The tree spans the column: each level is a CSS grid whose tracks fill the column, so the leftmost node
  starts at the column's left edge and the rightmost ends at its right edge (the root centred above).
- Node text: label 14/600 `--ink`, sub-line 13 `--text-2`.
- At most one caption line under it.

8.3 **Pixel icons and vignettes.** Unchanged.

8.4 **Command card.** Unchanged, except:
- descriptions use `#d6d0de`
- the long `sous run` command wraps at spaces with a hanging indent
- no group headings when there are only 3 cards

8.5 **Key strip** (replaces the tall key cards).
- One `--panel` block, 2 px `--line`, radius 6.
- 8 cells: 8-across at col 1456, 4×2 at col 976, 2×4 below 760, 1 column below 420.
- Cells are separated by 1 px `#d5cbb9` rules, not separate cards.
- Cell: padding 16. Row 1 is the 40 px icon plus the number badge. Then the label (16/600 `--ink`, 1 line)
  and one line of at most 8 words (15/1.45 `--text-2`, at most 2 lines).
- Equal cell heights per row, about 140 px. No inline code in cells.

8.6 **Beat row.**
- 5 cells in one row at ≥ 976 (5 equal tracks with 16 gaps, no arrows; a 2 px `--line` top rule with the
  step number on it).
- Cell: a 144x96 vignette (72x48 at 2x), the title 16/600, and one line of at most 12 words.
- Equal heights. 2 columns at 760 to 975, 1 column below 760 (vignette left, text right).

8.7 **Stat row.**
- One `--panel` block with 4 equal cells and 1 px `#d5cbb9` dividers.
- Cell: number 36/1.1 600 tabular `--ink`, label 14 `--text-2`.
- Height about 104. 2×2 below 760.

8.8 **Get started.** One line of prerequisites (`--ink`), then 3 command cards in 3 equal tracks at ≥ 976
(install, run, status), 1 column below 760.

8.9 **Fact grid** (only if the copy keeps facts).
- 2 or 3 equal tracks, no panel background, a 2 px `--line` top rule per fact.
- Label 16/600, one line 15 `--text-2`.
- At most 6 facts.

## 9. Review checklist (pass/fail)

1. Lightness above 90% only in pools and front-layer objects; fewer than 3,000 such pixels on the tickets.
2. Back kitchen ≤ `#9a9cab` (relative luminance), except flames and 1 px rim lights.
3. All scene `drawImage` calls are 1:1, except the integer present step.
4. The canvas uses only palette colours or documented light blends (20-sample test, ≤ 6 per channel).
5. No `#000000` or `#3d2f4a` in the canvas.
6. The canvas paints no words except ticket numbers.
7. HTML text over or near the scene is ≥ 12 CSS px and ≥ 4.5:1.
8. At 390 px: no horizontal scroll, the full frame is visible, and markers match the key one-to-one.
9. At 1280 px: canvas 960x540, ticket numbers ≥ 10 CSS px.
10. Nesting (O1): two station leads with their own cooks are visible, a station lead's point follows each
    call, the brigade board shows 3 levels, and the page has the brigade diagram as a nested list.
11. The live ticket (O2) is under the scene, readable (≥ 15 px), and ticks the right part within 0.2 s of
    the bell, in every frame of a 60 s capture.
12. Fonts (O3): only IBM Plex Sans and Plex Mono are loaded, and no element's computed font is a pixel family.
13. No "Claude", "Codex" or "Pi" in the scene tags, key, portraits or diagram (O4); the copy names them at most once.
14. Command cards (O5) have a prompt, a working copy, a select fallback (tested with `navigator.clipboard`
    undefined) and a description.
15. The bell (O6) rings only after a chit; the key and the live ticket define it as "merged and checked,
    ready for you".
16. Lamp pools are warm: (268,194) has R − B ≥ 40, there is no grey ring, and there are no halos on the wall.
17. At least 2 of the 3 pools hold a plate or the bell in every frame except during slides; pool 268 is empty
    ≤ 1 s per cycle.
18. Sous: shoulders at y 130 ± 3, forearm ≤ 22 px, apron from y 150, nothing overlapping his face.
19. ≤ 5 elements change per frame (excluding steam), no flicker > 4 Hz, the bell body stays still, pause
    works, and the loop stops when the scene is off-screen.
20. Reduced motion: a single still plus "Next beat", and the live ticket shows a mid-order state.
21. No tag overlaps another, and the hand never crosses a tag; "You" sits within 40 px of the hand's path.
22. Icons and vignettes clip no object (8.3); every portrait is a distinct face.
23. Page: dark hero and footer, linen body, radii ≤ 6, no console errors, all sections from COPY.md present.
24. Page v4: at 1280, 1600 and 2000 (and on the published artifact), every block's L/R edges equal the 7.1 table (±1 px), and at 390 they are 16/374.
25. No text on a light background uses a colour lighter than `#4a4540`. Descriptions use `#3d3a45`.
26. The key is one strip of 8 cells, each ≤ 160 px tall at col 976. No section has a paragraph over 2 lines at the column width.
27. Section spacing is 96 px (64 below 760), measured h2-top to previous block-bottom ±4.
