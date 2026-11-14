// Where work happens and results gather: git worktrees, branches and merges in git mode, and node folders collected
// into the output folder in folder mode.
export { collect, linkedFolder, listFiles, readText } from './files.ts'
export type { Root } from './files.ts'
export {
  abortMerge, changedFiles, commitAll, createIntegration, createNodeWorktree, currentBranch, dirtyChanges, ensureRepo, hasChanges, head, inWorkTree,
  merge, mergedOnto, mergeInProgress, repoRoot, repoState, resetTo, uncommitted, withConflictMarkers,
} from './git.ts'
