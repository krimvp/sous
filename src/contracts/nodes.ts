// The nodes of a run's tree: their kinds and specs, the reserved IDs and the roles.

export type NodeKind = 'work' | 'check' | 'lead' | 'review' | 'gate'

export interface NodeSpec {
  id: string
  kind: NodeKind
  /** Parent node ID; absent for top-level nodes of a graph file (children of the implicit root). */
  parent?: string
  /** Sibling node IDs that must complete before this node starts. */
  needs?: string[]
  /** What the agent should do (work, review, lead), or what the person approves (gate). */
  brief?: string
  /** Shell command for `check` nodes, or a node's acceptance check run after a `done` result. */
  command?: string
  /** Acceptance criteria shown to the agent in its brief. */
  acceptance?: string[]
  /** Name of the agent that does this node: a built-in (`claude`, `codex`, `pi`, `droid`, `lead`) or one the graph
   * defines. Default: the first available worker agent; for leads, `lead`. */
  agent?: string
  /** Overrides the agent's model for this node. */
  model?: string
  /** Leads: the agents that fill roles for this lead and its subtree (see Roles). */
  roles?: Roles
  /** A standing node is an independent agent of the run (the integrator): it takes requests through its
   * inbox, goes idle between them, and never completes on its own. Internal; not allowed in graph files. */
  standing?: boolean
}

/** Node ID and agent name reserved for the run's integrator. */
export const INTEGRATOR = 'integrator'

/** Roles: agents that serve every lead of a subtree instead of doing a node. A lead's agent for a role is the nearest
 * `roles` entry from the lead up through its ancestors, else the run's agent named after the role, if it defines one.
 * Each agent in a role runs as a standing node (see `roleNode`). `splitter`: proposes how each lead splits its task
 * before the lead receives its brief. */
export const ROLES = ['splitter'] as const
export type Role = (typeof ROLES)[number]
export type Roles = Partial<Record<Role, string>>

export const SPLITTER: Role = 'splitter'

/** The standing node of `agent` in `role`: the role's name for the agent named after it, else `<role>.<agent>`. IDs
 * equal to a role, or starting with `<role>.`, are reserved. */
export const roleNode = (role: Role, agent: string) => (agent === role ? role : `${role}.${agent}`)

/** How deep leads may nest (a top-level lead is depth 1) unless the run sets `--max-depth`. */
export const DEFAULT_MAX_LEAD_DEPTH = 3

/** The implicit root node's ID. */
export const ROOT = 'root'

/** Message address of the person running sous: the parent of top-level nodes. */
export const PERSON = 'person'
