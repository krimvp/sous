// Plain files: collecting a work node's folder into the run's output folder (folder mode), and the leads' read-only look
// at the workspace and the results so far.
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'

/** Names that are never collected or listed (in a git worktree `.git` is a file). */
const SKIP = new Set(['.git', '.sous', 'node_modules'])
const MAX_ENTRIES = 200
const MAX_READ = 32 * 1024

/** Regular files under `dir`, as sorted relative paths with `/`; skipped names and symbolic links are left out. */
function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((d) => {
    const rel = prefix ? `${prefix}/${d.name}` : d.name
    if (SKIP.has(d.name)) return []
    if (d.isDirectory()) return filesUnder(dir, rel)
    return d.isFile() ? [rel] : []
  })
}

const sameFile = (path: string, data: Buffer) => {
  try {
    return lstatSync(path).isFile() && readFileSync(path).equals(data)
  } catch {
    return false
  }
}

/** Copies every regular file under `from` into `into`, keeping its relative path. A file already there with the same
 * content is left as it is, so collecting again after a crash changes nothing. When a different file is there, both are
 * kept: this one is written as `<name>.<node><ext>` and listed in `renamed`. `files` are the paths in `into`. */
export function collect(from: string, into: string, node: string): { files: string[]; renamed: Record<string, string> } {
  const files: string[] = []
  const renamed: Record<string, string> = {}
  for (const rel of filesUnder(from)) {
    const src = join(from, rel)
    const data = readFileSync(src)
    let target = rel
    if (existsSync(join(into, rel)) && !sameFile(join(into, rel), data)) {
      const ext = extname(rel)
      target = `${rel.slice(0, rel.length - ext.length)}.${node}${ext}`
      renamed[rel] = target
    }
    const dest = join(into, target)
    if (!sameFile(dest, data)) {
      mkdirSync(dirname(dest), { recursive: true })
      // Copied whole, then renamed into place: a crash never leaves half a file in the results.
      copyFileSync(src, `${dest}.sous-tmp`)
      renameSync(`${dest}.sous-tmp`, dest)
    }
    files.push(target)
  }
  return { files, renamed }
}

/** A directory a lead may read: the workspace, the results, or (git mode) the integration worktree, which holds both. */
export interface Root {
  /** The first path segment that selects this root when there are several; absent for a single root. */
  name?: string
  path: string
}

/** The real path `path` names under `roots`, or `undefined` for the top level of several named roots. Throws the reason a
 * path is refused: it does not exist, or it resolves (through `..` or a symbolic link) outside its root. */
function locate(roots: Root[], path = ''): { real?: string; shown: string } {
  const parts = path.split('/').filter((p) => p && p !== '.')
  let root = roots[0]
  if (root.name !== undefined) {
    if (!parts.length) return { shown: '' }
    const named = roots.find((r) => r.name === parts[0])
    if (!named) throw new Error(`${path} is not in the run's files: paths start with ${roots.map((r) => `${r.name}/`).join(' or ')}`)
    root = named
  }
  const base = realpathSync(root.path)
  const rest = root.name === undefined ? parts : parts.slice(1)
  let real: string
  try {
    real = realpathSync(resolve(base, ...rest))
  } catch {
    throw new Error(`no such file or directory: ${path}`)
  }
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`${path} is outside the run's files`)
  return { real, shown: parts.join('/') }
}

/** A listing of `path` and everything below it (directories end in `/`, files show their size), at most 200 entries. */
export function listFiles(roots: Root[], path?: string): string {
  const { real, shown } = locate(roots, path)
  const entries: string[] = []
  let more = false
  const walk = (dir: string, prefix: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(d.name)) continue
      if (entries.length === MAX_ENTRIES) return void (more = true)
      const rel = prefix + d.name
      if (d.isDirectory()) {
        entries.push(`${rel}/`)
        walk(join(dir, d.name), `${rel}/`)
      } else if (d.isFile()) entries.push(`${rel} (${lstatSync(join(dir, d.name)).size} bytes)`)
      else entries.push(rel) // a symbolic link or special file: listed, not followed
      if (more) return
    }
  }
  if (real === undefined) {
    for (const r of roots) {
      if (entries.length === MAX_ENTRIES) more = true
      if (more) break
      entries.push(`${r.name}/`)
      walk(r.path, `${r.name}/`)
    }
  } else if (lstatSync(real).isDirectory()) walk(real, shown ? `${shown}/` : '')
  else entries.push(`${shown} (${lstatSync(real).size} bytes)`)
  if (!entries.length) return '(empty)'
  return entries.join('\n') + (more ? `\n(listing stopped at ${MAX_ENTRIES} entries; list a subdirectory to see more)` : '')
}

/** Up to 32 KB of the text file `path` from byte `offset`, with a note on how to read on; `bytes` is how much was read.
 * A directory, or a file with NUL bytes (not text), is refused. */
export function readText(roots: Root[], path: string, offset = 0): { text: string; bytes: number } {
  const { real } = locate(roots, path)
  if (real === undefined || lstatSync(real).isDirectory()) throw new Error(`${path || 'the top level'} is a directory: use list_files`)
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a whole number of bytes, 0 or more')
  const fd = openSync(real, 'r')
  try {
    const size = fstatSync(fd).size
    if (offset > size) throw new Error(`offset ${offset} is past the end of ${path} (${size} bytes)`)
    // A few bytes past the limit, so the cut can move back to the start of a UTF-8 character.
    const buf = Buffer.alloc(Math.min(MAX_READ + 4, size - offset))
    const got = readSync(fd, buf, 0, buf.length, offset)
    if (buf.subarray(0, got).includes(0)) throw new Error(`${path} is not a text file (it has NUL bytes)`)
    let n = Math.min(MAX_READ, got)
    while (n > 0 && n < got && (buf[n] & 0xc0) === 0x80) n--
    const end = offset + n
    const text = buf.subarray(0, n).toString('utf8')
    return { text: end < size ? `${text}\n\n[bytes ${offset}-${end} of ${size}; read on with offset ${end}]` : text, bytes: n }
  } finally {
    closeSync(fd)
  }
}
