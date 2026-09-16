<?php
declare(strict_types=1);

namespace Silex\Registry;

require_once __DIR__ . '/Store.php';

/** Administrative snapshots, outside the web process and its document root. */
final class Snapshot
{
    private static function newDirectory(string $path): void
    {
        demand(str_starts_with($path, '/') && realpath(dirname($path)) === dirname($path), 'invalid_snapshot_path');
        demand(!file_exists($path) && !is_link($path), 'destination_exists', 409);
        demand(!str_starts_with($path . '/', dirname(__DIR__, 2) . '/'), 'data_inside_code');
        demand(mkdir($path, 0700), 'snapshot_mkdir_failed');
    }

    private static function copyFile(string $source, string $destination): array
    {
        demand(is_file($source) && !is_link($source), 'unsafe_snapshot_file');
        $in = fopen($source, 'rb'); $out = fopen($destination, 'xb');
        $hash = hash_init('sha256'); $size = 0;
        try {
            chmod($destination, 0600);
            while (!feof($in)) {
                $bytes = fread($in, 1048576);
                demand($bytes !== false, 'snapshot_read_failed');
                hash_update($hash, $bytes); $size += strlen($bytes); writeAll($out, $bytes);
            }
            demand(fsync($out), 'snapshot_sync_failed');
        } finally { fclose($in); fclose($out); }
        return ['size' => $size, 'sha256' => hash_final($hash)];
    }

    private static function validFile(string $path): bool
    {
        return in_array($path, ['registry.sqlite', 'limits.json', 'login.key'], true) ||
            preg_match('/^objects\/[a-f0-9]{64}$/D', $path) === 1 ||
            preg_match('/^uploads\/[a-f0-9]{32}-[a-f0-9]{64}$/D', $path) === 1;
    }

    public static function create(string $root, string $destination): array
    {
        // Validate root/schema before creating anything. Use the same lock as
        // HTTP, GC and login, but no transaction: VACUUM INTO is its own SQLite
        // snapshot and cannot run inside BEGIN IMMEDIATE.
        new Store($root);
        demand(!str_starts_with($destination . '/', $root . '/'), 'snapshot_inside_store');
        self::newDirectory($destination);
        mkdir($destination . '/objects', 0700); mkdir($destination . '/uploads', 0700);
        $lock = fopen($root . '/mutation.lock', 'r+'); $deadline = microtime(true) + 5;
        try {
            while (!flock($lock, LOCK_EX | LOCK_NB)) { demand(microtime(true) < $deadline, 'store_busy', 503); usleep(10000); }
            $db = new \PDO('sqlite:' . $root . '/registry.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
            $db->exec('PRAGMA busy_timeout=5000');
            $db->exec('VACUUM INTO ' . $db->quote($destination . '/registry.sqlite'));
            chmod($destination . '/registry.sqlite', 0600);
            $handle = fopen($destination . '/registry.sqlite', 'r'); demand(fsync($handle), 'snapshot_sync_failed'); fclose($handle);
            $files = ['registry.sqlite' => ['size' => filesize($destination . '/registry.sqlite'), 'sha256' => hash_file('sha256', $destination . '/registry.sqlite')]];
            foreach (['limits.json', 'login.key'] as $name) if (file_exists($root . '/' . $name)) $files[$name] = self::copyFile($root . '/' . $name, $destination . '/' . $name);
            foreach (['objects', 'uploads'] as $directory) {
                demand(!is_link($root . '/' . $directory), 'unsafe_snapshot_directory');
                foreach (scandir($root . '/' . $directory) as $name) {
                    if ($name === '.' || $name === '..') continue;
                    $path = $directory . '/' . $name;
                    demand(self::validFile($path), 'unexpected_store_file');
                    $files[$path] = self::copyFile($root . '/' . $path, $destination . '/' . $path);
                }
                syncDirectory($destination . '/' . $directory);
            }
            self::verifyDatabase($destination);
            $manifest = ['schema' => 1, 'created_at' => gmdate('c'), 'files' => $files];
            $bytes = json_encode($manifest, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
            $handle = fopen($destination . '/snapshot.json', 'x'); chmod($destination . '/snapshot.json', 0600);
            try { writeAll($handle, $bytes); demand(fsync($handle), 'snapshot_sync_failed'); } finally { fclose($handle); }
            syncDirectory($destination); syncDirectory(dirname($destination));
            return ['files' => count($files), 'bytes' => array_sum(array_column($files, 'size')), 'manifest_sha256' => hash('sha256', $bytes)];
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    private static function verifyDatabase(string $root): void
    {
        $db = new \PDO('sqlite:' . $root . '/registry.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $db->exec('PRAGMA query_only=ON');
        demand($db->query('PRAGMA integrity_check')->fetchColumn() === 'ok' && $db->query('PRAGMA foreign_key_check')->fetch() === false, 'snapshot_database_corrupt');
        demand((int)$db->query('PRAGMA user_version')->fetchColumn() === 1, 'unsupported_store');
        $limits = is_file($root . '/limits.json') ? (array)objectJson(file_get_contents($root . '/limits.json')) : [];
        $limits = array_replace(Store::LIMITS, $limits);
        foreach ($db->query('SELECT * FROM versions')->fetchAll(\PDO::FETCH_ASSOC) as $row) {
            $d = new Descriptor(objectJson($row['descriptor']), $limits);
            demand($d->digest === $row['digest'] && $d->manifest->name === $row['name'] && $d->manifest->version === $row['version'], 'snapshot_descriptor_corrupt');
            $query = $db->prepare('SELECT digest FROM version_objects WHERE name=? AND version=?'); $query->execute([$row['name'], $row['version']]);
            $actual = $query->fetchAll(\PDO::FETCH_COLUMN); $expected = array_keys($d->objects); sort($actual); sort($expected);
            demand($actual === $expected, 'snapshot_references_corrupt');
            foreach ($d->objects as $digest => $size) {
                $path = $root . '/objects/' . $digest;
                demand(is_file($path) && !is_link($path) && filesize($path) === $size && hash_file('sha256', $path) === $digest, 'snapshot_object_corrupt');
            }
            SourceArchive::verify($root . '/objects/' . $d->value->source->sha256, $d);
        }
    }

    public static function verify(string $snapshot, string $expectedDigest): \stdClass
    {
        demand(realpath($snapshot) === $snapshot && !is_link($snapshot . '/snapshot.json'), 'invalid_snapshot_path');
        demand(preg_match('/^[a-f0-9]{64}$/D', $expectedDigest) === 1, 'invalid_snapshot_digest');
        $bytes = file_get_contents($snapshot . '/snapshot.json');
        demand(hash('sha256', $bytes) === $expectedDigest, 'snapshot_manifest_mismatch');
        $manifest = objectJson($bytes);
        demand(($manifest->schema ?? null) === 1 && ($manifest->files ?? null) instanceof \stdClass && isset($manifest->files->{'registry.sqlite'}), 'invalid_snapshot');
        foreach ($manifest->files as $path => $file) {
            demand(self::validFile($path), 'unsafe_snapshot_path');
            foreach (['objects', 'uploads'] as $dir) demand(!is_link($snapshot . '/' . $dir), 'unsafe_snapshot_directory');
            demand(is_file($snapshot . '/' . $path) && !is_link($snapshot . '/' . $path) && filesize($snapshot . '/' . $path) === $file->size && hash_file('sha256', $snapshot . '/' . $path) === $file->sha256, 'snapshot_file_corrupt');
        }
        self::verifyDatabase($snapshot);
        return $manifest;
    }

    public static function restore(string $snapshot, string $destination, string $expectedDigest): array
    {
        $manifest = self::verify($snapshot, $expectedDigest);
        self::newDirectory($destination);
        mkdir($destination . '/objects', 0700); mkdir($destination . '/uploads', 0700);
        foreach ($manifest->files as $path => $file) {
            $copied = self::copyFile($snapshot . '/' . $path, $destination . '/' . $path);
            demand($copied['sha256'] === $file->sha256 && $copied['size'] === $file->size, 'snapshot_changed_during_restore');
        }
        self::verifyDatabase($destination);
        // Revocations that happened after the snapshot must not be undone.
        // Restore content and ownership, but require every author to log in anew.
        $db = new \PDO('sqlite:' . $destination . '/registry.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $db->exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE; UPDATE credentials SET revoked=1');
        if ($db->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='login_attempts'")->fetchColumn()) {
            $db->exec("UPDATE login_attempts SET state='expired',device=NULL,user_code=NULL,lease_until=0");
        }
        $db->exec('COMMIT');
        // This marker is last: an interrupted restore is not an initialized
        // service and must never be started. Recover into another empty path.
        $handle = fopen($destination . '/mutation.lock', 'x'); chmod($destination . '/mutation.lock', 0600); demand(fsync($handle), 'snapshot_sync_failed'); fclose($handle);
        syncDirectory($destination . '/objects'); syncDirectory($destination . '/uploads'); syncDirectory($destination); syncDirectory(dirname($destination));
        return ['restored_files' => count(get_object_vars($manifest->files)), 'manifest_sha256' => $expectedDigest];
    }
}
