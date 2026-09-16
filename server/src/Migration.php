<?php
declare(strict_types=1);

namespace Silex\Registry;

require_once __DIR__ . '/Store.php';

/** Offline administrative import. Never loaded by the HTTP entry point. */
final class Migration
{
    public function __construct(private readonly Store $store, private readonly string $registrations) {}

    public function import(string $bundle, string $ownershipFile, array $selections): array
    {
        $ownership = objectJson(file_get_contents($ownershipFile));
        demand(($ownership->schema ?? null) === 1 && is_array($ownership->owners ?? null), 'invalid_ownership');
        $owners = [];
        foreach ($ownership->owners as $owner) {
            demand($owner instanceof \stdClass && validName($owner->name ?? null), 'invalid_owner');
            demand(is_string($owner->github_id ?? null) && preg_match('/^[1-9][0-9]{0,19}$/D', $owner->github_id) === 1, 'invalid_owner_id');
            demand(is_string($owner->login ?? null) && preg_match('/^[A-Za-z0-9-]{1,39}$/D', $owner->login) === 1, 'invalid_owner_login');
            demand(is_string($owner->evidence ?? null) && strlen($owner->evidence) >= 16 && strlen($owner->evidence) <= 4096, 'missing_ownership_evidence');
            demand(!isset($owners[$owner->name]), 'duplicate_owner');
            $registration = file_get_contents($this->registrations . '/' . $owner->name . '.json');
            demand(hash('sha256', $registration) === ($owner->registration_sha256 ?? null), 'registration_mismatch');
            demand(objectJson($registration)->repository === ($owner->repository ?? null), 'registration_mismatch');
            $owners[$owner->name] = $owner;
        }
        $prepared = [];
        // Preflight the entire selected lot before changing ownership. Incomplete
        // bytes or a foreign target cannot produce a partially visible version.
        foreach ($selections as $selection) {
            $parts = explode('@', $selection);
            demand(count($parts) === 2 && validName($parts[0]) && validVersion($parts[1]), 'invalid_selection');
            $record = objectJson(file_get_contents($bundle . '/' . $selection . '.json'));
            $descriptor = new Descriptor($record->descriptor, $this->store->limits);
            demand($descriptor->manifest->name === $parts[0] && $descriptor->manifest->version === $parts[1], 'selection_mismatch');
            $owner = $owners[$parts[0]] ?? null;
            demand($owner !== null, 'missing_owner');
            $provenance = $record->provenance;
            demand($provenance->registration->name === $parts[0] && $provenance->registration->repository === $owner->repository &&
                $provenance->registration_sha256 === $owner->registration_sha256 && $provenance->tag === 'v' . $parts[1], 'provenance_mismatch');
            foreach (['commit', 'tree', 'tag_object'] as $key) demand(is_string($provenance->$key ?? null) && preg_match('/^[a-f0-9]{40}$/D', $provenance->$key) === 1, 'invalid_provenance');
            demand($provenance->manifest_sha256 === hash('sha256', $descriptor->value->manifest), 'provenance_mismatch');
            foreach ($descriptor->objects as $digest => $size) {
                $path = $bundle . '/objects/' . $digest;
                demand(!is_link($path) && is_file($path) && filesize($path) === $size && hash_file('sha256', $path) === $digest, 'bundle_object_corrupt');
            }
            SourceArchive::verify($bundle . '/objects/' . $descriptor->value->source->sha256, $descriptor);
            $prepared[] = [$descriptor, $provenance, $owner];
        }
        $this->store->transaction(function (\PDO $db) use ($owners, $prepared) {
            $db->exec('CREATE TABLE IF NOT EXISTS migration_owners (name TEXT PRIMARY KEY REFERENCES names(name), github_id TEXT NOT NULL, evidence TEXT NOT NULL)');
            $db->exec('CREATE TABLE IF NOT EXISTS migration_versions (name TEXT NOT NULL, version TEXT NOT NULL, provenance TEXT NOT NULL, PRIMARY KEY(name,version), FOREIGN KEY(name,version) REFERENCES versions(name,version))');
            foreach ($owners as $owner) {
                $q = $db->prepare('SELECT github_id,reserved FROM names WHERE name=? COLLATE BINARY'); $q->execute([$owner->name]); $row = $q->fetch(\PDO::FETCH_ASSOC);
                demand($row !== false, 'historical_name_missing');
                demand(($row['reserved'] && $row['github_id'] === null) || (!$row['reserved'] && $row['github_id'] === $owner->github_id), 'ownership_conflict');
                $q = $db->prepare('SELECT github_id FROM migration_owners WHERE name=?'); $q->execute([$owner->name]); $prior = $q->fetchColumn();
                demand($prior === false || $prior === $owner->github_id, 'ownership_conflict');
                $db->prepare('INSERT OR IGNORE INTO identities VALUES (?,?)')->execute([$owner->github_id, $owner->login]);
                $db->prepare('UPDATE names SET github_id=?,reserved=0 WHERE name=?')->execute([$owner->github_id, $owner->name]);
                $db->prepare('INSERT OR IGNORE INTO migration_owners VALUES (?,?,?)')->execute([$owner->name, $owner->github_id, canonical($owner)]);
            }
            foreach ($prepared as [$d, $provenance]) {
                $q = $db->prepare('SELECT provenance FROM migration_versions WHERE name=? AND version=?');
                $q->execute([$d->manifest->name, $d->manifest->version]); $prior = $q->fetchColumn();
                demand($prior === false || $prior === canonical($provenance), 'migration_provenance_conflict');
            }
        });
        $tokens = []; $results = [];
        try {
            foreach ($prepared as [$descriptor, $provenance, $owner]) {
                $token = $tokens[$owner->github_id] ?? null;
                if ($token === null) {
                    $token = bin2hex(random_bytes(32)); $tokens[$owner->github_id] = $token;
                    $this->store->transaction(fn(\PDO $db) => $db->prepare('INSERT INTO credentials VALUES (?,?,?,0)')->execute([hash('sha256', $token), $owner->github_id, time() + 3600]));
                }
                $session = $this->store->create($token, $descriptor->value);
                if ($session['state'] !== 'published') {
                    foreach ($session['objects'] as $object) {
                        if ($object['available']) continue;
                        $input = fopen($bundle . '/objects/' . $object['sha256'], 'rb');
                        try {
                            demand(fseek($input, $object['offset']) === 0, 'bundle_seek_failed');
                            $offset = $object['offset'];
                            do {
                                $bytes = fread($input, $this->store->limits['chunk']);
                                $offset = $this->store->append($token, $session['id'], $object['sha256'], $offset, $bytes)['offset'];
                            } while ($offset < $object['size']);
                        } finally { fclose($input); }
                    }
                }
                $result = $this->store->finalize($token, $session['id']);
                $this->store->transaction(function (\PDO $db) use ($descriptor, $provenance) {
                    $db->prepare('INSERT OR IGNORE INTO migration_versions VALUES (?,?,?)')->execute([$descriptor->manifest->name, $descriptor->manifest->version, canonical($provenance)]);
                    $q = $db->prepare('SELECT provenance FROM migration_versions WHERE name=? AND version=?');
                    $q->execute([$descriptor->manifest->name, $descriptor->manifest->version]);
                    demand($q->fetchColumn() === canonical($provenance), 'migration_provenance_conflict');
                });
                $results[] = ['name' => $descriptor->manifest->name, 'version' => $descriptor->manifest->version, 'publication_sha256' => $result['publication_sha256']];
            }
        } finally { foreach ($tokens as $token) $this->store->revoke($token); }
        return $results;
    }
}
