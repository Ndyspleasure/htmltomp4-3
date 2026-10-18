---
name: release-check
description: Verify the HTML→MP4/MP3 converter before opening/merging a PR or deploying to Vercel — runs lint, format, typecheck, unit, build and E2E (including output-file validation), checks the diff for secrets/large files, and reviews security-sensitive changes (sandbox, CSP, ZIP import). Use before every PR, merge to main, or production deploy.
---

# Release check

Run from the repository root. Report every command with its real result; never claim a step passed without output.

## 1. Repository state

```bash
git status --short && git log --oneline -5
git diff --stat origin/main...HEAD
```

- No untracked build output (`dist/`, `public/generated/`, `test-results/`) or `.env*` files staged.
- No file > 1 MB added outside `tests/fixtures/` (`git diff --stat` + `find . -size +1M -not -path './node_modules/*'`).
- Scan the diff for secrets: `git diff origin/main...HEAD | grep -nEi '(api[_-]?key|secret|token|password|BEGIN [A-Z ]*PRIVATE KEY)'` — investigate every hit.

## 2. Automated checks (same order as CI)

```bash
npm ci
npm run lint
npm run format:check
npm run build:sandbox
npm run typecheck
npm test
npm run build
npx playwright install chromium   # once per machine
npm run test:e2e
npm audit --omit=dev --audit-level=high
```

If a test fails, fix the root cause and re-run. Never skip, disable or weaken a test to get green.

## 3. Security review (when these paths change)

| Changed path                                                                      | Verify                                                                                                                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/sandbox.html`, `src/sandbox/**`, `src/features/converter/preview/**`      | iframe keeps `sandbox="allow-scripts"` only (never `allow-same-origin`); untrusted HTML is parsed only inside the sandbox; E2E "isolated sandbox" passes. |
| `vercel.json`, `scripts/serve-dist.mjs`                                           | App CSP has no `unsafe-inline`/`unsafe-eval`; `/sandbox.html` keeps `frame-ancestors 'self'`; E2E `pages.spec.ts` passes.                                 |
| `src/features/converter/import/**`, `validation/**`, `config/converter-config.ts` | Traversal, absolute path, entry-count, size and ZIP-bomb tests still pass; limits only changed in `converter-config.ts`.                                  |
| `export/**`, `workers/**`                                                         | Output is validated (`assertOutputMatches`) before download; extensions match real containers; E2E MP4/MP3/WebM downloads pass.                           |
| `capture/**`, `ui/converter-app.ts`                                               | Capture starts only from a click; tracks stopped on stop/cancel/error/reset; denied permission handled.                                                   |

## 4. Vercel deployment check (after deploy, when access is available)

- Open the HTTPS preview URL: `/`, `/preview`, `/sandbox.html`, `/bantuan`, `/privasi`, `/lisensi` load; no CSP errors in the console.
- Import `tests/fixtures/simple.html`, record 3 s in Chrome/Edge with "Tab ini", download MP4 and MP3; confirm both play.
- Response headers on `/` include the CSP from `vercel.json`; `/sandbox.html` has only `frame-ancestors 'self'; ...`.

## 5. Report

Summarise: commands run + results, items not verifiable (and why), remaining risks.
