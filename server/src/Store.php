<?php
declare(strict_types=1);

namespace Silex\Registry;

require_once __DIR__ . '/Support.php';
require_once __DIR__ . '/Descriptor.php';
require_once __DIR__ . '/SourceArchive.php';

final class Store
{
    public const LIMITS = [
        'source' => 16777216, 'object' => 1073741824, 'expanded' => 67108864,
        'files' => 10000, 'chunk' => 1048576, 'metadata' => 2097152,
        'capacity' => 10737418240, 'reserve' => 1073741824,
        'sessions' => 8, 'ttl' => 86400, 'grace' => 86400, 'seconds' => 15,
    ];
    private \PDO $db;
    public readonly array $limits;

    public function __construct(public readonly string $root, array $limits = [], private readonly ?\Closure $probe = null)
    {
        demand(realpath($root) === $root && is_file($root . '/registry.sqlite') && is_file($root . '/mutation.lock') && !is_link($root . '/mutation.lock'), 'uninitialized_store', 503);
        $codeRoot = dirname(__DIR__, 2);
        demand(!str_starts_with($root . '/', $codeRoot . '/'), 'data_inside_code', 503);
        demand(array_diff_key($limits, self::LIMITS) === [], 'unknown_limit', 503);
        $this->limits = array_replace(self::LIMITS, $limits);
        foreach ($this->limits as $limit) demand(is_int($limit) && $limit > 0, 'invalid_limit', 503);
        $this->db = new \PDO('sqlite:' . $root . '/registry.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $this->db->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
        demand((int)$this->db->query('PRAGMA user_version')->fetchColumn() === 1, 'unsupported_store', 503);
    }

    /** Administrative initialization, never called by HTTP requests. */
    public static function initialize(string $root, string $registrations): void
    {
        demand(realpath($root) === $root && scandir($root) === ['.', '..'], 'store_not_empty', 409);
        demand(!str_starts_with($root . '/', dirname(__DIR__, 2) . '/'), 'data_inside_code');
        chmod($root, 0700);
        mkdir($root . '/objects', 0700); mkdir($root . '/uploads', 0700);
        $lock = fopen($root . '/mutation.lock', 'x'); fclose($lock);
        $db = new \PDO('sqlite:' . $root . '/registry.sqlite');
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->exec(file_get_contents(dirname(__DIR__) . '/schema.sql'));
        $statement = $db->prepare('INSERT INTO names(name, reserved) VALUES (?, 1)');
        $db->beginTransaction();
        foreach (glob($registrations . '/*.json') as $path) {
            $registration = objectJson(file_get_contents($path));
            demand(validName($registration->name ?? null), 'invalid_registration');
            $statement->execute([$registration->name]);
        }
        $db->commit();
        chmod($root . '/registry.sqlite', 0600);
        syncDirectory($root);
    }

    private function query(string $sql, array $args = []): \PDOStatement
    {
        $s = $this->db->prepare($sql); $s->execute($args); return $s;
    }

    /** Internal authentication extension; shares the publication/GC writer lock. */
    public function transaction(\Closure $action): mixed
    {
        return $this->mutate(fn() => $action($this->db));
    }

    public function access(string $token): array
    {
        $identity = $this->identity($token);
        $row = $this->query('SELECT i.login,c.expires_at FROM credentials c JOIN identities i ON i.github_id=c.github_id WHERE c.digest=?', [hash('sha256', $token)])->fetch();
        return ['github_id' => $identity, 'login' => $row['login'], 'expires_at' => $row['expires_at']];
    }

    public function revoke(string $token): array
    {
        demand(preg_match('/^[a-f0-9]{64}$/D', $token) === 1, 'unauthorized', 401);
        return $this->mutate(function () use ($token) {
            // Idempotent even after expiry/revocation; the bearer can revoke only itself.
            $this->query('UPDATE credentials SET revoked=1 WHERE digest=?', [hash('sha256', $token)]);
            return ['revoked' => true];
        });
    }

    // All cooperating writers, including GC and credential changes, take this
    // lock. Bounded chunks are read by HTTP before acquiring it.
    private function mutate(\Closure $action): mixed
    {
        $lock = fopen($this->root . '/mutation.lock', 'r+');
        $deadline = microtime(true) + 5;
        try {
            while (!flock($lock, LOCK_EX | LOCK_NB)) {
                demand(microtime(true) < $deadline, 'store_busy', 503);
                usleep(10000);
            }
            $this->db->exec('BEGIN IMMEDIATE');
            try {
                $result = $action();
                $this->db->exec('COMMIT');
                if ($this->probe) ($this->probe)('after_commit');
                return $result;
            } catch (\Throwable $error) {
                if ($this->db->inTransaction()) $this->db->exec('ROLLBACK');
                throw $error;
            }
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    private function identity(string $token): string
    {
        demand(preg_match('/^[a-f0-9]{64}$/D', $token) === 1, 'unauthorized', 401);
        $row = $this->query('SELECT github_id FROM credentials WHERE digest=? AND revoked=0 AND expires_at>?', [hash('sha256', $token), time()])->fetch();
        demand($row !== false, 'unauthorized', 401);
        return $row['github_id'];
    }

    private function checkOwner(string $name, string $identity): void
    {
        $owner = $this->query('SELECT * FROM names WHERE name=?', [$name])->fetch();
        if ($owner) demand($owner['github_id'] === $identity && $owner['name'] === $name && !(bool)$owner['reserved'], 'name_unavailable', 403);
        // A dotted name cannot squat a namespace already held or reserved by
        // another identity. Explicit cross-owner delegations are added with
        // the namespace qualification slice; failing closed preserves rights.
        $parts = explode('.', $name); array_pop($parts);
        while ($parts !== []) {
            $parent = $this->query('SELECT * FROM names WHERE name=?', [implode('.', $parts)])->fetch();
            demand($parent !== false && $parent['github_id'] === $identity && !(bool)$parent['reserved'], 'namespace_unavailable', 403);
            array_pop($parts);
        }
    }

    public function create(string $token, \stdClass $body): array
    {
        // Validate credentials before spending effort on metadata admission.
        $this->identity($token);
        $d = new Descriptor($body, $this->limits);
        return $this->mutate(function () use ($token, $d) {
            $identity = $this->identity($token);
            $this->checkOwner($d->manifest->name, $identity);
            $existing = $this->query('SELECT * FROM publications WHERE github_id=? AND digest=?', [$identity, $d->digest])->fetch(\PDO::FETCH_ASSOC);
            if ($existing && ($existing['state'] === 'published' || ($existing['state'] === 'receiving' && $existing['expires_at'] > time()))) {
                return $this->statusInside($token, $existing['id']);
            }
            $published = $this->query('SELECT digest FROM versions WHERE name=? AND version=?', [$d->manifest->name, $d->manifest->version])->fetchColumn();
            demand($published === false || $published === $d->digest, 'version_conflict', 409);
            $count = $this->query("SELECT COUNT(*) FROM publications WHERE github_id=? AND state='receiving' AND expires_at>?", [$identity, time()])->fetchColumn();
            demand($count < $this->limits['sessions'], 'session_limit', 429);
            // Conservative logical reservation: deduplication never increases
            // the quota an account is allowed to consume.
            $used = (int)$this->query('SELECT COALESCE(SUM(bytes),0) FROM versions')->fetchColumn();
            $used += (int)$this->query("SELECT COALESCE(SUM(bytes),0) FROM publications WHERE state='receiving' AND expires_at>?", [time()])->fetchColumn();
            demand($used + $d->bytes <= $this->limits['capacity'], 'storage_quota', 429);
            demand(disk_free_space($this->root) > $this->limits['reserve'] + $d->bytes, 'storage_reserve', 507);
            if ($existing) {
                // A new attempt after expiry starts at acknowledged offset zero.
                // Complete CAS objects remain reusable; partial files may have
                // been removed by GC. The old attempt remains inaccessible.
                $this->query('DELETE FROM uploads WHERE publication=?', [$existing['id']]);
                $this->query('DELETE FROM publications WHERE id=?', [$existing['id']]);
            }
            $id = bin2hex(random_bytes(16));
            $this->query("INSERT INTO publications VALUES (?,?,?,?,?,?,?,?,'receiving')", [$id, $identity, $d->digest, $d->manifest->name, $d->manifest->version, $d->json, $d->bytes, time() + $this->limits['ttl']]);
            foreach ($d->objects as $digest => $size) $this->query('INSERT INTO uploads(publication,digest,size) VALUES (?,?,?)', [$id, $digest, $size]);
            return $this->statusInside($token, $id);
        });
    }

    private function publication(string $token, string $id): array
    {
        $identity = $this->identity($token);
        $row = $this->query('SELECT * FROM publications WHERE id=?', [$id])->fetch(\PDO::FETCH_ASSOC);
        demand($row !== false, 'publication_not_found', 404);
        demand($row['github_id'] === $identity, 'forbidden', 403);
        demand($row['state'] === 'published' || ($row['state'] === 'receiving' && $row['expires_at'] > time()), 'publication_expired', 410);
        return $row;
    }

    public function status(string $token, string $id): array
    {
        return $this->mutate(fn() => $this->statusInside($token, $id));
    }

    private function statusInside(string $token, string $id): array
    {
        $p = $this->publication($token, $id);
        $objects = [];
        foreach ($this->query('SELECT * FROM uploads WHERE publication=? ORDER BY digest', [$id])->fetchAll(\PDO::FETCH_ASSOC) as $upload) {
            $available = is_file($this->objectPath($upload['digest']));
            $objects[] = ['sha256' => $upload['digest'], 'size' => $upload['size'], 'offset' => $available ? $upload['size'] : $upload['offset'], 'available' => $available];
        }
        return ['id' => $id, 'state' => $p['state'], 'publication_sha256' => $p['digest'], 'objects' => $objects];
    }

    private function objectPath(string $digest): string { return $this->root . '/objects/' . $digest; }
    private function uploadPath(string $id, string $digest): string { return $this->root . '/uploads/' . $id . '-' . $digest; }

    public function append(string $token, string $id, string $digest, int $offset, string $bytes): array
    {
        demand(strlen($bytes) <= $this->limits['chunk'], 'chunk_limit', 413);
        return $this->mutate(function () use ($token, $id, $digest, $offset, $bytes) {
            $p = $this->publication($token, $id);
            demand($p['state'] === 'receiving', 'already_published', 409);
            $u = $this->query('SELECT * FROM uploads WHERE publication=? AND digest=?', [$id, $digest])->fetch(\PDO::FETCH_ASSOC);
            demand($u !== false, 'object_not_declared', 404);
            if (is_file($this->objectPath($digest))) return ['offset' => $u['size']];
            demand($offset === $u['offset'], 'offset_conflict', 409);
            demand($offset + strlen($bytes) <= $u['size'] && (strlen($bytes) > 0 || $u['size'] === 0), 'invalid_chunk');
            demand(disk_free_space($this->root) > $this->limits['reserve'] + strlen($bytes), 'storage_reserve', 507);
            $path = $this->uploadPath($id, $digest);
            $handle = fopen($path, 'c+b');
            try {
                demand(fstat($handle)['size'] >= $offset, 'upload_corrupt', 503);
                // Bytes written before a failed DB commit are not acknowledged.
                if (!ftruncate($handle, $offset) || fseek($handle, $offset) !== 0) throw new \RuntimeException('seek_failed');
                writeAll($handle, $bytes);
                if (!fsync($handle)) throw new \RuntimeException('sync_failed');
                if ($this->probe) ($this->probe)('after_bytes');
            } finally { fclose($handle); }
            syncDirectory($this->root . '/uploads');
            $next = $offset + strlen($bytes);
            if ($next === $u['size']) {
                if (hash_file('sha256', $path) !== $digest) {
                    // Preserve the acknowledged prefix; a retry can replace the
                    // last segment, never overwrite a published object.
                    throw new Rejection(422, 'digest_mismatch');
                }
                if (!rename($path, $this->objectPath($digest))) throw new \RuntimeException('object_rename_failed');
                syncDirectory($this->root . '/objects'); syncDirectory($this->root . '/uploads');
                if ($this->probe) ($this->probe)('after_object');
            }
            $this->query('UPDATE uploads SET offset=? WHERE publication=? AND digest=?', [$next, $id, $digest]);
            return ['offset' => $next];
        });
    }

    public function finalize(string $token, string $id): array
    {
        return $this->mutate(function () use ($token, $id) {
            $p = $this->publication($token, $id);
            $this->checkOwner($p['name'], $p['github_id']);
            if ($p['state'] === 'published') return $this->statusInside($token, $id);
            $other = $this->query('SELECT digest FROM versions WHERE name=? AND version=?', [$p['name'], $p['version']])->fetchColumn();
            demand($other === false || $other === $p['digest'], 'version_conflict', 409);
            $d = new Descriptor(objectJson($p['descriptor']), $this->limits);
            foreach ($d->objects as $digest => $size) {
                $path = $this->objectPath($digest);
                demand(is_file($path) && filesize($path) === $size, 'missing_object', 409);
                demand(hash_file('sha256', $path) === $digest, 'stored_object_corrupt', 503);
            }
            SourceArchive::verify($this->objectPath($d->value->source->sha256), $d);
            $this->checkDependencies($d);
            // Long verification cannot extend credential validity.
            $this->identity($token);
            $this->query('INSERT OR IGNORE INTO names(name,github_id) VALUES (?,?)', [$p['name'], $p['github_id']]);
            $this->query('INSERT OR IGNORE INTO versions VALUES (?,?,?,?,?)', [$p['name'], $p['version'], $p['digest'], $p['descriptor'], $p['bytes']]);
            foreach ($d->objects as $digest => $_) $this->query('INSERT OR IGNORE INTO version_objects VALUES (?,?,?)', [$p['name'], $p['version'], $digest]);
            $this->query("UPDATE publications SET state='published' WHERE id=?", [$id]);
            if ($this->probe) ($this->probe)('before_commit');
            return $this->statusInside($token, $id);
        });
    }

    private function checkDependencies(Descriptor $d): void
    {
        foreach (($d->manifest->dependencies ?? new \stdClass()) as $name => $constraint) {
            $minimum = substr($constraint, 1); $found = false;
            foreach ($this->query('SELECT version FROM versions WHERE name=?', [$name])->fetchAll(\PDO::FETCH_COLUMN) as $version) {
                if ($constraint[0] === '=' ? $version === $minimum :
                    (explode('.', $version)[0] === explode('.', $minimum)[0] && version_compare($version, $minimum, '>='))) $found = true;
            }
            demand($found, 'missing_dependency', 409);
        }
    }

    public function version(string $name, string $version): array
    {
        $row = $this->query('SELECT digest,descriptor FROM versions WHERE name=? AND version=?', [$name, $version])->fetch();
        demand($row !== false, 'version_not_found', 404);
        return ['publication_sha256' => $row['digest'], 'descriptor' => objectJson($row['descriptor'])];
    }

    public function versions(string $name): array
    {
        $rows = $this->query('SELECT version,digest FROM versions WHERE name=?', [$name])->fetchAll(\PDO::FETCH_ASSOC);
        demand($rows !== [], 'package_not_found', 404);
        usort($rows, fn($a, $b) => version_compare($b['version'], $a['version']));
        return ['name' => $name, 'versions' => $rows];
    }

    public function content(string $name, string $version, ?string $target = null, ?string $artifact = null): array
    {
        $d = $this->version($name, $version)['descriptor'];
        $blob = $target === null ? $d->source : null;
        foreach ($d->artifacts as $item) if ($item->target === $target && $item->name === $artifact) $blob = $item;
        demand($blob !== null, 'artifact_not_found', 404);
        $path = $this->objectPath($blob->sha256);
        demand(is_file($path), 'stored_object_missing', 503);
        return ['path' => $path, 'size' => $blob->size, 'sha256' => $blob->sha256];
    }

    /** Offline operation sharing the publication lock; never an HTTP endpoint. */
    public function collect(): array
    {
        return $this->mutate(function () {
            $this->query("UPDATE publications SET state='expired' WHERE state='receiving' AND expires_at<=?", [time()]);
            $protected = array_fill_keys($this->query('SELECT DISTINCT digest FROM version_objects')->fetchAll(\PDO::FETCH_COLUMN), true);
            foreach ($this->query("SELECT u.digest FROM uploads u JOIN publications p ON p.id=u.publication WHERE p.state='receiving'")->fetchAll(\PDO::FETCH_COLUMN) as $digest) $protected[$digest] = true;
            $removed = 0;
            foreach (glob($this->root . '/objects/*') as $path) {
                $digest = basename($path);
                if (!preg_match('/^[a-f0-9]{64}$/D', $digest) || is_link($path)) continue;
                if (!isset($protected[$digest]) && filemtime($path) < time() - $this->limits['grace']) {
                    unlink($path); $removed++;
                }
            }
            $active = array_fill_keys($this->query("SELECT u.publication || '-' || u.digest FROM uploads u JOIN publications p ON p.id=u.publication WHERE p.state='receiving'")->fetchAll(\PDO::FETCH_COLUMN), true);
            foreach (glob($this->root . '/uploads/*') as $path) {
                if (preg_match('/^[a-f0-9]{32}-[a-f0-9]{64}$/D', basename($path)) && !isset($active[basename($path)]) && is_file($path) && !is_link($path)) unlink($path);
            }
            syncDirectory($this->root . '/objects'); syncDirectory($this->root . '/uploads');
            return ['removed_objects' => $removed];
        });
    }
}
