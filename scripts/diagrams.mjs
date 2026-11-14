// Draw the README's "How it works" diagram as two SVG files, one for each GitHub theme:
// docs/assets/how-it-works-light.svg and docs/assets/how-it-works-dark.svg. Run `node scripts/diagrams.mjs` after a change.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))

const THEMES = {
  light: {
    text: '#1f2328', muted: '#59636e', faint: '#818b98',
    group: '#f6f8fa', groupLine: '#d1d9e0', card: '#ffffff', cardLine: '#d1d9e0',
    plan: '#8250df', work: '#0969da', verify: '#1a7f37', result: '#9a6700',
    you: '#1f2328', youText: '#ffffff', bar: '#1f2328', barText: '#ffffff', barMuted: '#c9d1d9',
  },
  dark: {
    text: '#f0f6fc', muted: '#9198a1', faint: '#656c76',
    group: '#151b23', groupLine: '#3d444d', card: '#0d1117', cardLine: '#3d444d',
    plan: '#ab7df8', work: '#4493f8', verify: '#3fb950', result: '#d29922',
    you: '#f0f6fc', youText: '#0d1117', bar: '#262c36', barText: '#f0f6fc', barMuted: '#9198a1',
  },
}

const W = 1040
const H = 400
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace`

// Stage columns: x, width, accent key, step label.
const STAGES = [
  { x: 24, w: 120, key: 'muted', label: 'ASK' },
  { x: 196, w: 176, key: 'plan', label: 'PLAN' },
  { x: 424, w: 196, key: 'work', label: 'WORK' },
  { x: 672, w: 172, key: 'verify', label: 'VERIFY' },
  { x: 872, w: 144, key: 'result', label: 'RESULT' },
]
const TOP = 64
const BOTTOM = 296

function draw(t) {
  const out = []
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const text = (x, y, s, { size = 14, weight = 400, fill = t.text, anchor = 'middle', font = SANS, spacing = 0 } = {}) =>
    out.push(`<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" ` +
      `text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`)

  // A card: rounded box with an accent bar on the left, a title and an optional subtitle.
  const card = (x, y, w, h, accent, title, sub, { mono = false } = {}) => {
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${t.card}" stroke="${t.cardLine}"/>`)
    out.push(`<rect x="${x + 8}" y="${y + 12}" width="3" height="${h - 24}" rx="1.5" fill="${accent}"/>`)
    const cx = x + w / 2 + 2
    if (sub) {
      text(cx, y + h / 2 - 3, title, { weight: 600 })
      text(cx, y + h / 2 + 14, sub, { size: 11.5, fill: t.muted, font: mono ? MONO : SANS })
    } else text(cx, y + h / 2 + 5, title, { weight: 600 })
  }

  // An arrow along a path, with an arrowhead in the given colour.
  const markers = new Set()
  const arrow = (d, color, { dashed = false } = {}) => {
    const id = `head-${color.slice(1)}`
    markers.add(`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" ` +
      `orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9 z" fill="${color}"/></marker>`)
    out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"${dashed ? ' stroke-dasharray="5 4"' : ''} ` +
      `marker-end="url(#${id})"/>`)
  }
  const curve = (x1, y1, x2, y2) => `M${x1} ${y1} C${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2 - 2} ${y2}`

  // Stage headers and panels.
  STAGES.forEach((s, i) => {
    const color = t[s.key]
    out.push(`<circle cx="${s.x + 10}" cy="38" r="9" fill="${color}"/>`)
    text(s.x + 10, 42, String(i + 1), { size: 11, weight: 700, fill: t.card })
    text(s.x + 26, 42, s.label, { size: 12, weight: 700, fill: color, anchor: 'start', spacing: 1.2 })
    if (i > 0) out.push(`<rect x="${s.x - 8}" y="${TOP}" width="${s.w + 16}" height="${BOTTOM - TOP}" rx="12" ` +
      `fill="${t.group}" stroke="${t.groupLine}"/>`)
  })

  // 1. You.
  const you = { x: 24, y: 150, w: 120, h: 44 }
  out.push(`<rect x="${you.x}" y="${you.y}" width="${you.w}" height="${you.h}" rx="22" fill="${t.you}"/>`)
  text(you.x + you.w / 2, you.y + 27, 'You', { weight: 600, fill: t.youText })

  // 2. Plan: a lead and a sub-lead.
  const lead = { x: 196, y: 96, w: 176, h: 60 }
  const sub = { x: 212, y: 196, w: 160, h: 56 }
  card(lead.x, lead.y, lead.w, lead.h, t.plan, 'Lead', 'splits the goal')
  card(sub.x, sub.y, sub.w, sub.h, t.plan, 'Sub-lead', 'splits a part')
  arrow(`M${sub.x + sub.w / 2} ${lead.y + lead.h} V${sub.y - 2}`, t.plan)

  // 3. Work: workers in parallel, each in its own worktree or folder.
  const workers = [
    { y: 84, title: 'Worker', sub: 'Claude Code' },
    { y: 152, title: 'Worker', sub: 'Codex' },
    { y: 220, title: 'Worker', sub: 'Pi or Droid' },
  ].map((w) => ({ ...w, x: 424, w: 196, h: 56 }))
  for (const w of workers) card(w.x, w.y, w.w, w.h, t.work, w.title, w.sub)

  // 4. Verify: merge queue, then checks.
  const merge = { x: 672, y: 96, w: 172, h: 60 }
  const check = { x: 672, y: 196, w: 172, h: 56 }
  card(merge.x, merge.y, merge.w, merge.h, t.verify, 'Merge queue', 'one at a time')
  card(check.x, check.y, check.w, check.h, t.verify, 'Check', 'exit 0 passes')
  arrow(`M${merge.x + merge.w / 2} ${merge.y + merge.h} V${check.y - 2}`, t.verify)

  // 5. Result.
  const result = { x: 872, y: 136, w: 144, h: 76 }
  out.push(`<rect x="${result.x}" y="${result.y}" width="${result.w}" height="${result.h}" rx="8" fill="${t.card}" stroke="${t.cardLine}"/>`)
  out.push(`<rect x="${result.x + 8}" y="${result.y + 12}" width="3" height="${result.h - 24}" rx="1.5" fill="${t.result}"/>`)
  text(result.x + result.w / 2 + 2, result.y + 26, 'Result', { weight: 600 })
  text(result.x + result.w / 2 + 2, result.y + 45, 'sous/<run-id>', { size: 11.5, fill: t.text, font: MONO })
  text(result.x + result.w / 2 + 2, result.y + 61, 'or output folder', { size: 11.5, fill: t.muted })

  // Flow arrows.
  arrow(curve(you.x + you.w, you.y + 14, lead.x, lead.y + 22), t.faint)
  text(168, 122, 'goal', { size: 11.5, fill: t.muted })
  arrow(`M${lead.x - 2} ${lead.y + 46} C${170} ${lead.y + 46}, ${170} ${you.y + 32}, ${you.x + you.w + 2} ${you.y + 32}`,
    t.faint, { dashed: true })
  text(170, 214, 'questions', { size: 11.5, fill: t.muted })

  arrow(curve(lead.x + lead.w, lead.y + 30, workers[0].x, workers[0].y + 28), t.faint)
  arrow(curve(lead.x + lead.w, lead.y + 30, workers[1].x, workers[1].y + 28), t.faint)
  arrow(curve(sub.x + sub.w, sub.y + 28, workers[2].x, workers[2].y + 28), t.faint)
  for (const w of workers) arrow(curve(w.x + w.w, w.y + 28, merge.x, merge.y + 30), t.faint)
  arrow(curve(check.x + check.w, check.y + 28, result.x, result.y + 46), t.faint)

  // The supervisor: the plain code under every stage.
  const bar = { x: 16, y: 324, w: W - 32, h: 60 }
  out.push(`<rect x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}" rx="12" fill="${t.bar}"/>`)
  text(bar.x + 24, bar.y + 26, 'Supervisor', { weight: 700, fill: t.barText, anchor: 'start' })
  text(bar.x + 24, bar.y + 45, 'plain code, not a model', { size: 11.5, fill: t.barMuted, anchor: 'start' })
  const duties = ['starts every process', 'delivers messages', 'writes the event log', 'recovers after a crash']
  duties.forEach((d, i) => {
    const x = 260 + i * 190
    out.push(`<circle cx="${x}" cy="${bar.y + 30}" r="3" fill="${t.barMuted}"/>`)
    text(x + 10, bar.y + 34, d, { size: 12.5, fill: t.barText, anchor: 'start' })
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="How sous works: you give a goal; leads split it; workers do the parts in parallel; a merge queue and ` +
    `checks verify the work; the result is a branch or folder. A supervisor of plain code runs every stage.">\n` +
    `<title>How sous works</title>\n<defs>${[...markers].join('')}</defs>\n${out.join('\n')}\n</svg>\n`
}

mkdirSync('docs/assets', { recursive: true })
for (const [name, theme] of Object.entries(THEMES)) writeFileSync(`docs/assets/how-it-works-${name}.svg`, draw(theme))
