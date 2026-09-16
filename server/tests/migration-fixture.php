<?php
declare(strict_types=1);
require dirname(__DIR__) . '/src/Migration.php';
require dirname(__DIR__) . '/src/Snapshot.php';
require dirname(__DIR__) . '/src/Login.php';
use Silex\Registry\Store;
use Silex\Registry\Migration;
use Silex\Registry\Snapshot;
use Silex\Registry\Login;
use function Silex\Registry\objectJson;

if (PHP_SAPI !== 'cli') exit(1);
$r = objectJson(stream_get_contents(STDIN));
try {
    if ($r->action === 'init') { Store::initialize($r->root, $r->registrations); Login::initialize(new Store($r->root)); echo '{}'; exit; }
    $probe = isset($r->crash) ? static function ($point) use ($r) {
        if ($point === $r->crash) posix_kill(getmypid(), SIGKILL);
    } : null;
    $store = new Store($r->root, ['reserve' => 1048576], $probe);
    if ($r->action === 'import') $result = (new Migration($store, $r->registrations))->import($r->bundle, $r->ownership, $r->selections);
    elseif ($r->action === 'snapshot') $result = Snapshot::create($r->root, $r->destination);
    elseif ($r->action === 'restore') $result = Snapshot::restore($r->snapshot, $r->destination, $r->digest);
    elseif ($r->action === 'verify') { Snapshot::verify($r->snapshot, $r->digest); $result = ['verified' => true]; }
    elseif ($r->action === 'inspect') {
        $result = $store->transaction(static fn(PDO $db) => [
            'names' => $db->query('SELECT * FROM names ORDER BY name')->fetchAll(PDO::FETCH_ASSOC),
            'versions' => $db->query('SELECT name,version,digest FROM versions ORDER BY name,version')->fetchAll(PDO::FETCH_ASSOC),
            'owners' => $db->query('SELECT * FROM migration_owners ORDER BY name')->fetchAll(PDO::FETCH_ASSOC),
            'provenance' => $db->query('SELECT * FROM migration_versions ORDER BY name,version')->fetchAll(PDO::FETCH_ASSOC),
            'live_credentials' => $db->query('SELECT count(*) FROM credentials WHERE revoked=0')->fetchColumn(),
            'objects' => array_map('basename', glob($r->root . '/objects/*')),
        ]);
    } elseif ($r->action === 'credential') {
        $store->transaction(static fn(PDO $db) => $db->prepare('INSERT INTO credentials VALUES (?,?,?,0)')->execute([hash('sha256', $r->token), '123', time() + 3600]));
        $result = [];
    } elseif ($r->action === 'access') $result = $store->access($r->token);
    elseif ($r->action === 'rename') {
        $store->transaction(static function (PDO $db) {
            $db->exec("UPDATE identities SET login='Renamed' WHERE github_id='123'; INSERT INTO identities VALUES ('456','Original')");
        }); $result = [];
    } else throw new RuntimeException('unknown_fixture_action');
    echo json_encode($result, JSON_THROW_ON_ERROR);
} catch (Silex\Registry\Rejection $e) { echo json_encode(['error' => $e->reason]); }
