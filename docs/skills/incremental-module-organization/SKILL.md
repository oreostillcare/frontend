---
name: incremental-module-organization
description: Organize an existing codebase by feature ownership and shared imports through small, test-gated refactors without changing behavior.
metadata:
  short-description: Safely organize files by feature
---

# Incremental Module Organization

Use this skill when an existing application needs clearer feature-based folders, reusable shared utilities, or safer import boundaries without adding or removing functionality.

## Goals

- Preserve every existing feature and runtime behavior.
- Make each module easy to find by naming folders and files after their responsibility.
- Move only code that belongs in the new location.
- Keep shared code reusable without duplicating implementations.
- Refactor in small, reversible steps.

## Boundaries

- Do not add new product features.
- Do not change business rules, data shapes, permissions, UI behavior, or API contracts.
- Do not move secrets, `.env` files, generated files, or unrelated work.
- Keep framework primitives and protected vendor/UI wrappers in their existing locations unless the project explicitly permits changing them.
- Keep route-specific code close to its owning route; move it to shared folders only when multiple modules genuinely use it.

## Placement rules

Name folders after the feature or module they own, for example:

```text
src/modules/authentication-session/
src/modules/staff-management/
src/modules/live-monitoring/
src/shared/firebase/
src/shared/hooks/
src/shared/helpers/
src/shared/types/
```

Name files after what they do, not after a vague layer:

```text
login-form.tsx
staff-access.ts
staff-activity-client.ts
format-staff-name.ts
use-mobile.ts
```

Use a shared folder only when the implementation is imported by multiple independent modules. Keep one-off logic inside its feature module.

## Workflow

### 1. Inspect before editing

Read the repository instructions and inspect the closest existing files. Build a change map containing:

- the implementation being moved;
- every production caller;
- tests, mocks, fixtures, exports, and configuration that reference it;
- protected files that must not be edited;
- unrelated dirty or untracked files that must remain untouched.

Search callers with `rg` before changing an import. If architecture is unclear and a graph already exists, use it as a read-only aid; otherwise use targeted text search.

### 2. Choose one small move

Start with one coherent category, such as:

- one reusable hook group;
- one shared Firebase helper group;
- one shared type or formatting helper.

Do not combine unrelated moves in one step.

### 3. Preserve compatibility

Prefer moving the implementation to the new module folder, then updating production callers and tests to the new path. When old imports may remain or protected files still depend on the old path, replace the old implementation with a thin re-export:

```ts
export { usefulFunction } from "@/shared/helpers/useful-function";
export type { UsefulType } from "@/shared/helpers/useful-function";
```

There must be one implementation, not two copies.

### 4. Apply the smallest edit

Use the existing project conventions, aliases, formatting, error handling, and validation. Do not redesign the code while relocating it. Update tests and mocks whenever module paths change.

### 5. Test immediately

After each move, run the repository's type check and unit tests. For this project, the normal gates are:

```bash
npx tsc --noEmit --pretty false
npm run test:unit
```

Also run a whitespace/diff check when available. Confirm the changed module still has the same callers and exports.

### 6. Stop on failure

If a test or type check fails, stop the organization sequence. Report the exact failure and ask for permission before changing behavior or fixing unrelated code. Do not proceed to another module until the failure is resolved and the same gates pass.

### 7. Repeat and review

Only after the current step passes, choose the next genuinely shared category. At the end, verify:

- no duplicate implementations remain;
- old compatibility paths are intentional;
- all imports resolve;
- no feature or API behavior changed;
- unrelated work remains untouched;
- the working tree clearly shows the intended organization.

## Completion report

Summarize:

- folders and files moved;
- compatibility exports added;
- callers and tests updated;
- validation results for each step;
- anything intentionally skipped and any remaining risk.
