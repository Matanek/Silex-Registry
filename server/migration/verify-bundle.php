<?php
declare(strict_types=1);
require dirname(__DIR__) . '/src/Store.php';
use Silex\Registry\Descriptor;
use Silex\Registry\Store;
use Silex\Registry\SourceArchive;
use function Silex\Registry\objectJson;
use function Silex\Registry\demand;

if (PHP_SAPI !== 'cli' || count($argv) !== 2) exit(2);
$result = ['verified' => [], 'rejected' => []]; $checked = [];
foreach (glob($argv[1] . '/*@*.json') as $path) {
    try {
        $record = objectJson(file_get_contents($path)); $d = new Descriptor($record->descriptor, Store::LIMITS);
        foreach ($d->objects as $digest => $size) {
            if (!isset($checked[$digest])) {
                $object = $argv[1] . '/objects/' . $digest;
                demand(!is_link($object) && is_file($object) && filesize($object) === $size && hash_file('sha256', $object) === $digest, 'bundle_object_corrupt');
                $checked[$digest] = $size;
            }
            demand($checked[$digest] === $size, 'object_size_conflict');
        }
        SourceArchive::verify($argv[1] . '/objects/' . $d->value->source->sha256, $d);
        $result['verified'][] = basename($path, '.json');
    } catch (Silex\Registry\Rejection $e) { $result['rejected'][] = ['selection' => basename($path, '.json'), 'reason' => $e->reason]; }
}
$result['unique_objects'] = count($checked); $result['physical_bytes'] = array_sum($checked);
echo json_encode($result, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT), "\n";
exit($result['rejected'] === [] ? 0 : 1);
