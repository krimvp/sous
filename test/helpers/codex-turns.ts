// Starts Codex turns in <cwd> through the adapter, in a process of their own (the adapter keeps its MCP listing once per
// process). With `list` first, it lists the servers as `sous run` does at run start. Prints nothing; what the adapter says
// goes to stderr.
import { join } from 'node:path'
import { codex, listCodexServers } from '../../src/adapters/codex.ts'

const [cwd, turns, list] = process.argv.slice(2)
if (list === 'list') await listCodexServers()
for (let turn = 1; turn <= Number(turns); turn++) {
  await codex.start({ nodeId: 'a', turn, cwd: cwd!, prompt: 'p', outFile: join(cwd!, `out-${turn}.jsonl`), errFile: join(cwd!, `err-${turn}.txt`) }).exit
}
