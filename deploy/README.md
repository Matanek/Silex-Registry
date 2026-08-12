# Registry hosting

## GitHub Pages production

The production registry is published from `.github/workflows/pages.yml`. In the
GitHub repository settings, select GitHub Actions as the Pages source and set
the custom domain to `registry.silex-lang.org`.

At OVH, create this DNS record:

```text
Type: CNAME
Subdomain: registry
Target: matanek.github.io.
TTL: 300
```

The target deliberately excludes the repository name. Once DNS has propagated
and GitHub has issued the certificate, enable HTTPS in the repository Pages
settings. The public registry index is then available at
`https://registry.silex-lang.org/v1/index.json`.

## Optional future VPS deployment

The deployment publishes immutable releases below
`/srv/silex/registry/releases/<git-sha>` and atomically changes the
`/srv/silex/registry/current` symlink. The web server always reads `current`, so
a visitor cannot observe a partially uploaded registry.

## Prepare the VPS

Create a dedicated deployment account and a directory it can write. The exact
account-management commands depend on the VPS distribution; the resulting
layout must be:

```text
/srv/silex/registry/
  current -> /srv/silex/registry/releases/<git-sha>
  releases/
```

Install the public half of a dedicated Ed25519 deployment key in that account's
`authorized_keys`. The account needs write access only to the registry root; it
does not need root or interactive application privileges.

## Configure the GitHub production environment

Add these environment secrets:

- `VPS_HOST`: VPS hostname or IP address;
- `VPS_USER`: dedicated deployment account;
- `VPS_SSH_KEY`: private Ed25519 deployment key;
- `VPS_KNOWN_HOSTS`: pinned `known_hosts` line for the VPS.

Optional repository or environment variables:

- `VPS_SSH_PORT`, default `22`;
- `VPS_REGISTRY_ROOT`, default `/srv/silex/registry`.

When the server route has been tested, set the repository variable
`VPS_DEPLOY_ENABLED` to `true`. Until then, merges still validate the registry
but skip production deployment.

## Route with Caddy

The deployed release contains `v1/...`. The registry has its own canonical
host and remains independent from the website deployment:

```caddyfile
registry.silex-lang.org {
    root * /srv/silex/registry/current
    header Cache-Control "public, max-age=300"
    file_server
}
```

The five-minute cache is conservative for generated indexes. Once manifest
URLs are published they are immutable and may receive a longer cache policy in
a dedicated matcher.

## Roll back

Point `current` at an earlier directory under `releases/` using a temporary
symlink and an atomic rename. Releases are intentionally not deleted by the
workflow, so rollback remains possible. Retention can be added later as a
separate, explicit maintenance policy.
