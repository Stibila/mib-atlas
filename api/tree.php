<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$parentOid = api_text('parent_oid', 255);
if ($parentOid !== '' && !preg_match('/^\d+(?:\.\d+)*$/D', $parentOid)) {
    api_error('Invalid parent_oid.');
}
$filter = api_text('type', 64);
$parameters = ['parent_oid' => $parentOid];
$conditions = ["d.tree_parent_oid = :parent_oid", "d.oid <> ''"];
$typeCondition = api_type_condition('d', $filter, $parameters);
if ($typeCondition !== '') {
    $conditions[] = $typeCondition;
}
$where = implode(' AND ', $conditions);

$statement = api_db()->prepare(
    "SELECT d.id, d.module_id, d.name, d.declaration_type, d.oid,
            d.parent_oid, d.tree_parent_oid, m.module_name, m.file_name,
            m.provider, 1 AS downloadable, 1 AS details_available,
            EXISTS(
              SELECT 1 FROM mib_atlas_definitions child
               WHERE child.tree_parent_oid = d.oid
               LIMIT 1
            ) AS has_children
       FROM mib_atlas_definitions d
       JOIN mib_atlas_modules m ON m.id = d.module_id
      WHERE {$where}
      ORDER BY d.oid_sort, d.name
      LIMIT 1000"
);
$statement->execute($parameters);

api_json([
    'parentOid' => $parentOid,
    'definitions' => array_map(
        static fn(array $row): array => api_definition($row),
        $statement->fetchAll()
    ),
]);
