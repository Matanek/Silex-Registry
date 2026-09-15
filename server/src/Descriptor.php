<?php
declare(strict_types=1);

namespace Silex\Registry;

final class Descriptor
{
    public readonly \stdClass $manifest;
    public readonly string $json;
    public readonly string $digest;
    public array $objects = [];
    public array $files = [];
    public int $bytes = 0;

    public function __construct(public readonly \stdClass $value, public readonly array $limits)
    {
        fields($value, ['schema', 'manifest', 'source', 'files', 'artifacts']);
        demand($value->schema === 1 && is_string($value->manifest), 'unsupported_descriptor');
        demand(strlen($value->manifest) <= 262144, 'manifest_limit', 413);
        $this->manifest = objectJson($value->manifest);
        $m = $this->manifest;
        demand(validName($m->name ?? null) && validVersion($m->version ?? null), 'invalid_identity');
        demand(($m->requires ?? null) instanceof \stdClass && is_string($m->requires->silex ?? null), 'invalid_requirement');
        demand(preg_match('/^>=([0-9]+\.[0-9]+\.[0-9]+)(?: <([0-9]+\.[0-9]+\.[0-9]+))?$/D', $m->requires->silex, $range) === 1, 'invalid_requirement');
        demand(validVersion($range[1]) && (!isset($range[2]) || (validVersion($range[2]) && version_compare($range[1], $range[2], '<'))), 'invalid_requirement');
        if (isset($m->sources)) demand($m->sources === '.' || safePath($m->sources), 'invalid_sources');
        foreach (['dependencies', 'devDependencies'] as $key) {
            if (!isset($m->$key)) continue;
            demand($m->$key instanceof \stdClass, 'invalid_dependencies');
            foreach ($m->$key as $name => $constraint) {
                demand(validName($name) && is_string($constraint) && strlen($constraint) > 1 &&
                    in_array($constraint[0], ['=', '^'], true) && validVersion(substr($constraint, 1)), 'invalid_dependency');
                demand($name !== $m->name && !($key === 'devDependencies' && isset($m->dependencies->$name)), 'invalid_dependency');
            }
        }
        demand(is_array($value->files) && count($value->files) > 0 && count($value->files) <= $limits['files'], 'file_limit', 413);
        $paths = [];
        $expanded = 0;
        foreach ($value->files as $file) {
            demand($file instanceof \stdClass, 'invalid_file');
            fields($file, ['path', 'size', 'sha256']);
            demand(safePath($file->path), 'unsafe_path');
            self::blob($file, $limits['expanded']);
            $key = mb_strtolower($file->path, 'UTF-8');
            demand(!isset($paths[$key]), 'path_collision');
            $paths[$key] = true;
            $this->files[$file->path] = $file;
            $expanded += $file->size;
        }
        foreach (array_keys($paths) as $path) {
            $parent = dirname($path);
            while ($parent !== '.') {
                demand(!isset($paths[$parent]), 'path_collision');
                $parent = dirname($parent);
            }
        }
        demand($expanded <= $limits['expanded'], 'expanded_limit', 413);
        demand(isset($this->files['Package.json']), 'missing_manifest');
        $file = $this->files['Package.json'];
        demand($file->sha256 === hash('sha256', $value->manifest) && $file->size === strlen($value->manifest), 'manifest_mismatch');
        demand($value->source instanceof \stdClass, 'invalid_source');
        fields($value->source, ['size', 'sha256']);
        self::blob($value->source, $limits['source']);
        $this->addObject($value->source);
        demand(is_array($value->artifacts) && count($value->artifacts) <= 256, 'invalid_artifacts');
        $declared = $m->artifacts ?? new \stdClass();
        demand($declared instanceof \stdClass, 'invalid_artifacts');
        $expected = [];
        foreach ($declared as $target => $entries) {
            demand(in_array($target, ['macos-arm64', 'macos-x64', 'linux-arm64', 'linux-x64', 'windows-arm64', 'windows-x64'], true), 'invalid_target');
            demand($entries instanceof \stdClass && count(get_object_vars($entries)) > 0, 'invalid_artifacts');
            foreach ($entries as $name => $entry) {
                demand(validName($name) && $entry instanceof \stdClass && safePath($entry->path ?? null), 'invalid_artifact');
                demand(is_string($entry->sha256 ?? null), 'invalid_artifact');
                $expected[$target . '/' . $name] = $entry;
            }
        }
        $artifactPaths = [];
        foreach ($value->artifacts as $artifact) {
            demand($artifact instanceof \stdClass, 'invalid_artifact');
            fields($artifact, ['target', 'name', 'path', 'size', 'sha256']);
            demand(is_string($artifact->target) && is_string($artifact->name), 'invalid_artifact');
            $key = $artifact->target . '/' . $artifact->name;
            $entry = $expected[$key] ?? null;
            demand($entry !== null && $entry->path === $artifact->path && $entry->sha256 === $artifact->sha256, 'artifact_mismatch');
            $pathKey = mb_strtolower($artifact->path, 'UTF-8');
            foreach (array_keys($paths) as $path) {
                demand($path !== $pathKey && !str_starts_with($path, $pathKey . '/') && !str_starts_with($pathKey, $path . '/'), 'path_collision');
            }
            foreach (($artifactPaths[$artifact->target] ?? []) as $path) {
                demand($path !== $pathKey && !str_starts_with($path, $pathKey . '/') && !str_starts_with($pathKey, $path . '/'), 'path_collision');
            }
            $artifactPaths[$artifact->target][] = $pathKey;
            self::blob($artifact, $limits['object']);
            $this->addObject($artifact);
            unset($expected[$key]);
        }
        demand($expected === [], 'missing_target_artifact');
        $this->json = canonical($value);
        $this->digest = hash('sha256', $this->json);
    }

    private static function blob(\stdClass $blob, int $limit): void
    {
        demand(is_int($blob->size) && $blob->size >= 0 && $blob->size <= $limit, 'object_limit', 413);
        demand(is_string($blob->sha256) && preg_match('/^[a-f0-9]{64}$/D', $blob->sha256) === 1, 'invalid_digest');
    }

    private function addObject(\stdClass $blob): void
    {
        if (isset($this->objects[$blob->sha256])) {
            demand($this->objects[$blob->sha256] === $blob->size, 'object_size_conflict');
            return;
        }
        $this->objects[$blob->sha256] = $blob->size;
        $this->bytes += $blob->size;
    }
}
