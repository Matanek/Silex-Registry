<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/Store.php';
use Silex\Registry\Store;

if (PHP_SAPI !== 'cli' || count($argv) !== 3 || !in_array($argv[1], ['init', 'collect'], true)) {
    fwrite(STDERR, "Usage: php server/bin/storage.php <init|collect> <absolute-data-root>\n");
    exit(2);
}
if ($argv[1] === 'init') {
    Store::initialize($argv[2], dirname(__DIR__, 2) . '/registry/v1/packages');
    echo "Initialized registry storage.\n";
} else {
    $limits = is_file($argv[2] . '/limits.json') ? (array)Silex\Registry\objectJson(file_get_contents($argv[2] . '/limits.json')) : [];
    echo json_encode((new Store($argv[2], $limits))->collect(), JSON_THROW_ON_ERROR), "\n";
}
