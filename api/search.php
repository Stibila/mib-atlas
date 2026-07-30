<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$query = api_text('q');
$filter = api_text('type', 64);
$moduleId = api_int('module_id', 0, 0, PHP_INT_MAX);
$limit = api_int('limit', 100, 1, MIB_ATLAS_MAX_PAGE_SIZE);
$offset = api_int('offset', 0, 0, 1000000);
$conditions = [];
$parameters = [];

if ($moduleId > 0) {
    $conditions[] = 'd.module_id = :module_id';
    $parameters['module_id'] = $moduleId;
}

if ($query !== '') {
    $escapedQuery = api_like($query);
    $tokens = preg_split('/[^\p{L}\p{N}_]+/u', $query, -1, PREG_SPLIT_NO_EMPTY) ?: [];
    $booleanTerms = array_map(
        static fn(string $token): string => '+' . $token . '*',
        array_slice($tokens, 0, 8)
    );
    $searchParts = [
        "d.name LIKE :name_prefix ESCAPE '='",
        "d.oid LIKE :oid_prefix ESCAPE '='",
        "m.module_name LIKE :module_prefix ESCAPE '='",
    ];
    $parameters['name_prefix'] = $escapedQuery . '%';
    $parameters['oid_prefix'] = $escapedQuery . '%';
    $parameters['module_prefix'] = $escapedQuery . '%';
    if ($booleanTerms !== []) {
        $searchParts[] = 'MATCH(d.search_text) AGAINST (:fulltext IN BOOLEAN MODE)';
        $parameters['fulltext'] = implode(' ', $booleanTerms);
    }
    $conditions[] = '(' . implode(' OR ', $searchParts) . ')';
}

$typeCondition = api_type_condition('d', $filter, $parameters);
if ($typeCondition !== '') {
    $conditions[] = $typeCondition;
}
$where = $conditions === [] ? '' : 'WHERE ' . implode(' AND ', $conditions);

$summary = api_db()->prepare(
    "SELECT COUNT(*) AS total,
            COALESCE(SUM(d.oid <> ''), 0) AS resolved
       FROM mib_atlas_definitions d
       JOIN mib_atlas_modules m ON m.id = d.module_id
       {$where}"
);
$summary->execute($parameters);
$counts = $summary->fetch();

$orderBy = $query === '' && $moduleId === 0
    ? 'd.id'
    : "d.oid = '', d.oid_sort, d.name";
$rowsSql =
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
       {$where}
      ORDER BY {$orderBy}
      LIMIT :result_limit OFFSET :result_offset";
$rows = api_db()->prepare($rowsSql);
foreach ($parameters as $name => $value) {
    $rows->bindValue(':' . $name, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
}
$rows->bindValue(':result_limit', $limit, PDO::PARAM_INT);
$rows->bindValue(':result_offset', $offset, PDO::PARAM_INT);
$rows->execute();

$total = (int) $counts['total'];
$resolved = (int) $counts['resolved'];
api_json([
    'definitions' => array_map(
        static fn(array $row): array => api_definition($row),
        $rows->fetchAll()
    ),
    'total' => $total,
    'resolved' => $resolved,
    'unresolved' => $total - $resolved,
    'limit' => $limit,
    'offset' => $offset,
    'hasMore' => $offset + $limit < $total,
]);
