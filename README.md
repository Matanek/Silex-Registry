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

1. Commit the package, create its exact `vMAJOR.MINOR.PATCH` tag, and push both.
2. Run `silex release path/to/Package` to publish the archive and checksum.
3. Run `silex publish path/to/Package` from a checkout containing
   `Silex-Registry/` to prepare the immutable version manifest.
4. Add that manifest in a pull request and let the registry check validate the
   generated indexes.
5. Merge only after the assigned GitHub repository, namespace extension policy,
   archive URL, and checksum have been reviewed.

The registry locks one package name to one GitHub repository. New release
manifests copy the package's `extensions` policy and the installer verifies it
against the checksummed archive before recording a local registry proof.

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
