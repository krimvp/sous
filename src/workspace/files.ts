// Plain files: collecting a work node's folder into the run's output folder (folder mode), and the leads' read-only look
// at the workspace and the results so far.
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join, resolve, sep } from 'node:path'
import { MAX_ENTRIES, MAX_READ } from '../contracts/index.ts'

/** Names that are never collected or listed (in a git worktree `.git` is a file). */
const SKIP = new Set(['.git', '.sous', 'node_modules'])

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

/** Copies every regular file under `from` into `into`, keeping its relative path. Nothing in `into` is ever replaced or
 * followed: where a different file, a link or a directory is in the way of a file (or a file or link in the way of a
 * directory), this one takes the first of `<name>.<node><ext>`, `<name>.<node>-2<ext>`, … that is free or fits (a file
 * with the same content; a real directory), and is listed in `renamed`. A file already there with the same content is
 * left as it is, so collecting again after a crash picks the same names and changes nothing. Each copy is staged under a
 * unique name in `stage` and renamed into place, so a crash never leaves half a file. `files` are the paths in `into`. */
export function collect(from: string, into: string, node: string, stage: string): { files: string[]; renamed: Record<string, string> } {
  const files: string[] = []
  const renamed: Record<string, string> = {}
  for (const rel of filesUnder(from)) {
    const data = readFileSync(join(from, rel))
    const parts = rel.split('/')
    const name = parts.pop()!
    let dir = ''
    for (const part of parts) dir = join(dir, pick(join(into, dir), part, '', node, (p) => lstatSync(p).isDirectory()))
    const ext = extname(name)
    const target = join(dir, pick(join(into, dir), name.slice(0, name.length - ext.length), ext, node, (p) => sameFile(p, data)))
    if (target !== rel) renamed[rel] = target
    const dest = join(into, target)
    if (!existsOrLink(dest)) {
      mkdirSync(join(into, dir), { recursive: true })
      const staged = join(stage, `.collect-${randomUUID()}`)
      copyFileSync(join(from, rel), staged, constants.COPYFILE_EXCL)
      try {
        renameSync(staged, dest)
      } catch (err) {
        rmSync(staged, { force: true })
        throw err
      }
    }
    files.push(target)
  }
  return { files, renamed }
}

/** The first of `<stem><ext>`, `<stem>.<node><ext>`, `<stem>.<node>-2<ext>`, … in `dir` that is free or `fits`. */
function pick(dir: string, stem: string, ext: string, node: string, fits: (path: string) => boolean): string {
  for (let k = 0; ; k++) {
    const name = k === 0 ? stem + ext : `${stem}.${node}${k === 1 ? '' : `-${k}`}${ext}`
    if (!existsOrLink(join(dir, name)) || fits(join(dir, name))) return name
  }
}

const existsOrLink = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Folder mode: the own folder of a work or check node, with the links `workspace` (to the inputs) and `results` (to the
 * output folder), so these names mean the same to leads, workers and checks. Collecting skips the links. */
export function linkedFolder(dir: string, workspace: string, output: string): string {
  mkdirSync(dir, { recursive: true })
  for (const [name, target] of [['workspace', workspace], ['results', output]]) {
    try {
      lstatSync(join(dir, name))
    } catch {
      symlinkSync(target, join(dir, name), 'dir')
    }
  }
  return dir
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
  if (real === undefined || statSync(real).isDirectory()) throw new Error(`${path || 'the top level'} is a directory: use list_files`)
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a whole number of bytes, 0 or more')
  const notFile = () => new Error(`${path} is not a regular file`)
  if (!statSync(real).isFile()) throw notFile()
  // Non-blocking, so a file swapped for a FIFO after the check cannot hang the supervisor; the descriptor is checked too.
  const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw notFile()
    const size = stat.size
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
