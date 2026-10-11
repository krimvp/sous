// Waits for <dir>/go, then tries to take the run lock in <dir> and holds it briefly.
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { openLog } from '../../src/log.ts'

const [dir, id] = process.argv.slice(2)
writeFileSync(`${dir}/ready-${id}`, '')
while (!existsSync(`${dir}/go`)) await sleep(1)
try {
  const log = openLog(dir)
  writeFileSync(`${dir}/held-${id}`, '')
  await sleep(300)
  log.close()
} catch {}
