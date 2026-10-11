# Review 5 (final): pass-v5.html

Evidence:
- `node render.cjs pass-v5.html r5`
- `node ../../measure.cjs r5.render.html a5` (viewport height 1000)
- crops of `a5-1280.png`, `a5-2000.png` and `a5-390.png`

**Verdict: SHIP.** There is no misalignment, no unreadable text, no broken layout and nothing misleading.
Polish below for later, with two cheap text fixes worth doing before sending.

## Measured

- **Edges:** every block (wordmark, tagline, install card's right edge, frame, ticket, each h2, each component,
  footer) sits on the column edges:

  | Width | Edges (L / R) | Note |
  |---|---|---|
  | 2000 | 272 / 1728 | scene at 3x |
  | 1600 | 72 / 1528 | |
  | 1280 | 152 / 1128 | |
  | 390 | 16 / 374 | |

  This matches the ART 7.1 table exactly. The builder also checked 2000x900 and 1600x900 and an
  artifact-skeleton wrapper.
- **Rhythm:** h2 to the previous block bottom is 96 px in every section at 1280
  (1556→1652, 2025→2121, 2341→2437).
- **Heights:** the page is 3,064 px at 1280 (limit 4,500) and 4,748 px at 390 (limit 8,000). The key strip
  is 318 px at 1280 (limit 330).
- **Text:** descriptions are dark and readable on panels. The phone shows the key as 1 column, the tree as an
  indented list, the stats as 2x3 and the commands stacked. No horizontal scroll.

## Deviations

All accepted:
- key icons 48x56, for a whole-number sprite scale
- a 6-cell stat row, matching COPY v4
- hero links dropped (GitHub stays in the footer)
- the "models" fact dropped

## Polish (not blocking)

1. **Fact grid text (cheap; do before sending).**
   - Two cells pair unrelated facts: "Merges go one at a time; / conflicts go to an integrator agent." splits
     one sentence across label and line. "Exports ATIF and Langfuse traces. / No sandbox: workers have full
     permissions." puts a safety note under a traces label.
   - Give each cell one fact, with a label and a line.
   - Use one label style: either all code (mono) or all sans. Today they are mixed, and the lines start in
     lower case.
   - Hand this to the copywriter.
2. **The install command wraps at 1280** ("npm install -g / @krimvp/sous") in a 3-track row. Give the command
   row `grid-template-columns: 1.3fr 1fr 1fr`, or let short commands use `white-space: nowrap` when they fit
   in 32ch.
3. **Tree level 3 sits under the wrong parents.** Parser's children are laid out under the Evaluator and CLI
   columns. The connectors are correct, but a quick read can misattribute them. Start Parser's children row
   at Parser's column (or wrap them in a faint group box), so nothing sits directly beneath a sibling sub-lead.
4. **Scene items carried over from REVIEW-3:** pool falloff, towel, station-lead faces under the grade, and
   the Split vignette (unused now).
