<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$moduleId = api_int('module_id', 0, 1, PHP_INT_MAX);
$statement = api_db()->prepare(
    "SELECT source_path, file_name, source_size
       FROM mib_atlas_modules
      WHERE id = :id"
);
$statement->execute(['id' => $moduleId]);
$module = $statement->fetch();
if (!$module) {
    api_error('MIB not found.', 404);
}

$root = realpath(api_config()['mib_root']);
$file = $root === false ? false : realpath($root . '/' . $module['source_path']);
if (
    $root === false ||
    $file === false ||
    !str_starts_with($file, $root . DIRECTORY_SEPARATOR) ||
    !is_file($file)
) {
    api_error('The original MIB file is unavailable.', 404);
}

$safeName = preg_replace('/[^A-Za-z0-9._-]+/', '_', $module['file_name']) ?: 'download.mib';
header_remove('Content-Type');
header('Content-Type: text/plain; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: private, max-age=3600');
header('Content-Length: ' . filesize($file));
header("Content-Disposition: attachment; filename=\"{$safeName}\"");
readfile($file);
exit;
