# Silex package registry

This repository is the public source of truth for the Silex package registry.
Package releases are proposed through pull requests and published as static,
versioned JSON files at:

`https://silex-lang.org/registry/v1/index.json`

Package archives remain owned by their respective repositories. The registry
contains only their immutable release URLs, compatibility ranges, and SHA-256
checksums.

## Layout

```text
registry/v1/
  index.json
  packages/
    STD/
      0.16.2.json
```

Each committed package file describes exactly one immutable release. The
per-package `index.json` files are generated during validation and deployment;
they must not be committed.

## Publish a release

1. Publish the package archive from a tagged package release.
2. Calculate and publish its SHA-256 checksum.
3. Add `registry/v1/packages/Name/MAJOR.MINOR.PATCH.json` in a pull request.
4. Let the registry check validate the manifest and generated indexes.
5. Merge only after the archive URL and checksum have been reviewed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete manifest contract and
local validation command.

The registry tooling and documentation use the same Apache-2.0 with LLVM
exception license as Silex. Package archives retain the license declared by
their own repositories.

## Deployment

The registry is built as static files under `dist/registry/`. Merges to `main`
can deploy that directory atomically to the Silex VPS. Deployment remains
disabled until the repository variable `VPS_DEPLOY_ENABLED` is set to `true`.

Server preparation, required GitHub secrets, variables, and the web-server
route are documented in [deploy/README.md](deploy/README.md).
