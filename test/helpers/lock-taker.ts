// Waits for <dir>/go, then tries to take the run lock in <dir>. The holder keeps it until all <count>
// takers have made their attempt (or 10 s pass), so a slow process cannot win after the release.
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { openLog } from '../../src/run/index.ts'

const [dir, id, count] = process.argv.slice(2)
writeFileSync(`${dir}/ready-${id}`, '')
while (!existsSync(`${dir}/go`)) await sleep(1)
let log
try {
  log = openLog(dir)
  writeFileSync(`${dir}/held-${id}`, '')
} catch {}
writeFileSync(`${dir}/tried-${id}`, '')
if (log) {
  const until = Date.now() + 10_000
  while (readdirSync(dir).filter((f) => f.startsWith('tried-')).length < Number(count) && Date.now() < until) await sleep(5)
  log.close()
}
