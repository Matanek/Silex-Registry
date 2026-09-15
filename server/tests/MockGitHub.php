<?php
declare(strict_types=1);

// Offline test infrastructure only. Never loaded by the public bootstrap.
require_once dirname(__DIR__) . '/src/GitHub.php';
use Silex\Registry\GitHub;
use Silex\Registry\Rejection;

function mockState(string $root, Closure $action): mixed
{
    $lock = fopen($root . '/mock.lock', 'c+'); flock($lock, LOCK_EX);
    try {
        $path = $root . '/mock.json';
        $state = is_file($path) ? json_decode(file_get_contents($path), true, 64, JSON_THROW_ON_ERROR) : ['devices' => [], 'calls' => 0];
        $result = $action($state);
        file_put_contents($path, json_encode($state, JSON_THROW_ON_ERROR)); return $result;
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}
function mockClock(string $root): int { return (int)file_get_contents($root . '/clock'); }
function mockGitHub(string $root): GitHub
{
    return new GitHub('OfflineFixtureClient', static function ($method, $url, $form, $token) use ($root) {
        $result = mockState($root, static function (&$state) use ($method, $url, $form, $token) {
            $state['calls']++;
            if ($url === 'https://github.com/login/device/code') {
                if ($method !== 'POST' || $form['scope'] !== '') throw new RuntimeException('Invalid mock request');
                $code = bin2hex(random_bytes(20)); $userCode = sprintf('TEST-%04d', count($state['devices']) + 1);
                $state['devices'][$code] = ['user_code' => $userCode, 'state' => 'pending', 'id' => 1001, 'login' => 'author'];
                return ['device_code' => $code, 'user_code' => $userCode, 'expires_in' => 900, 'interval' => 5, 'verification_uri' => 'https://github.com/login/device'];
            }
            if ($url === 'https://github.com/login/oauth/access_token') {
                $code = $form['device_code']; $device = $state['devices'][$code] ?? null;
                if (!$device || isset($device['issued'])) return ['error' => 'expired_token'];
                if ($device['state'] === 'network') return ['mock_failure' => true];
                if ($device['state'] === 'authorized') {
                    $state['devices'][$code]['issued'] = true;
                    return ['access_token' => 'gho_' . $code, 'token_type' => 'bearer', 'scope' => '', 'refresh_token' => 'fixture-unused'];
                }
                return match ($device['state']) {
                    'slow_down' => ['error' => 'slow_down', 'interval' => 20],
                    'denied' => ['error' => 'access_denied'],
                    'expired' => ['error' => 'expired_token'],
                    default => ['error' => 'authorization_pending'],
                };
            }
            if ($url !== 'https://api.github.com/user' || $method !== 'GET' || !str_starts_with($token, 'gho_')) throw new RuntimeException('Invalid mock identity request');
            $device = $state['devices'][substr($token, 4)];
            return ['id' => $device['id'], 'login' => $device['login'], 'type' => 'User', 'email' => 'discard@example.invalid', 'bio' => 'discard'];
        });
        if (isset($result['mock_failure'])) throw new Rejection(503, 'github_unavailable');
        return (object)$result;
    });
}
