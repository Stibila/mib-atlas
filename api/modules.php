<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$query = api_text('q', 100);
$parameters = [];
$where = '';
if ($query !== '') {
    $where = "WHERE file_name LIKE :file_query ESCAPE '='
                 OR module_name LIKE :module_query ESCAPE '='
                 OR provider LIKE :provider_query ESCAPE '='";
    $escapedQuery = api_like($query);
    $parameters['file_query'] = '%' . $escapedQuery . '%';
    $parameters['module_query'] = '%' . $escapedQuery . '%';
    $parameters['provider_query'] = '%' . $escapedQuery . '%';
}

$statement = api_db()->prepare(
    "SELECT id, source_path, file_name, module_name, provider, source_size,
            definition_count
       FROM mib_atlas_modules
       {$where}
      ORDER BY provider, file_name
      LIMIT 1000"
);
$statement->execute($parameters);
$modules = array_map(
    static fn(array $row): array => [
        'id' => (int) $row['id'],
        'path' => $row['source_path'],
        'name' => $row['file_name'],
        'module' => $row['module_name'],
        'provider' => $row['provider'],
        'size' => (int) $row['source_size'],
        'downloadable' => true,
        'detailsAvailable' => true,
        'definitionCount' => (int) $row['definition_count'],
    ],
    $statement->fetchAll()
);

$metadata = api_db()
    ->query("SELECT metadata_key, metadata_value FROM mib_atlas_metadata")
    ->fetchAll(PDO::FETCH_KEY_PAIR);

api_json(
    [
        'modules' => $modules,
        'moduleCount' => (int) ($metadata['source_count'] ?? count($modules)),
        'definitionCount' => (int) ($metadata['definition_count'] ?? 0),
        'resolvedCount' => (int) ($metadata['resolved_count'] ?? 0),
        'schemaVersion' => (int) ($metadata['schema_version'] ?? 0),
    ],
    200,
    'public, max-age=300'
);
