<?php
declare(strict_types=1);

// Test-only router: lose the response after the first object chunk commits.
require dirname(__DIR__) . '/src/Http.php';
use Silex\Registry\Store;
use function Silex\Registry\demand;
use function Silex\Registry\objectJson;

registryServe(static function (): array {
    $root = getenv('SILEX_REGISTRY_DATA');
    $counter = getenv('SILEX_PUBLISH_CRASH_COUNTER');
    demand(is_string($root) && $root !== '' && is_string($counter) && $counter !== '', 'missing_test_configuration', 503);
    $limits = is_file($root . '/limits.json') ? (array)objectJson(file_get_contents($root . '/limits.json')) : [];
    $probe = static function (string $point) use ($counter): void {
        if ($point !== 'after_commit') return;
        $handle = fopen($counter, 'c+');
        flock($handle, LOCK_EX);
        $current = (int)stream_get_contents($handle);
        ftruncate($handle, 0); rewind($handle); fwrite($handle, (string)($current + 1)); fflush($handle);
        flock($handle, LOCK_UN); fclose($handle);
        // POST publication is commit 1; the first PATCH object is commit 2.
        if ($current + 1 === 2) posix_kill(getmypid(), SIGKILL);
    };
    return [new Store($root, $limits, $probe), static function (): never { throw new RuntimeException('login_not_used'); }];
});
