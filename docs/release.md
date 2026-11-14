# Releasing

The release workflow uses npm Trusted Publishing (OIDC), not a long-lived npm token. The npm publish step runs with provenance and waits for approval through the GitHub `npm` environment.

## One-time setup

1. In npm package settings, add a Trusted Publisher for GitHub Actions:
   - organization/user: `roddcode`
   - repository: `exactly-once`
   - workflow filename: `publish.yml`
   - environment: `npm`
   - allowed action: **`npm publish`** (not only stage publish)
2. In GitHub, create the `npm` environment and require reviewers. Restrict it to the `main` branch.
3. Confirm the repository has no `NPM_TOKEN` secret; the workflow needs only `id-token: write`.

npm requires a recent CLI for trusted publishing. The workflow uses Node 24 and installs `npm@11.12.1` explicitly.

## Release checklist

1. Confirm `main` is clean and `package.json` has the release version.
2. Confirm `CHANGELOG.md` has the dated entry and the changes match the tag.
3. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm db:up
   pnpm audit
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm test:db
   pnpm build
   pnpm smoke:mcp
   pnpm example:mcp-retry
   pnpm validate:package
   npm pack --dry-run
   ```

4. Commit the release preparation and push `main`. Wait for CI to pass.
5. Create an annotated tag on that exact commit and push it:

   ```bash
   git tag -a v0.3.1 -m "exactly-once 0.3.1"
   git push origin v0.3.1
   ```

6. Create the GitHub Release from `v0.3.1` using the `CHANGELOG.md` entry.
7. Run the **Publish** workflow with version `0.3.1` and approve the `npm` environment. This is the only step that publishes.
8. Verify the registry:

   ```bash
   npm view exactly-once@0.3.1 version dist.integrity dist.attestations
   npm audit signatures
   ```

9. Install the published tarball in independent ESM and CommonJS consumers and verify both the core and `exactly-once/mcp`.

## Rules

- Do not publish from a local token or from an uncommitted working tree.
- Do not reuse a version after npm accepts it; publish a new patch instead.
- Do not publish if CI is red or the tag does not point to the release commit.
