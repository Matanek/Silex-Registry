<?php
declare(strict_types=1);

// Explicit interactive qualification; never run by the offline test suite.
require dirname(__DIR__) . '/src/GitHub.php';
use Silex\Registry\GitHub;
use Silex\Registry\Rejection;

if (PHP_SAPI !== 'cli' || count($argv) !== 2) {
    fwrite(STDERR, "Usage: php server/tests/github-live.php <dedicated-public-client-id>\n"); exit(2);
}
try {
    $github = new GitHub($argv[1]);
    $device = $github->begin();
    fwrite(STDOUT, "Authorize this test yourself at https://github.com/login/device with code " . $device['user_code'] . ".\n");
    fwrite(STDOUT, "Expected: identification only, no repository or private email permission. Cancel if permissions differ.\n");
    $deadline = microtime(true) + $device['expires_in'];
    $interval = $device['interval'];
    while (microtime(true) + $interval < $deadline) {
        sleep($interval);
        $result = $github->poll($device['device_code']);
        if ($result['state'] === 'pending') continue;
        if ($result['state'] === 'slow_down') { $interval += 5; continue; }
        if ($result['state'] !== 'authorized') {
            fwrite(STDERR, "Authorization " . $result['state'] . ". No registry account or credential created.\n"); exit(1);
        }
        echo json_encode($result, JSON_THROW_ON_ERROR), "\n";
        echo "Verified directly with GitHub. GitHub tokens/profile were not written to disk. No registry session created.\n";
        exit;
    }
    fwrite(STDERR, "Authorization expired. Start a new test.\n"); exit(1);
} catch (Rejection $error) {
    fwrite(STDERR, $error->reason . ": no registry session created.\n"); exit(1);
}
