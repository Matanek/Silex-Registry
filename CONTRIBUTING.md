# Contributing a package release

Prefer the Silex commands to release the package and prepare its registry
proposal:

```sh
silex release path/to/Package
silex publish path/to/Package
```

The first command requires the exact package tag on GitHub and an authenticated
GitHub CLI. The second writes one manifest per released package version:

```text
registry/v1/packages/Name/MAJOR.MINOR.PATCH.json
```

The directory name, file name, `name`, and `version` fields must agree. A
manifest has this shape:

```json
{
  "schema": 1,
  "name": "STD",
  "version": "0.16.2",
  "requires": {
    "silex": ">=0.38.0"
  },
  "archive": {
    "url": "https://github.com/Matanek/Silex-Lib-STD/releases/download/v0.16.2/STD-0.16.2.tar.gz",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

Requirements:

- `schema` is `1`;
- `version` and the file name use semantic versioning;
- `requires.silex` is a non-empty compatibility range;
- the archive URL uses HTTPS and identifies an immutable published archive;
- `sha256` contains exactly 64 lowercase hexadecimal characters;
- an existing release manifest is never edited or replaced.

Generated package indexes must not be committed. Build and validate the full
registry locally with:

```sh
node scripts/build-registry.mjs dist/v1
```

The pull request should link to the package release and explain how the
checksum was obtained.
