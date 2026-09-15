<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/Login.php';
use Silex\Registry\Store;
use Silex\Registry\Login;
use Silex\Registry\GitHub;

if (PHP_SAPI !== 'cli' || count($argv) !== 3 || !in_array($argv[1], ['init', 'collect', 'login-init', 'login-collect'], true)) {
    fwrite(STDERR, "Usage: php server/bin/storage.php <init|collect|login-init|login-collect> <absolute-data-root>\n");
    exit(2);
}
if ($argv[1] === 'init') {
    Store::initialize($argv[2], dirname(__DIR__, 2) . '/registry/v1/packages');
    echo "Initialized registry storage.\n";
} else {
    $limits = is_file($argv[2] . '/limits.json') ? (array)Silex\Registry\objectJson(file_get_contents($argv[2] . '/limits.json')) : [];
    $store = new Store($argv[2], $limits);
    if ($argv[1] === 'login-init') { Login::initialize($store); echo "Initialized login storage.\n"; }
    elseif ($argv[1] === 'login-collect') {
        // Collection makes no outbound request; no application configuration needed.
        echo json_encode((new Login($store, new GitHub('UnusedOfflineClient')))->collect(), JSON_THROW_ON_ERROR), "\n";
    } else echo json_encode($store->collect(), JSON_THROW_ON_ERROR), "\n";
}
