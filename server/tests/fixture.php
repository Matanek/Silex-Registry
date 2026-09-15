<?php
declare(strict_types=1);

// Test process only; this file is outside the HTTP document root.
require dirname(__DIR__) . '/src/Store.php';
use Silex\Registry\Store;
use function Silex\Registry\objectJson;

if (PHP_SAPI !== 'cli') exit(1);
$request = objectJson(stream_get_contents(STDIN));
$root = $request->root;
$action = $request->action;
if ($action === 'init') {
    Store::initialize($root, dirname(__DIR__, 2) . '/registry/v1/packages');
    file_put_contents($root . '/limits.json', json_encode($request->limits));
}
$db = new PDO('sqlite:' . $root . '/registry.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$db->exec('PRAGMA busy_timeout=5000');
$fixtureLock = null;
if (in_array($action, ['identity', 'revoke', 'expire'], true)) {
    $fixtureLock = fopen($root . '/mutation.lock', 'r+');
    flock($fixtureLock, LOCK_EX);
    $db->beginTransaction();
}
if ($action === 'identity') {
    $db->prepare('INSERT INTO identities VALUES (?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login')->execute([$request->id, $request->login]);
    $db->prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?,0)')->execute([hash('sha256', $request->token), $request->id, time() + ($request->duration ?? 3600)]);
} elseif ($action === 'revoke') {
    $db->prepare('UPDATE credentials SET revoked=1 WHERE digest=?')->execute([hash('sha256', $request->token)]);
} elseif ($action === 'expire') {
    $db->prepare('UPDATE publications SET expires_at=0 WHERE id=?')->execute([$request->id]);
} elseif ($action === 'inspect') {
    echo json_encode([
        'versions' => $db->query('SELECT name,version,digest FROM versions')->fetchAll(PDO::FETCH_ASSOC),
        'names' => $db->query('SELECT * FROM names')->fetchAll(PDO::FETCH_ASSOC),
        'objects' => array_map('basename', glob($root . '/objects/*')),
        'credentials' => $db->query('SELECT digest,github_id FROM credentials')->fetchAll(PDO::FETCH_ASSOC),
    ]); exit;
} elseif (in_array($action, ['create', 'finalize', 'append', 'collect'], true)) {
    $probe = isset($request->crash) ? static function ($point) use ($request) {
        if ($request->crash === $point) posix_kill(getmypid(), SIGKILL);
    } : null;
    $store = new Store($root, (array)$request->limits, $probe);
    try {
        $result = match ($action) {
            'create' => $store->create($request->token, $request->body),
            'finalize' => $store->finalize($request->token, $request->id),
            'append' => $store->append($request->token, $request->id, $request->digest, $request->offset, base64_decode($request->bytes, true)),
            'collect' => $store->collect(),
        };
        echo json_encode($result); exit;
    } catch (Silex\Registry\Rejection $error) {
        echo json_encode(['error' => $error->reason, 'status' => $error->status]); exit;
    }
}
if ($fixtureLock !== null) {
    $db->commit();
    flock($fixtureLock, LOCK_UN); fclose($fixtureLock);
}
echo '{}';
