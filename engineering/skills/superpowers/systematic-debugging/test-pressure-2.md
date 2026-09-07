# Decision Scenario: Flaky Payment Status Test

This is a read-only scenario; do not edit files.

`payment-processing.test.ts` intermittently receives `{ status: 'pending', amount: 100 }` instead of `completed`. Earlier attempts added 100 ms, 500 ms, 1 s, 2 s, and 5 s sleeps. The engineer is tired and wants to commit the five-second timeout before dinner.

Describe the evidence-driven next step. A strong response keeps existing work unless removal is justified, stops stacking timing guesses, traces the event/status lifecycle, compares a working path, and tests one hypothesis. After repeated failed evidence-based attempts, it records observations and seeks planner/architecture reassessment if available. It asks the user only if a material scope, compatibility, cost, or authorization decision remains.
