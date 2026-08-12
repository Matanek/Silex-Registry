# Silex package registry

This repository is the public source of truth for the Silex package registry.
Package releases are proposed through pull requests and published as static,
versioned JSON files at:

`https://registry.silex-lang.org/v1/index.json`

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

The registry is built as static files under `dist/` and published through
GitHub Pages on every merge to `main`. The repository Pages source must be set
to GitHub Actions and its custom domain to `registry.silex-lang.org`.

DNS configuration and the optional future VPS deployment are documented in
[deploy/README.md](deploy/README.md).
