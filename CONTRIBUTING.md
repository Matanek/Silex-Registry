# Contributing a package release

Prefer the Silex commands to release the package and prepare its registry
proposal:

```sh
silex release path/to/Package
silex publish path/to/Package
```

The first command requires the exact package tag on the package remote and uses
Git itself to publish an immutable archive and checksum. No GitHub CLI is
required. The second maintains a registry checkout under `~/.silex/registry`,
fast-forwards its clean `main` branch, verifies the manifest, creates or reuses
the developer's fork, and opens the pull request through GitHub's API.

The first `silex publish` prints a GitHub Device Flow URL and code. The
developer authorizes the Silex CLI in the browser; no GitHub CLI or client
secret is needed. Silex stores the renewable user authorization under
`~/.silex/auth/github.json` with user-only permissions. Repeating the command
resumes an interrupted publication or returns the existing pull request.

Each release proposal adds one manifest at:

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
  "repository": "Matanek/Silex-Lib-STD",
  "extensions": [],
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
- `repository` identifies the GitHub repository permanently assigned to the
  package name;
- `extensions` is sorted, contains only direct child grants, and is empty when
  the namespace is closed;
- the archive URL identifies an immutable release of that exact repository;
- `sha256` contains exactly 64 lowercase hexadecimal characters;
- an existing release manifest is never edited or replaced.

Generated package indexes must not be committed. Build and validate the full
registry locally with:

```sh
node scripts/build-registry.mjs dist/v1
```

The pull request should link to the package release and explain how the
checksum was obtained.
