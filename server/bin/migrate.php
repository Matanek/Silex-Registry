<?php
declare(strict_types=1);
require dirname(__DIR__) . '/src/Migration.php';

if (PHP_SAPI !== 'cli' || count($argv) < 5) {
    fwrite(STDERR, "Usage: php migrate.php <absolute-data-root> <bundle> <reviewed-ownership.json> <name@version>...\n"); exit(2);
}
try {
    $limits = is_file($argv[1] . '/limits.json') ? (array)Silex\Registry\objectJson(file_get_contents($argv[1] . '/limits.json')) : [];
    $migration = new Silex\Registry\Migration(new Silex\Registry\Store($argv[1], $limits), dirname(__DIR__, 2) . '/registry/v1/packages');
    echo json_encode($migration->import($argv[2], $argv[3], array_slice($argv, 4)), JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT), "\n";
} catch (Silex\Registry\Rejection $error) {
    fwrite(STDERR, $error->reason . "\n"); exit(1);
}
