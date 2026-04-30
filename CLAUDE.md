# FBI workspace — agent instructions

## Git discipline

**Always `cd` into `/workspace` before running any `git` command.**
Never use `git -C /workspace ...` from a different directory — the `post-commit`
hook requires the working directory to be inside the repo so it can fire correctly.

```sh
# correct
cd /workspace && git add ... && git commit -m "..."

# wrong — hook does not fire reliably
git -C /workspace commit -m "..."
```

The `post-commit` hook does two things automatically:
1. Pushes the commit to the **safeguard** mirror (`/safeguard`) under
   `refs/heads/claude/run-$RUN_ID` so the FBI server can track WIP state.
2. Pushes to **origin** and writes `ok` or `diverged` to `/fbi-state/mirror-status`.

Both pushes run in the background — you don't need to push manually.
If you accidentally committed from outside `/workspace`, run these to catch up:

```sh
cd /workspace
MIRROR="claude/run-${RUN_ID}"
git push safeguard "HEAD:refs/heads/$MIRROR"
git push --force-with-lease origin "HEAD:refs/heads/$(git symbolic-ref --short HEAD)"
```
