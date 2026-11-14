// This copy of sous: its version, and the paths of its two programs, the CLI and the MCP server. They have the running
// file's extension: `.ts` in the sources, `.js` in the published package, where dist/ keeps the same layout as src/.
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const program = (name: string) => fileURLToPath(new URL(`./${name}${extname(import.meta.url)}`, import.meta.url))

/** The version in sous's package.json. */
export const SOUS_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** The `sous` program: cli.ts in the sources, cli.js in the published package. */
export const CLI_PROGRAM = program('cli')

/** sous's MCP server for a worker: mcp.ts in the sources, mcp.js in the published package. */
export const MCP_PROGRAM = program('mcp')
