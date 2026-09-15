<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/GitHub.php';
use Silex\Registry\GitHub;
use Silex\Registry\Rejection;

function check(bool $condition): void { if (!$condition) throw new RuntimeException('Assertion failed'); }
function rejected(Closure $action, string $reason): void {
    try { $action(); } catch (Rejection $error) { check($error->reason === $reason); return; }
    throw new RuntimeException('Expected rejection');
}
function response(array $fields): stdClass { return (object)$fields; }
$device = [
    'device_code' => str_repeat('a', 40), 'user_code' => 'ABCD-1234',
    'verification_uri' => 'https://github.com/login/device', 'expires_in' => 900, 'interval' => 5,
];
$requests = [];
$adapter = new GitHub('FixtureClientId1234', static function ($method, $url, $form, $token) use ($device, &$requests) {
    $requests[] = [$method, $url, $form, $token]; return response($device);
});
check($adapter->begin() === $device);
check($requests === [['POST', 'https://github.com/login/device/code', ['client_id' => 'FixtureClientId1234', 'scope' => ''], null]]);
foreach (['verification_uri' => 'https://evil.invalid', 'expires_in' => 901, 'interval' => 0, 'device_code' => 'chosen', 'user_code' => '<script>'] as $key => $value) {
    $bad = new GitHub('FixtureClientId1234', static fn() => response(array_replace($device, [$key => $value])));
    rejected(fn() => $bad->begin(), 'invalid_github_response');
}
foreach (['authorization_pending' => 'pending', 'slow_down' => 'slow_down', 'access_denied' => 'denied', 'expired_token' => 'expired', 'incorrect_device_code' => 'expired'] as $error => $state) {
    $adapter = new GitHub('FixtureClientId1234', static fn() => response(['error' => $error]));
    check($adapter->poll($device['device_code']) === ['state' => $state]);
}
$token = 'gho_' . str_repeat('t', 36);
$identityCalls = 0;
$transport = static function ($method, $url, $form, $access) use ($token, &$identityCalls, $device) {
    if ($method === 'POST') {
        check($url === 'https://github.com/login/oauth/access_token');
        check($form === ['client_id' => 'FixtureClientId1234', 'device_code' => $device['device_code'], 'grant_type' => 'urn:ietf:params:oauth:grant-type:device_code']);
        return response(['access_token' => $token, 'refresh_token' => 'never-retain', 'token_type' => 'bearer', 'scope' => '']);
    }
    $identityCalls++;
    check($url === 'https://api.github.com/user' && $access === $token && $form === []);
    return response(['id' => 12345, 'login' => 'fixture-user', 'type' => 'User', 'email' => 'discard@example.invalid', 'bio' => 'discard']);
};
$result = (new GitHub('FixtureClientId1234', $transport))->poll($device['device_code']);
check($result === ['state' => 'authorized', 'github_id' => '12345', 'login' => 'fixture-user']);
check($identityCalls === 1 && !str_contains(json_encode($result), $token));
foreach (['public_repo', 'read:user', 'user:email', 'repo', 'offline_access'] as $scope) {
    $excess = new GitHub('FixtureClientId1234', static fn() => response(['access_token' => $token, 'token_type' => 'bearer', 'scope' => $scope]));
    rejected(fn() => $excess->poll($device['device_code']), 'github_excess_permissions');
}
foreach ([0, '12345', 1.5] as $invalidId) {
    $invalid = new GitHub('FixtureClientId1234', static fn($method) => $method === 'POST'
        ? response(['access_token' => $token, 'token_type' => 'bearer', 'scope' => ''])
        : response(['id' => $invalidId, 'login' => 'fixture-user', 'type' => 'User']));
    rejected(fn() => $invalid->poll($device['device_code']), 'invalid_github_identity');
}
echo "PASS GitHub adapter: fixed endpoints, empty scope, bounded device fields, terminal states, stable ID and profile/token minimization. No live OAuth proof.\n";
