<?php
declare(strict_types=1);

use Silex\Registry\Rejection;
use Silex\Registry\Store;
use function Silex\Registry\demand;
use function Silex\Registry\objectJson;

require_once __DIR__ . '/Login.php';

/** The production bootstrap supplies real dependencies; tests own a separate router. */
function registryServe(Closure $factory): void
{
ini_set('display_errors', '0');
set_error_handler(static function (int $severity, string $message): bool {
    if (!(error_reporting() & $severity)) return false;
    throw new ErrorException('registry_io_error', 0, $severity);
});
header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

try {
    $local = PHP_SAPI === 'cli-server' && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);
    demand($local || ($_SERVER['HTTPS'] ?? '') === 'on', 'https_required', 400);
    [$store, $loginFactory] = $factory();
    $uri = $_SERVER['REQUEST_URI'] ?? '';
    demand(strlen($uri) <= 512 && !str_contains($uri, '?') && !str_contains($uri, '%'), 'invalid_route', 400);
    $method = $_SERVER['REQUEST_METHOD'];
    $token = '';
    if (preg_match('/^Bearer ([a-f0-9]{64})$/D', $_SERVER['HTTP_AUTHORIZATION'] ?? '', $match)) $token = $match[1];
    if (($uri === '/v2/logins' || preg_match('#^/v2/logins/([a-f0-9]{32})$#D', $uri, $route)) && $method === 'POST') {
        $ticket = '';
        if (preg_match('/^Login ([a-f0-9]{64})$/D', $_SERVER['HTTP_AUTHORIZATION'] ?? '', $match)) $ticket = $match[1];
        demand(body(0) === '', 'unexpected_body');
        $login = $loginFactory();
        $result = $uri === '/v2/logins' ? $login->begin($ticket) : $login->poll($route[1], $ticket);
    } elseif ($uri === '/v2/session' && in_array($method, ['GET', 'DELETE'], true)) {
        demand(body(0) === '', 'unexpected_body');
        $result = $method === 'GET' ? $store->access($token) : $store->revoke($token);
    } elseif ($uri === '/v2/publications' && $method === 'POST') {
        $result = $store->create($token, objectJson(body($store->limits['metadata'])));
    } elseif (preg_match('#^/v2/publications/([a-f0-9]{32})(?:/(finalize|objects/([a-f0-9]{64})))?$#D', $uri, $route)) {
        $id = $route[1]; $action = $route[2] ?? '';
        if ($action === '' && $method === 'GET') $result = $store->status($token, $id);
        elseif ($action === 'finalize' && $method === 'POST') {
            demand(body(0) === '', 'unexpected_body');
            $result = $store->finalize($token, $id);
        } elseif (isset($route[3]) && $method === 'HEAD') {
            $status = $store->status($token, $id); $found = false;
            foreach ($status['objects'] as $object) if ($object['sha256'] === $route[3]) {
                header('Upload-Offset: ' . $object['offset']);
                header('Upload-Length: ' . $object['size']); $found = true;
            }
            demand($found, 'object_not_declared', 404); $result = [];
        } elseif (isset($route[3]) && $method === 'PATCH') {
            $offset = $_SERVER['HTTP_UPLOAD_OFFSET'] ?? '';
            demand(preg_match('/^(0|[1-9][0-9]{0,12})$/D', $offset) === 1, 'invalid_offset', 400);
            $result = $store->append($token, $id, $route[3], (int)$offset, body($store->limits['chunk']));
            header('Upload-Offset: ' . $result['offset']);
        } else throw new Rejection(405, 'method_not_allowed');
    } elseif (preg_match('#^/v2/packages/([A-Za-z0-9_.]+)(?:/versions/([0-9.]+)(?:/(source|artifacts/([a-z0-9-]+)/([A-Za-z0-9_.]+)))?)?$#D', $uri, $route) && in_array($method, ['GET', 'HEAD'], true)) {
        if (!isset($route[2])) $result = $store->versions($route[1]);
        elseif (!isset($route[3])) $result = $store->version($route[1], $route[2]);
        else {
            $content = $store->content($route[1], $route[2], $route[4] ?? null, $route[5] ?? null);
            header('Content-Type: application/octet-stream');
            header('Content-Disposition: attachment; filename="' . $content['sha256'] . '"');
            header('Content-Length: ' . $content['size']);
            header('ETag: "' . $content['sha256'] . '"');
            if ($method === 'GET') readfile($content['path']);
            exit;
        }
    } else throw new Rejection(404, 'route_not_found');
    if ($method !== 'HEAD') echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    $status = $error instanceof Rejection ? $error->status : 503;
    $reason = $error instanceof Rejection ? $error->reason : 'storage_unavailable';
    http_response_code($status);
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'HEAD') echo json_encode([
        'error' => $reason, 'message' => str_replace('_', ' ', $reason),
        'retryable' => in_array($status, [429, 503, 507], true),
    ]);
}
}

function body(int $limit): string
{
    $input = fopen('php://input', 'rb');
    try { $data = stream_get_contents($input, $limit + 1); }
    finally { fclose($input); }
    demand(is_string($data) && strlen($data) <= $limit, 'body_limit', 413);
    return $data;
}
