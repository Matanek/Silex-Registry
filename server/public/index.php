<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/Http.php';
use Silex\Registry\GitHub;
use Silex\Registry\Login;
use Silex\Registry\Store;
use function Silex\Registry\demand;
use function Silex\Registry\objectJson;

registryServe(static function (): array {
    $root = getenv('SILEX_REGISTRY_DATA');
    demand(is_string($root) && $root !== '', 'missing_data_root', 503);
    $limits = is_file($root . '/limits.json') ? (array)objectJson(file_get_contents($root . '/limits.json')) : [];
    $store = new Store($root, $limits);
    return [$store, static function () use ($store): Login {
        $clientId = getenv('SILEX_GITHUB_CLIENT_ID');
        demand(is_string($clientId) && $clientId !== '', 'github_not_configured', 503);
        return new Login($store, new GitHub($clientId));
    }];
});
