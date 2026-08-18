# Silex package registry

This repository assigns public Silex package names to their canonical Git
repositories. It does not publish package versions or copy their manifests.
Tagged commits in each registered repository are the source of truth for
versions, compatibility, dependencies, extension grants, and contents.

The generated index is published at:

`https://registry.silex-lang.org/v1/index.json`

## Layout

```text
registry/v1/packages/
  GFX.json
  STD.json
```

Each immutable registration has this shape:

```json
{
  "schema": 1,
  "name": "GFX",
  "repository": "https://github.com/Matanek/Silex-Lib-GFX.git"
}
```

Run `silex register path/to/Package` once to register a new package name. Once
registered, the package owner publishes versions directly with Git tags. Each
`vMAJOR.MINOR.PATCH` tag must contain a `Package.json` declaring that exact
version. `silex check path/to/Package` is an optional, read-only validation.

Build and validate the deployable schema-2 index with:

```sh
node scripts/build-registry.mjs dist/v1
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the registration contract.

The registry tooling uses the Apache-2.0 with LLVM exception license.
