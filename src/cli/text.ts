// One-line text helpers for what the CLI prints: a duration, and the first or last line of a text, shortened to one
// line.

/** A duration as 45s, 3m 05s or 2h 05m. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function lastLine(output: string): string {
  return output.trimEnd().split('\n').at(-1) ?? ''
}

/** The first line of a multi-line text, marked as cut when more follows. */
export function firstLine(text: string): string {
  const [first, ...rest] = text.trim().split('\n')
  return oneLine(rest.length ? `${first}...` : first)
}

export function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? line.slice(0, 157) + '...' : line
}
