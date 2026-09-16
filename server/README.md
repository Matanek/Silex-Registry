# Experimental durable registry

This is a local `/v2` storage prototype, not a deployed replacement for `/v1`.
The existing static build and deployment are unchanged. HTTP login creates an
identity only after the server's GitHub exchange; it never accepts a claimed
identity from the client. Live GitHub qualification, the Silex
client, complete manifest semantics, namespace delegation, hostile-code execution
isolation, operational hardening and migration are separate, unfinished work.
Do not deploy this subtree as a public service yet.

## Requirements and test

PHP 8.2+ with PDO SQLite, zlib, intl and mbstring; a local filesystem supporting
`flock`, atomic rename and directory `fsync`. Tests also need PHP POSIX (forced
process termination) and Node.js 22+. The initial qualification is PHP 8.4 on
macOS, not PHP-FPM 8.2 on the production host. NFS/shared multi-host storage is
not qualified.

From the Spec's `Worktree/` group, run:

```sh
node Silex-Registry/server/tests/run.mjs /absolute/path/to/php
```

Le parcours candidat de publication sans Git s'exécute depuis le même groupe,
après construction du CLI de la Spec :

```sh
node Silex-Registry/server/tests/run-publish.mjs /absolute/path/to/php /absolute/path/to/silex /absolute/path/to/package
```

Il crée un accès de registre uniquement sous `TestState`, publie via le vrai
CLI, relit la version et la source publiques, puis relance la commande pour
vérifier sa reprise idempotente. Il n'utilise ni OAuth GitHub réel ni magasin
utilisateur.

The launcher prints the repository, baseline SHA, PHP executable/version, limits,
data root and HTTP addresses. It creates a new empty store under
`Worktree/TestState/server/` and starts two independent PHP processes on loopback.
It stops both processes on completion/failure and retains each store as evidence.
The test suite never uses production credentials, package links, a Silex cache or
the deployed registry. It also rebuilds `/v1` into its own separate output folder.
The independent HTTP client also submits a highly compressible source that exceeds
the test expansion limit and a PHP canary inside a published archive. It checks
that the former never becomes visible and the latter is returned only as binary
data, without creating the canary file. This does not prove process-account or
web-server isolation on the VPS.

`tests/fixture.php` is CLI-only, outside `public/`, and injects identities and
short-lived tokens directly into the test database. Crash hooks are injected
closures available only to this fixture, never request fields or public routes.

## Storage and ownership

`bin/storage.php init /absolute/empty/data-root` initializes a store and reserves
every historical `/v1` package name. The directory must exist, be empty and be
outside this code checkout. It contains `registry.sqlite`, `mutation.lock`,
`objects/<sha256>` and `uploads/<publication-id>-<sha256>`; it must remain outside
every web document root and code-release directory. The only future document
root is `server/public/`, never `server/` or a parent of the data directory.
Initialization is offline, never implicit in a request.

Rights refer to the verified, stable numeric GitHub ID, stored as text, not the
mutable login label. Registry credentials are random 256-bit bearer tokens; only
their SHA-256, identity, expiry and revocation state are stored. They are distinct
from GitHub tokens. The login service below issues 24-hour registry access. A
validly authenticated identity may publish a free name without invitation.
Historical names remain reserved; dotted names require ownership of every parent.
Cross-owner extension grants currently fail closed.

One bounded mutation at a time takes `flock` and a SQLite `BEGIN IMMEDIATE`
transaction. Chunks are bounded before the lock, bytes are synced before the
acknowledged offset commits, completed objects are hashed and atomically renamed,
and both directories are synced before publication metadata commits. Finalization
checks every object and scans the source archive without extracting or executing
it. Readers only discover committed immutable versions. A crash may leave an
unacknowledged prefix or unreferenced object, never an intentionally visible
partial version. These guarantees assume the filesystem honors sync operations;
process-kill tests do not simulate every hardware/power failure.

SQLite persistence uses `synchronous=FULL`. See the primary documentation for
[transaction behavior](https://www.sqlite.org/lang_transaction.html) and
[PHP fsync](https://www.php.net/manual/en/function.fsync.php).

The offline `collect` command takes the same mutation lock, expires abandoned
sessions, deletes inactive temporary uploads, and deletes CAS objects only when
they have neither a published nor an active-upload reference and exceed the
grace period. It never evicts retained published content. Repeating creation
after expiry creates a fresh attempt with reset offsets and reusable complete
objects. Repeating a published descriptor returns its existing result.

## HTTP protocol (prototype)

Requests require HTTPS except the loopback PHP development server used by the
test harness. `SILEX_REGISTRY_DATA` supplies an explicit absolute storage root.
The service does not trust forwarded identity or HTTPS headers. Configure a
future trusted web-server/FPM boundary explicitly; this repository changes none.

Authenticated calls use `Authorization: Bearer <registry-token>`:

- `POST /v2/publications`: admit the descriptor below and return a private session.
- `GET /v2/publications/<id>`: return state, publication digest and each object's
  declared size, durable offset and availability.
- `HEAD /v2/publications/<id>/objects/<sha256>`: `Upload-Offset` and `Upload-Length`.
- `PATCH` on that object URL: send a bounded binary body and `Upload-Offset`.
  On 409, re-read the durable offset before retrying. A complete shared object
  needs no retransmission. Repeated final chunks before publication are harmless.
- `POST /v2/publications/<id>/finalize` with an empty body: verify and commit.
  Retry after a lost response; the same publication has the same result.

Anonymous `GET`/`HEAD` calls:

- `/v2/packages/<name>` lists published versions, newest first.
- `/v2/packages/<name>/versions/<version>` returns its descriptor and digest.
- Append `/source` or `/artifacts/<target>/<name>` for exact binary bytes, a
  digest ETag, `application/octet-stream` and attachment disposition.

There is no arbitrary object download, author-supplied URL fetch, extraction,
compiler invocation, admin route or OAuth simulation endpoint. Publication state is
`receiving` or `published`; an expired attempt returns 410. Errors contain a
stable `error`, generic `message` and `retryable`, never submitted credentials.

The descriptor has exactly `schema: 1`, `manifest` (the exact Package.json UTF-8
string), `source: {size, sha256}`, `files: [{path, size, sha256}]` and
`artifacts: [{target, name, path, size, sha256}]`. All digests are lowercase
SHA-256. Artifact entries must match every target's manifest declaration; runtime
dependencies must have a previously published matching exact/caret version.
Full dependency resolution and extension-policy validation are not claimed here.

The publication digest hashes the descriptor encoded with recursively sorted
object keys (UTF-8 byte ordering), unchanged array order, integer numbers and no
insignificant whitespace. Strings are UTF-8, with JSON escaping for controls,
quotes and backslashes; slashes, Unicode and U+2028/U+2029 remain unescaped. The
manifest remains an exact string, not a reparsed/reformatted object. A digest is
an integrity identifier, not a digital signature or proof of package safety.

Sources are one gzip member containing USTAR regular files only, relative to the
package root, including the exact `Package.json`. Every file appears exactly
once with its declared size/hash. No directory entries, links, special files,
GNU/PAX extensions, trailing gzip members, traversal, control characters or
ambiguous portable paths are accepted. Paths are NFC UTF-8, at most 240 bytes;
case-insensitive collisions, file/directory overlaps, Windows device names and
`.git`/`.silex` components are rejected. Archive payloads are streamed in small
compressed reads and never extracted into the web filesystem.

## Limits and qualification boundary

Defaults: 16 MiB compressed source, 64 MiB expanded file content, 10,000 files,
1 GiB per artifact, 1 MiB chunks, 2 MiB request metadata, 8 active sessions per
identity, 24-hour sessions/orphan grace, 10 GiB logical storage capacity and
1 GiB disk reserve. Archive scanning has a 15-second deadline; mutation lock
acquisition waits at most 5 seconds. An offline `limits.json` object in the data
root may override named limits with positive integers. HTTP and GC both read it.

Capacity accounting is conservative: published and active-session logical bytes
count even when CAS deduplicates them. Admission reserves capacity; every append
also checks available disk. This is not yet per-user billing, fair scheduling,
request-rate limiting or host-level isolation. The web server still needs bounded
connections, request timeouts/body limits and a least-privileged service identity.
Credential changes must join the same mutation-lock discipline. Live GitHub OAuth,
production extensions/configuration, permissions, backups/restores and actual
power-loss behavior require their own qualification before activation.

## Qualify GitHub identification separately

`src/GitHub.php` implements a bounded server-side device-flow exchange.
`src/Login.php` binds it to a private, single-consumption attempt. Neither accepts
a client-supplied GitHub token or identity. Live qualification is still required
before activation outside this experimental lane.

Its offline test uses an injected transport, never a permissive HTTP mode:

```sh
php Silex-Registry/server/tests/github.php
```

For explicit interactive qualification, create a separate OAuth App, enable
Device Flow and retain expiring user tokens. Do not reuse the legacy registration
application, which requests `public_repo`. No client secret is needed by the
device flow. With the dedicated public client ID, run:

```sh
php Silex-Registry/server/tests/github-live.php PUBLIC_CLIENT_ID
```

The person authorizes the displayed code on GitHub themselves. This probe calls
only the fixed GitHub device, token and authenticated-user endpoints. It requests
an empty scope, rejects any nonempty granted scope and returns only the stable ID
and login. HTTPS certificate checks, no redirects, 10-second request deadlines
and 32 KiB response limits apply. All GitHub tokens, refresh tokens and unused
profile fields remain transient in the process; nothing is written to disk.
Discarding a token does not revoke it at GitHub. The test creates no registry
credential and does not prove `silex login` or the client/attempt binding.

The API exchange follows [GitHub's device-flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
An [empty scope](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
does not request additional repository or private-profile permissions, but public
data remain accessible. [The authenticated-user endpoint](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
still identifies the token owner without requesting private profile access.
The complete response contains more public fields than the two retained here.

## Login attempts and registry access

Initialize login state offline with `storage.php login-init /absolute/data-root`.
This adds separate login tables and a private `login.key` without migrating or
changing existing publication data. Set `SILEX_GITHUB_CLIENT_ID` for the service
to the dedicated app's public ID. No configured app means login fails closed;
anonymous reads and existing registry access remain independent of GitHub.

The client generates a fresh cryptographically random 256-bit ticket in memory.
It uses `Authorization: Login <64-lowercase-hex-ticket>` with these empty-body
requests, never a ticket in an URL:

- `POST /v2/logins`: begin or recover that ticket's attempt. Return its `id`,
  public `user_code`, fixed GitHub verification URL, expiry and polling interval.
- `POST /v2/logins/<id>`: poll only that attempt with its matching ticket. Honor
  `retry_after` before repeating the request.

The server stores only the ticket digest and an authenticated-encrypted device
code, bound inside its ciphertext to the attempt ID. Sodium secretbox uses a
fresh random nonce and the private offline key. GitHub access/refresh tokens
remain transient. The key must stay outside database-only exports; encryption
does not protect a host compromised together with that key.

States are `starting`, `pending`, `polling`, `denied`, `expired`, `failed` and
`consumed`. Exactly one successful poll returns `state: authorized`, the attempt
`id`, a registry `token`, `expires_at`, `github_id` and `login`. Creating/updating
the identity, hashing the new credential and consuming the attempt commit together
under the same lock as publication and revocation. Later polls return `consumed`,
never another bearer. A lost success response or failed local credential write
requires a new login; any orphan access expires within 24 hours.

Outbound calls happen outside the global storage lock. A 30-second exclusive
attempt lease prevents duplicate concurrent exchange; a crashed/late exchange
fails closed instead of being reassigned. Attempts expire within 15 minutes.
The prototype limits creation to 10 attempts per server-minute and 32 concurrent
attempts. These global bounds prevent unbounded work, not denial of service or
fairness between clients; production still needs front-end controls.

With `Authorization: Bearer <registry-token>`, `GET /v2/session` checks the current
identity and expiry; `DELETE /v2/session` idempotently revokes only that credential.
No cookie or website session is created. GitHub application revocation prevents
future authorization but does not instantly revoke already-issued registry access.
Local logout must revoke at the registry before removing the local credential;
if the network fails, retain it so revocation can be retried.

Run `storage.php login-collect /absolute/data-root` regularly to erase expired
credentials and attempts older than 24 hours and clear expired encrypted codes.
Identity/ownership records remain; collection never removes published versions.
Old database backups may retain encrypted attempts; their key and retention need
separate operational handling before deployment.

Run the isolated state-machine and HTTP tests from the Spec Worktree group:

```sh
node Silex-Registry/server/tests/run-login.mjs /absolute/path/to/php
```

The alternate mock bootstrap lives only in `tests/login-router.php`, outside
`public/`; the production entry point always constructs the real GitHub adapter.
These tests cover attempt crossing, replay, expiry, slowdown, revocation, crash
boundaries and automatic minimal identity creation, not real GitHub consent.
