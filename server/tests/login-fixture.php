<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/Login.php';
require __DIR__ . '/MockGitHub.php';
use Silex\Registry\Login;
use Silex\Registry\Store;
use Silex\Registry\Rejection;

if (PHP_SAPI !== 'cli') exit(1);
$request = json_decode(stream_get_contents(STDIN), true, 64, JSON_THROW_ON_ERROR);
$root = $request['root']; $action = $request['action'];
if ($action === 'init') {
    Store::initialize($root, dirname(__DIR__, 2) . '/registry/v1/packages');
    Login::initialize(new Store($root)); file_put_contents($root . '/clock', (string)time());
}
$store = new Store($root);
$probe = isset($request['crash']) ? static function ($point) use ($request) {
    if ($point === $request['crash']) posix_kill(getmypid(), SIGKILL);
} : null;
$login = new Login($store, mockGitHub($root), static fn() => mockClock($root), $probe);
try {
    $result = match ($action) {
        'init' => [],
        'tick' => file_put_contents($root . '/clock', (string)(mockClock($root) + $request['seconds'])),
        'configure' => mockState($root, static function (&$state) use ($request) {
            foreach ($state['devices'] as &$device) if ($device['user_code'] === $request['user_code']) {
                $device['state'] = $request['state'];
                $device['id'] = $request['id'] ?? $device['id'];
                $device['login'] = $request['login'] ?? $device['login'];
                return [];
            }
            throw new RuntimeException('Missing mock device');
        }),
        'inspect' => $store->transaction(static fn(PDO $db) => [
            'attempts' => $db->query('SELECT id,state,device,ticket_digest FROM login_attempts')->fetchAll(PDO::FETCH_ASSOC),
            'credentials' => $db->query('SELECT digest,github_id,expires_at,revoked FROM credentials')->fetchAll(PDO::FETCH_ASSOC),
            'identities' => $db->query('SELECT * FROM identities')->fetchAll(PDO::FETCH_ASSOC),
            'calls' => mockState($root, static fn(&$state) => $state['calls']),
        ]),
        'expire-access' => $store->transaction(static fn(PDO $db) => $db->exec('UPDATE credentials SET expires_at=0')),
        'begin' => $login->begin($request['ticket']),
        'poll' => $login->poll($request['id'], $request['ticket']),
        'collect' => $login->collect(),
        default => throw new RuntimeException('Unknown test action'),
    };
    echo json_encode($result, JSON_THROW_ON_ERROR);
} catch (Rejection $error) { echo json_encode(['error' => $error->reason, 'status' => $error->status]); }
