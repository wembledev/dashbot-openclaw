# Run All Tests

user-invocable: true
allowed-tools: Bash

## Description

Runs the test suite, type-check, and linter in parallel, then summarizes the combined results.

## Steps

1. **Run all checks in parallel** using the Bash tool:

   - Tests: `npm test`
   - Type-check: `npm run check`
   - Lint: `npm run lint`

   Launch all three commands simultaneously using parallel Bash tool calls.

2. **Summarize results** after all complete:

   - Report pass/fail counts for the test suite
   - Report any type errors or lint warnings
   - List any failures with file and test name
   - Give an overall pass/fail status

## Output Format

```
## Test Results

### Vitest
X tests passed, Y failed

### TypeScript
Pass / X errors

### ESLint
Pass / X warnings, Y errors

### Overall: PASS / FAIL
```

If there are failures, include the failure details (test name, file, error message) beneath each section.
