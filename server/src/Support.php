<?php
declare(strict_types=1);

namespace Silex\Registry;

final class Rejection extends \RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $reason)
    {
        parent::__construct($reason);
    }
}

function demand(bool $condition, string $reason, int $status = 422): void
{
    if (!$condition) throw new Rejection($status, $reason);
}

function canonical(mixed $value): string
{
    if ($value instanceof \stdClass) {
        $fields = get_object_vars($value);
        ksort($fields, SORT_STRING);
        $parts = [];
        foreach ($fields as $key => $child) $parts[] = canonical((string)$key) . ':' . canonical($child);
        return '{' . implode(',', $parts) . '}';
    }
    if (is_array($value)) return '[' . implode(',', array_map(canonical(...), $value)) . ']';
    demand(!is_float($value), 'non_integer_number');
    return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS);
}

function objectJson(string $json): \stdClass
{
    try { $value = json_decode($json, false, 64, JSON_THROW_ON_ERROR); }
    catch (\JsonException) { throw new Rejection(422, 'invalid_json'); }
    demand($value instanceof \stdClass, 'expected_object');
    return $value;
}

function fields(\stdClass $value, array $keys): void
{
    $actual = array_keys(get_object_vars($value));
    sort($actual); sort($keys);
    demand($actual === $keys, 'unexpected_fields');
}

function validName(mixed $name): bool
{
    return is_string($name) && strlen($name) <= 128 &&
        preg_match('/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/D', $name) === 1 &&
        !in_array(explode('.', $name)[0], ['Package', 'Module'], true);
}

function validVersion(mixed $version): bool
{
    if (!is_string($version) || preg_match('/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/D', $version) !== 1) return false;
    foreach (explode('.', $version) as $part) if (strlen($part) > 10 || (int)$part > 4294967295) return false;
    return true;
}

function safePath(mixed $path): bool
{
    if (!is_string($path) || strlen($path) > 240 || !mb_check_encoding($path, 'UTF-8')) return false;
    if (\Normalizer::normalize($path) !== $path || preg_match('/[\\\\\x00-\x1f\x7f:<>"|?*]/u', $path)) return false;
    foreach (explode('/', $path) as $part) {
        if ($part === '' || $part === '.' || $part === '..' || preg_match('/[. ]$/', $part)) return false;
        if (preg_match('/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i', $part)) return false;
        if (in_array(strtolower($part), ['.git', '.silex'], true)) return false;
    }
    return true;
}

function syncDirectory(string $path): void
{
    $handle = fopen($path, 'r');
    try { if (!fsync($handle)) throw new \RuntimeException('directory_sync_failed'); }
    finally { fclose($handle); }
}

function writeAll($handle, string $bytes): void
{
    $offset = 0;
    while ($offset < strlen($bytes)) {
        $count = fwrite($handle, substr($bytes, $offset));
        if ($count === false || $count === 0) throw new \RuntimeException('write_failed');
        $offset += $count;
    }
}
