<?php
declare(strict_types=1);
require dirname(__DIR__) . '/src/Snapshot.php';
use Silex\Registry\Snapshot;

if (PHP_SAPI !== 'cli' || !isset($argv[1]) || !in_array($argv[1], ['create', 'verify', 'restore'], true)) {
    fwrite(STDERR, "Usage: php snapshot.php create <data-root> <new-snapshot> | verify <snapshot> <manifest-sha256> | restore <snapshot> <new-data-root> <manifest-sha256>\n"); exit(2);
}
try {
    if ($argv[1] === 'create' && count($argv) === 4) $result = Snapshot::create($argv[2], $argv[3]);
    elseif ($argv[1] === 'verify' && count($argv) === 4) { Snapshot::verify($argv[2], $argv[3]); $result = ['verified' => true]; }
    elseif ($argv[1] === 'restore' && count($argv) === 5) $result = Snapshot::restore($argv[2], $argv[3], $argv[4]);
    else throw new Silex\Registry\Rejection(422, 'invalid_arguments');
    echo json_encode($result, JSON_THROW_ON_ERROR), "\n";
} catch (Silex\Registry\Rejection $error) { fwrite(STDERR, $error->reason . "\n"); exit(1); }
