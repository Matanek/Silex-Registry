<?php
declare(strict_types=1);

namespace Silex\Registry;

require_once __DIR__ . '/Support.php';

/** Server-side device-flow adapter. Not an HTTP login/session implementation. */
final class GitHub
{
    public function __construct(private readonly string $clientId, private readonly ?\Closure $transport = null)
    {
        demand(preg_match('/^[A-Za-z0-9_]{16,64}$/D', $clientId) === 1, 'invalid_github_application', 503);
    }

    /** The caller must keep device_code private and bind it to its login attempt. */
    public function begin(): array
    {
        $result = $this->call('POST', 'https://github.com/login/device/code', ['client_id' => $this->clientId, 'scope' => '']);
        demand(!isset($result->error), 'github_device_unavailable', 503);
        demand(is_string($result->device_code ?? null) && preg_match('/^[a-f0-9]{40}$/D', $result->device_code) === 1, 'invalid_github_response', 503);
        demand(is_string($result->user_code ?? null) && preg_match('/^[A-Z0-9]{4}-[A-Z0-9]{4}$/D', $result->user_code) === 1, 'invalid_github_response', 503);
        demand(($result->verification_uri ?? null) === 'https://github.com/login/device', 'invalid_github_response', 503);
        demand(is_int($result->expires_in ?? null) && $result->expires_in > 0 && $result->expires_in <= 900, 'invalid_github_response', 503);
        demand(is_int($result->interval ?? null) && $result->interval > 0 && $result->interval <= $result->expires_in, 'invalid_github_response', 503);
        return [
            'device_code' => $result->device_code, 'user_code' => $result->user_code,
            'verification_uri' => $result->verification_uri,
            'expires_in' => $result->expires_in, 'interval' => $result->interval,
        ];
    }

    /** No GitHub access/refresh token escapes this call. No identity is persisted. */
    public function poll(string $deviceCode): array
    {
        demand(preg_match('/^[a-f0-9]{40}$/D', $deviceCode) === 1, 'invalid_device_code');
        $result = $this->call('POST', 'https://github.com/login/oauth/access_token', [
            'client_id' => $this->clientId, 'device_code' => $deviceCode,
            'grant_type' => 'urn:ietf:params:oauth:grant-type:device_code',
        ]);
        if (isset($result->error)) {
            return match ($result->error) {
                'authorization_pending' => ['state' => 'pending'],
                'slow_down' => ['state' => 'slow_down'],
                'access_denied' => ['state' => 'denied'],
                'expired_token', 'token_expired', 'incorrect_device_code' => ['state' => 'expired'],
                default => throw new Rejection(503, 'github_authorization_unavailable'),
            };
        }
        demand(($result->scope ?? null) === '', 'github_excess_permissions', 403);
        demand(($result->token_type ?? null) === 'bearer' && is_string($result->access_token ?? null) &&
            preg_match('/^[A-Za-z0-9_]{20,255}$/D', $result->access_token) === 1, 'invalid_github_response', 503);
        // Copy only the identity fields; never return or log the profile, access
        // token or refresh token. A failed identity fetch requires a new login.
        $user = $this->call('GET', 'https://api.github.com/user', [], $result->access_token);
        demand(is_int($user->id ?? null) && $user->id > 0 && ($user->type ?? null) === 'User', 'invalid_github_identity', 503);
        demand(is_string($user->login ?? null) && preg_match('/^[A-Za-z0-9-]{1,39}$/D', $user->login) === 1, 'invalid_github_identity', 503);
        return ['state' => 'authorized', 'github_id' => (string)$user->id, 'login' => $user->login];
    }

    private function call(string $method, string $url, array $form, ?string $token = null): \stdClass
    {
        if ($this->transport) return ($this->transport)($method, $url, $form, $token);
        demand(extension_loaded('curl'), 'missing_curl', 503);
        $handle = curl_init($url);
        $body = '';
        $headers = ['Accept: application/json', 'User-Agent: Silex-Registry', 'X-GitHub-Api-Version: 2022-11-28'];
        if ($token !== null) $headers[] = 'Authorization: Bearer ' . $token;
        if ($method === 'POST') $headers[] = 'Content-Type: application/x-www-form-urlencoded';
        try {
            curl_setopt_array($handle, [
                CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers,
                CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 10,
                CURLOPT_WRITEFUNCTION => static function ($unused, string $bytes) use (&$body): int {
                    if (strlen($body) + strlen($bytes) > 32768) return 0;
                    $body .= $bytes; return strlen($bytes);
                },
            ]);
            if ($method === 'POST') curl_setopt($handle, CURLOPT_POSTFIELDS, http_build_query($form, '', '&', PHP_QUERY_RFC3986));
            demand(curl_exec($handle) !== false, 'github_unavailable', 503);
            demand(curl_getinfo($handle, CURLINFO_RESPONSE_CODE) === 200, 'github_unavailable', 503);
            try { return objectJson($body); }
            catch (Rejection) { throw new Rejection(503, 'invalid_github_response'); }
        } finally { curl_close($handle); }
    }
}
