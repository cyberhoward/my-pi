---
name: brainstorming
description: Use selectively for unfamiliar or consequential feature and behavior design.
---

# Brainstorming Ideas Into Designs

Use design exploration when it changes a consequential decision, not as a prerequisite for every edit. Respect an explicit request for interactive design or planning-only work; otherwise, turn an authorized request into a proportionate implementation path.

## Process

1. Inspect relevant project context, conventions, constraints, and existing behavior.
2. Resolve routine details from evidence and choose reversible defaults.
3. Compare alternatives when they differ materially in architecture, compatibility, cost, risk, or scope. State the recommendation and trade-offs concisely.
4. Ask one focused question only for a missing decision that materially changes the outcome and cannot be resolved from the repository or request. Continue independent preparation while waiting.
5. Record a design document only when it is useful for a substantial decision or handoff. Use `docs/plans/YYYY-MM-DD-<topic>-design.md` when the project uses that convention.
6. Proceed to a concise implementation plan or implementation as the task size warrants.

Do not require design approval, section-by-section confirmation, a fixed number of alternatives, a commit, or a worktree before implementation. Do not implement when the user asked for a design or plan only.

```dot
digraph brainstorming {
    "Inspect context" [shape=box];
    "Material decision unresolved?" [shape=diamond];
    "Compare evidence and ask focused question if needed" [shape=box];
    "Record concise design if useful" [shape=box];
    "Plan or implement proportionately" [shape=doublecircle];

    "Inspect context" -> "Material decision unresolved?";
    "Material decision unresolved?" -> "Compare evidence and ask focused question if needed" [label="yes"];
    "Material decision unresolved?" -> "Record concise design if useful" [label="no"];
    "Compare evidence and ask focused question if needed" -> "Record concise design if useful";
    "Record concise design if useful" -> "Plan or implement proportionately";
}
```

## Example

For “add CSV export,” inspect existing export conventions and implement format/UI defaults supported by that precedent. If tenant-wide versus requester-only data access is not specified and changes authorization or privacy, ask that question while preparing the independent formatting and test work. Do not invent an access policy or wait for recurring design approval.
