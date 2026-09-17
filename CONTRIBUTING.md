# Historical v1 registration

This page applies only to the former Git-tag registry and its existing
clients. The Cloudflare candidate accepts `silex login` and `silex publish`
directly; see the [current registry overview](README.md) and
[service operations](server/cloudflare/OPERATIONS.md). The public domain has
not yet switched to that candidate.

A package needs one registry pull request during its lifetime. Later versions
are discovered directly from the repository's Git tags and require no registry
change.

Prepare and submit the registration with:

```sh
silex register path/to/Package
```

The command verifies that the package repository is clean, that `Package.json`
declares a version and Silex compatibility range, and that `origin` identifies
the canonical GitHub repository. Registration is independent from version
publication. It then adds:

```text
registry/v1/packages/Name.json
```

with exactly these fields:

```json
{
  "schema": 1,
  "name": "Name",
  "repository": "https://github.com/Owner/Repository.git"
}
```

Requirements:

- the file name and `name` must agree;
- the name must be a valid Silex package name;
- the repository must use its canonical HTTPS GitHub clone URL ending in
  `.git`;
- one package name remains attached to one repository;
- version, compatibility, dependencies, and `extensions` must not be copied
  into the registry;
- an existing registration must not be edited or replaced.

Validate the registry locally with:

```sh
node scripts/build-registry.mjs dist/v1
```

Repository transfers and package revocations require an explicit governance
decision and are not ordinary publication updates.
