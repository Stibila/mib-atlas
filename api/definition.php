<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$id = api_int('id', 0, 1, PHP_INT_MAX);
$statement = api_db()->prepare(
    "SELECT d.id, d.module_id, d.name, d.declaration_type, d.oid,
            d.parent_oid, d.tree_parent_oid, d.syntax_text, d.access_text,
            d.status_text, d.index_text, d.units_text, d.revision_text,
            d.description_text, d.raw_declaration, m.module_name, m.file_name,
            m.provider, 1 AS downloadable, 1 AS details_available,
            EXISTS(
              SELECT 1 FROM mib_atlas_definitions child
               WHERE child.tree_parent_oid = d.oid
               LIMIT 1
            ) AS has_children
       FROM mib_atlas_definitions d
       JOIN mib_atlas_modules m ON m.id = d.module_id
      WHERE d.id = :id"
);
$statement->execute(['id' => $id]);
$definition = $statement->fetch();
if (!$definition) {
    api_error('Definition not found.', 404);
}

api_json(['definition' => api_definition($definition, true)]);
