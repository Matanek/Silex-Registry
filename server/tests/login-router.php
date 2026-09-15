<?php
declare(strict_types=1);

// This alternate bootstrap is outside public/ and is used only by run-login.mjs.
require dirname(__DIR__) . '/src/Http.php';
require __DIR__ . '/MockGitHub.php';
use Silex\Registry\Login;
use Silex\Registry\Store;

registryServe(static function (): array {
    $root = getenv('SILEX_REGISTRY_DATA'); $store = new Store($root);
    return [$store, static fn() => new Login($store, mockGitHub($root), static fn() => mockClock($root))];
});
