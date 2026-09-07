# Persuasion Principles for Skill Design

## Purpose and limits

Clear language can help an agent notice important safeguards, but a skill should support informed judgment rather than compel obedience. System and developer instructions, then explicit user instructions, take precedence over a skill. Do not use pressure tactics to defeat an authorized request, hide tradeoffs, or turn routine work into approval gates.

## Practical guidance

| Goal | Prefer | Avoid |
| --- | --- | --- |
| Make a safety boundary visible | Concrete condition and consequence | Absolute rhetoric disconnected from risk |
| Encourage a useful check | Explain what it establishes | Requiring broad retesting without cause |
| Support autonomy | Reversible defaults and focused questions for material decisions | Forced pauses over routine uncertainty |
| Test a skill | Outcome-based scenarios with limitations recorded | Measuring quotation or compliance alone |

Use direct language for real boundaries: preserve user work, do not run destructive operations without authorization, and disclose unverified checks. Use conditional language where context matters: the test command, review depth, and workflow sequence should fit the changed behavior.

## Historical research context

Cialdini (2021) describes influence principles such as authority, commitment, scarcity, social proof, unity, reciprocity, and liking. Meincke et al. (2025) reported that persuasive prompts changed model compliance in a large experimental dataset. These are historical observations, not instructions to use coercion in skills.

A useful ethical question is: would this wording still serve the user’s stated outcome if they saw it? If not, clarify the decision, disclose the constraint, or remove the pressure.

## Example

```markdown
# Less useful
Never continue until a full suite is clean.

# Useful
Run the focused regression check. If a relevant required suite is unavailable,
report it as unverified; preserve documented unrelated baseline failures.
```

The second version makes the evidence and limit visible without pretending that every change needs the same process.
