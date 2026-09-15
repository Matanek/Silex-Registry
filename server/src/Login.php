<?php
declare(strict_types=1);

namespace Silex\Registry;

require_once __DIR__ . '/Store.php';
require_once __DIR__ . '/GitHub.php';

/** Private attempt state; outbound GitHub calls never hold the global writer lock. */
final class Login
{
    private string $key;
    public const ACCESS_TTL = 86400;

    public function __construct(private readonly Store $store, private readonly GitHub $github,
        private readonly ?\Closure $clock = null, private readonly ?\Closure $probe = null)
    {
        demand(extension_loaded('sodium'), 'missing_sodium', 503);
        $path = $store->root . '/login.key';
        demand(is_file($path) && !is_link($path) && (fileperms($path) & 077) === 0, 'login_not_initialized', 503);
        $this->key = file_get_contents($path);
        demand(strlen($this->key) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES, 'invalid_login_key', 503);
        $store->transaction(static function (\PDO $db) {
            demand((int)$db->query('SELECT version FROM login_schema')->fetchColumn() === 1, 'unsupported_login_schema', 503);
        });
    }

    /** Explicit offline initialization; does not alter existing publication data. */
    public static function initialize(Store $store): void
    {
        demand(extension_loaded('sodium'), 'missing_sodium', 503);
        $store->transaction(static function (\PDO $db) use ($store) {
            $path = $store->root . '/login.key';
            if (!file_exists($path)) {
                $handle = fopen($path, 'x+b');
                try {
                    chmod($path, 0600);
                    writeAll($handle, sodium_crypto_secretbox_keygen());
                    demand(fsync($handle), 'login_key_sync_failed', 503);
                } finally { fclose($handle); }
                syncDirectory($store->root);
            }
            demand(!is_link($path) && filesize($path) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES && (fileperms($path) & 077) === 0, 'invalid_login_key', 503);
            $db->exec(file_get_contents(dirname(__DIR__) . '/login-schema.sql'));
        });
    }

    private function now(): int { return $this->clock ? ($this->clock)() : time(); }
    private static function query(\PDO $db, string $sql, array $args = []): \PDOStatement
    {
        $query = $db->prepare($sql); $query->execute($args); return $query;
    }
    private static function ticket(string $ticket): string
    {
        demand(preg_match('/^[a-f0-9]{64}$/D', $ticket) === 1, 'invalid_login_ticket', 401);
        return hash('sha256', 'silex-login-ticket:' . $ticket);
    }

    private function expire(\PDO $db, int $now): void
    {
        self::query($db, "UPDATE login_attempts SET state='expired',device=NULL,user_code=NULL WHERE state IN ('starting','pending','polling') AND expires_at<=?", [$now]);
        self::query($db, "UPDATE login_attempts SET state='failed',device=NULL,user_code=NULL WHERE state IN ('starting','polling') AND lease_until<=?", [$now]);
    }
    private static function view(array $row, int $now): array
    {
        $result = ['id' => $row['id'], 'state' => $row['state'], 'expires_at' => $row['expires_at']];
        if ($row['state'] === 'pending') $result += ['user_code' => $row['user_code'], 'verification_uri' => 'https://github.com/login/device', 'interval' => $row['interval']];
        if (in_array($row['state'], ['starting', 'pending', 'polling'], true)) $result['retry_after'] = max(1, $row['next_poll'] - $now);
        return $result;
    }
    private static function row(\PDO $db, string $id): array
    {
        $row = self::query($db, 'SELECT * FROM login_attempts WHERE id=?', [$id])->fetch(\PDO::FETCH_ASSOC);
        demand($row !== false, 'login_not_found', 404); return $row;
    }
    private function seal(string $id, string $device): string
    {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return base64_encode($nonce . sodium_crypto_secretbox($id . ':' . $device, $nonce, $this->key));
    }
    private function open(string $id, string $encrypted): string
    {
        $bytes = base64_decode($encrypted, true);
        demand($bytes !== false && strlen($bytes) > SODIUM_CRYPTO_SECRETBOX_NONCEBYTES, 'invalid_login_state', 503);
        $plain = sodium_crypto_secretbox_open(substr($bytes, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), substr($bytes, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), $this->key);
        demand($plain !== false && str_starts_with($plain, $id . ':'), 'invalid_login_state', 503);
        return substr($plain, strlen($id) + 1);
    }

    public function begin(string $ticket): array
    {
        $digest = self::ticket($ticket);
        $reserved = $this->store->transaction(function (\PDO $db) use ($digest) {
            $now = $this->now(); $this->expire($db, $now);
            $existing = self::query($db, 'SELECT * FROM login_attempts WHERE ticket_digest=?', [$digest])->fetch(\PDO::FETCH_ASSOC);
            if ($existing) return ['view' => self::view($existing, $now)];
            // Global defensive bounds, not an account-level fairness guarantee.
            $count = $db->query("SELECT COUNT(*) FROM login_attempts WHERE state IN ('starting','pending','polling')")->fetchColumn();
            demand($count < 32, 'login_capacity', 429);
            $minute = intdiv($now, 60);
            self::query($db, 'DELETE FROM login_rate WHERE minute<?', [$minute]);
            self::query($db, 'INSERT OR IGNORE INTO login_rate VALUES (?,0)', [$minute]);
            demand((int)self::query($db, 'SELECT starts FROM login_rate WHERE minute=?', [$minute])->fetchColumn() < 10, 'login_rate_limit', 429);
            self::query($db, 'UPDATE login_rate SET starts=starts+1 WHERE minute=?', [$minute]);
            $id = bin2hex(random_bytes(16));
            self::query($db, "INSERT INTO login_attempts(id,ticket_digest,state,created_at,expires_at,lease_until) VALUES (?,?,'starting',?,?,?)", [$id, $digest, $now, $now + 900, $now + 30]);
            return ['id' => $id];
        });
        if (isset($reserved['view'])) return $reserved['view'];
        $id = $reserved['id'];
        try {
            $device = $this->github->begin();
            return $this->store->transaction(function (\PDO $db) use ($id, $device) {
                $now = $this->now(); $this->expire($db, $now); $row = self::row($db, $id);
                if ($row['state'] !== 'starting') return self::view($row, $now);
                self::query($db, "UPDATE login_attempts SET state='pending',expires_at=?,interval=?,next_poll=?,device=?,user_code=? WHERE id=?", [min($row['expires_at'], $now + $device['expires_in']), $device['interval'], $now + $device['interval'], $this->seal($id, $device['device_code']), $device['user_code'], $id]);
                return self::view(self::row($db, $id), $now);
            });
        } catch (\Throwable $error) { $this->fail($id); throw $error; }
    }

    public function poll(string $id, string $ticket): array
    {
        $digest = self::ticket($ticket);
        $reserved = $this->store->transaction(function (\PDO $db) use ($id, $digest) {
            $row = self::row($db, $id);
            demand(hash_equals($row['ticket_digest'], $digest), 'wrong_login_ticket', 403);
            $now = $this->now(); $this->expire($db, $now); $row = self::row($db, $id);
            if ($row['state'] !== 'pending' || $now < $row['next_poll']) return ['view' => self::view($row, $now)];
            self::query($db, "UPDATE login_attempts SET state='polling',lease_until=? WHERE id=?", [$now + 30, $id]);
            return ['row' => $row];
        });
        if (isset($reserved['view'])) return $reserved['view'];
        try {
            $result = $this->github->poll($this->open($id, $reserved['row']['device']));
            if ($this->probe) ($this->probe)('after_github');
            $issued = $this->store->transaction(function (\PDO $db) use ($id, $result) {
                $now = $this->now(); $this->expire($db, $now); $row = self::row($db, $id);
                if ($row['state'] !== 'polling') return self::view($row, $now);
                if (in_array($result['state'], ['pending', 'slow_down'], true)) {
                    $interval = $row['interval'] + ($result['state'] === 'slow_down' ? 5 : 0);
                    $interval = max($interval, $result['interval'] ?? 0);
                    self::query($db, "UPDATE login_attempts SET state='pending',interval=?,next_poll=? WHERE id=?", [$interval, $now + $interval, $id]);
                    return self::view(self::row($db, $id), $now);
                }
                $state = $result['state'];
                demand(in_array($state, ['authorized','denied','expired'], true), 'invalid_login_result', 503);
                self::query($db, 'UPDATE login_attempts SET state=?,device=NULL,user_code=NULL WHERE id=?', [$state === 'authorized' ? 'consumed' : $state, $id]);
                if ($state !== 'authorized') return self::view(self::row($db, $id), $now);
                $identity = $result['github_id'];
                self::query($db, 'INSERT INTO identities VALUES (?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login', [$identity, $result['login']]);
                $token = bin2hex(random_bytes(32)); $expires = $now + self::ACCESS_TTL;
                self::query($db, 'INSERT INTO credentials(digest,github_id,expires_at) VALUES (?,?,?)', [hash('sha256', $token), $identity, $expires]);
                if ($this->probe) ($this->probe)('before_credential_commit');
                return ['id' => $id, 'state' => 'authorized', 'token' => $token, 'expires_at' => $expires, 'github_id' => $identity, 'login' => $result['login']];
            });
            if ($this->probe) ($this->probe)('after_credential_commit');
            return $issued;
        } catch (\Throwable $error) { $this->fail($id); throw $error; }
    }

    private function fail(string $id): void
    {
        $this->store->transaction(static fn(\PDO $db) => self::query($db, "UPDATE login_attempts SET state='failed',device=NULL,user_code=NULL WHERE id=? AND state IN ('starting','polling')", [$id]));
    }

    public function collect(): array
    {
        return $this->store->transaction(function (\PDO $db) {
            $now = $this->now(); $this->expire($db, $now);
            $removed = self::query($db, 'DELETE FROM login_attempts WHERE created_at<?', [$now - 86400])->rowCount();
            self::query($db, 'DELETE FROM login_rate WHERE minute<?', [intdiv($now, 60)]);
            self::query($db, 'DELETE FROM credentials WHERE expires_at<=?', [$now]);
            return ['removed_login_attempts' => $removed];
        });
    }
}
