<?php
declare(strict_types=1);
// Executed by systemd inside the same namespace and identity as the daemon.
function check(bool $condition, string $label): void {
    if (!$condition) { fwrite(STDERR, "ISOLATION FAILED: $label\n"); exit(1); }
}
$role = $argv[1] ?? '';
check(in_array($role, ['fpm', 'gateway'], true), 'known role');
foreach (['/srv/silex/registry/current/v1/index.json', '/etc/letsencrypt',
    '/home/debian', '/var/www', '/var/lib/silex-registry-stage/host-canary'] as $path) {
    check(!file_exists($path), "host path hidden: $path");
}
check(@file_put_contents('/etc/stage/read-only-canary', 'changed') === false, 'immutable root');
check(@file_put_contents('/var/lib/silex-registry-stage/host-canary', 'changed') === false, 'host write denied');
foreach (['exec', 'shell_exec', 'system', 'passthru', 'popen', 'proc_open', 'dl'] as $function)
    check(!function_exists($function), "disabled process function: $function");
if ($role === 'fpm') {
    check(extension_loaded('pdo_sqlite') && extension_loaded('intl') && extension_loaded('mbstring'), 'required extensions');
    check(!file_exists('/gateway/tls.key'), 'gateway private key hidden');
    $canary = '/data/isolation-' . bin2hex(random_bytes(8));
    check(file_put_contents($canary, 'own data') === 8, 'own storage writable');
    check(unlink($canary), 'own temporary data removed');
    foreach (['tcp://127.0.0.1:80', 'tcp://1.1.1.1:443'] as $endpoint) {
        $socket = @stream_socket_client($endpoint, $errno, $error, 1);
        check($socket === false, "outbound TCP denied: $endpoint");
    }
} else {
    check(!file_exists('/data/registry.sqlite'), 'database hidden from gateway');
    check(@file_put_contents('/data/gateway-canary', 'changed') === false, 'gateway cannot write data');
    check(is_readable('/gateway/tls.key'), 'gateway TLS key readable');
}
echo "STAGING_ISOLATION_OK $role\n";
