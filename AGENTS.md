# Agent instructions

- Work on a branch and open a PR. `main` is protected: PRs only, squash merges, CI must pass. Never merge; a human does.
- Run `pnpm check` before pushing. Never bypass hooks (`--no-verify`). If gitleaks blocks a commit, remove the secret.
- This repo is public. Never commit tokens, real server names, IPs or ntfy topics. Tests use made-up names and 192.0.2.x addresses.
- Decision rules live in `src/evaluate.ts` as pure functions; every rule needs a test in `test/`.
- The guard must never delete anything, and every loop and request must be bounded (pages, timeouts).
- No runtime dependencies.
