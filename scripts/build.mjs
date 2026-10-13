// Build dist/ for the npm package (`npm run build`, also run by `npm pack` and `npm publish`): compile src/ and copy the
// UI page, which tsc does not emit.
import { spawnSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
rmSync('dist', { recursive: true, force: true })
// npm puts node_modules/.bin on the PATH of its scripts.
const tsc = spawnSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)
cpSync('src/ui.html', 'dist/ui.html')
