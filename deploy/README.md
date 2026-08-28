# Registry hosting

## Current GitHub Pages service

GitHub Pages remains active until the VPS cutover is complete. Its workflow is
`.github/workflows/pages.yml` and its current custom domain is
`registry.silex-lang.org`. Do not disable Pages before the production DNS and
HTTPS checks below are green.

## VPS releases

The VPS workflow publishes immutable releases and atomically changes the
`current` symlink, so a visitor cannot observe a partially uploaded registry:

```text
/srv/silex/registry/
  current -> /srv/silex/registry/releases/<git-sha>
  releases/
    <git-sha>/
      index.html
      styles.css
      v1/index.json
```

The dedicated account `silex-registry-deploy` owns only this registry root. It
has no `sudo` access and its SSH key disables forwarding and interactive PTY
allocation.

## GitHub production environment

The `production` environment provides these secrets:

- `VPS_HOST`;
- `VPS_USER`;
- `VPS_SSH_KEY`;
- `VPS_KNOWN_HOSTS`.

It also provides `VPS_SSH_PORT`, `VPS_REGISTRY_ROOT`, and
`REGISTRY_SMOKE_URL`. The repository variable `VPS_DEPLOY_ENABLED=true`
enables `.github/workflows/deploy.yml`. Each deployment validates its inputs,
uploads one complete immutable release, switches `current`, and checks the
public staging endpoint.

## Apache

The expected staging and production configurations live under
`deploy/apache/`:

- `silex-registry.nekmata.com.conf` and its SSL companion serve the staging
  endpoint from `/srv/silex/registry/current`;
- `registry.silex-lang.org.conf` is the HTTP bootstrap VirtualHost for the
  production domain.

The production VirtualHost deliberately remains on HTTP while DNS still
points to GitHub Pages. It can be tested directly on the VPS with a forced
`Host` header.

## DNS and HTTPS cutover

At OVH, delete the current `registry` CNAME to `matanek.github.io.` and create:

```text
Type: A
Subdomain: registry
Target: 92.222.25.45
TTL: 300
```

Once public DNS resolves to the VPS, issue the certificate and enable the
redirect:

```sh
sudo certbot --apache -d registry.silex-lang.org --redirect
```

Then verify both `/` and `/v1/index.json` over HTTPS. Only after those checks
pass should GitHub Pages be disabled for this repository.

## Rollback

Point `current` at an earlier complete directory under `releases/` using a
temporary symlink and an atomic rename. Releases are intentionally retained by
the workflow; adding a retention policy is a separate maintenance operation.
