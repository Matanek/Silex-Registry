# Silex package registry

The public registry at https://registry.silex-lang.org is a Cloudflare Worker backed by D1 metadata and
R2 objects. `silex publish` uploads a validated local source snapshot and its
declared artifacts; published versions are immutable. GitHub verifies an
author's identity. A manifest's optional `repository` is a development link
for contributors and does not supply the published bytes or grant ownership.
Package listings and installs are anonymous. GET /v2/catalog returns one entry
per published package, with its name, description from its latest numeric
version, and optional contributor repository link. It does not read GitHub
repositories. The response has schema 1 and a packages array.

The Worker, migrations, tests, administration scripts, staging configuration,
and deployment procedure are under [server/cloudflare](server/cloudflare/README.md).
The deployment and recovery checks are in
[the operations guide](server/cloudflare/OPERATIONS.md).

## Historical v1 registry

The former registry mapped names to canonical GitHub repositories; tagged repository
commits supplied its versions. [CONTRIBUTING.md](CONTRIBUTING.md),
`registry/v1`, `scripts/build-registry.mjs`, and [deploy](deploy/README.md)
describe that legacy protocol and its VPS deployment. They are preserved for
migration and existing clients. Running an index build or deploying code must
never delete the D1/R2 objects of the candidate service.

The earlier PHP/SQLite durable-store prototype remains under [server](server/README.md)
as historical migration evidence; it is not the Cloudflare production route.

The registry tooling uses the Apache-2.0 with LLVM exception license.
