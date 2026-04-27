# Release

## CI

GitHub Actions (`.github/workflows/ci.yml`) installs with **pnpm** (`pnpm install --frozen-lockfile`), then runs `typecheck`, `build`, and `test` on pushes and pull requests to `main`.

## Publishing to npm (OIDC)

Publishing uses `.github/workflows/release.yml` with [npm trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers): no long-lived `NPM_TOKEN` is required for the publish step.

1. In `package.json`, set [`repository`](https://docs.npmjs.com/cli/configuring-npm/package-json#repository) to your **public** GitHub repo URL. It must match the repository you publish from (npm enforces this for GitHub OIDC).
2. On [npmjs.com](https://www.npmjs.com/) → your package → **Settings** → **Trusted publishing** → **GitHub Actions**: enter your GitHub org or user, repository name, and workflow filename **`release.yml`** (filename only, with extension).
3. Push a semver tag `v1.2.3` that matches the `version` field in `package.json`. Tag pushes run verify and then `npm publish` on GitHub-hosted runners.

The release workflow uses Node **22.14** and upgrades npm to **11.5.1+** so OIDC publishing meets npm’s requirements. You can run the workflow manually from the Actions tab; enable the **publish** input only when you intend to publish to npm.

If you ever add **private** npm dependencies, use a read-only token (for example `NPM_READ_TOKEN`) only on `pnpm install` / `pnpm install --frozen-lockfile` in CI—publishing still uses OIDC, as in [npm’s example](https://docs.npmjs.com/trusted-publishers#handling-private-dependencies).
