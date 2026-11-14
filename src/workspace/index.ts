// Where work happens and results gather: git worktrees, branches and merges in git mode, and node folders collected
// into the output folder in folder mode.
export { collect, filesIn, linkedFolder, listFiles, readText } from './files.ts'
export type { Root } from './files.ts'
export {
  abortMerge, branchExists, changedFiles, commitAll, commitsNotIn, createIntegration, createNodeWorktree, currentBranch, deleteBranch, dirtyChanges,
  ensureRepo, hasChanges, head, inWorkTree, merge, mergedOnto, mergeInProgress, pruneWorktrees, removeWorktree, repoRoot, repoState, resetTo, showDiff,
  uncommitted, withConflictMarkers, worktreePaths,
} from './git.ts'
