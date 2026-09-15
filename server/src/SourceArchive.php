<?php
declare(strict_types=1);

namespace Silex\Registry;

/** Scans a bounded gzip/USTAR stream; never extracts or executes package files. */
final class SourceArchive
{
    public static function verify(string $path, Descriptor $descriptor): void
    {
        $input = fopen($path, 'rb');
        $inflate = inflate_init(ZLIB_ENCODING_GZIP);
        $buffer = '';
        $total = 0;
        $seen = [];
        $file = null;
        $remaining = 0;
        $padding = 0;
        $zeros = 0;
        $deadline = microtime(true) + $descriptor->limits['seconds'];
        // Small compressed reads bound the largest individual inflate allocation.
        try {
            while (!feof($input)) {
                demand(microtime(true) < $deadline, 'archive_timeout', 413);
                $compressed = fread($input, 1024);
                if ($compressed === '') break;
                demand(inflate_get_status($inflate) !== ZLIB_STREAM_END, 'trailing_gzip');
                $chunk = @inflate_add($inflate, $compressed, ZLIB_SYNC_FLUSH);
                demand($chunk !== false, 'invalid_gzip');
                $total += strlen($chunk);
                demand($total <= $descriptor->limits['expanded'] + ($descriptor->limits['files'] + 2) * 1024, 'expanded_limit', 413);
                $buffer .= $chunk;
                while (true) {
                    if ($remaining > 0) {
                        $take = min($remaining, strlen($buffer));
                        hash_update($hasher, substr($buffer, 0, $take));
                        $buffer = substr($buffer, $take);
                        $remaining -= $take;
                        if ($remaining > 0) break;
                        demand(hash_final($hasher) === $file->sha256, 'file_digest_mismatch');
                    }
                    if ($padding > 0) {
                        if (strlen($buffer) < $padding) break;
                        demand(substr($buffer, 0, $padding) === str_repeat("\0", $padding), 'invalid_tar_padding');
                        $buffer = substr($buffer, $padding); $padding = 0;
                    }
                    if (strlen($buffer) < 512) break;
                    $header = substr($buffer, 0, 512); $buffer = substr($buffer, 512);
                    if ($header === str_repeat("\0", 512)) { $zeros++; continue; }
                    demand($zeros === 0, 'trailing_tar');
                    $checksum = self::octal(substr($header, 148, 8));
                    $sum = array_sum(unpack('C*', substr_replace($header, str_repeat(' ', 8), 148, 8)));
                    demand($sum === $checksum && substr($header, 257, 6) === "ustar\0", 'invalid_tar_header');
                    demand(in_array($header[156], ["\0", '0'], true), 'unsafe_tar_type');
                    demand(trim(substr($header, 157, 100), "\0") === '', 'unsafe_tar_link');
                    $name = self::text(substr($header, 0, 100));
                    $prefix = self::text(substr($header, 345, 155));
                    if ($prefix !== '') $name = $prefix . '/' . $name;
                    demand(safePath($name) && !isset($seen[$name]), 'unsafe_tar_path');
                    $file = $descriptor->files[$name] ?? null;
                    demand($file !== null, 'unexpected_tar_file');
                    $size = self::octal(substr($header, 124, 12));
                    demand($size === $file->size, 'file_size_mismatch');
                    $seen[$name] = true;
                    $remaining = $size; $padding = (512 - $size % 512) % 512;
                    $hasher = hash_init('sha256');
                    if ($size === 0) demand(hash_final($hasher) === $file->sha256, 'file_digest_mismatch');
                }
            }
            demand(inflate_get_status($inflate) === ZLIB_STREAM_END && inflate_get_read_len($inflate) === filesize($path), 'invalid_gzip_end');
            demand($remaining === 0 && $padding === 0 && $buffer === '' && $zeros >= 2, 'truncated_tar');
            demand(count($seen) === count($descriptor->files), 'missing_tar_file');
        } finally { fclose($input); }
    }

    private static function octal(string $field): int
    {
        $value = trim($field, " \0");
        demand($value !== '' && preg_match('/^[0-7]{1,11}$/D', $value) === 1, 'invalid_tar_number');
        return (int)octdec($value);
    }

    private static function text(string $field): string
    {
        $end = strpos($field, "\0");
        if ($end === false) return $field;
        demand(substr($field, $end) === str_repeat("\0", strlen($field) - $end), 'invalid_tar_text');
        return substr($field, 0, $end);
    }
}
