<?php

declare(strict_types=1);

const MIB_ATLAS_MAX_PAGE_SIZE = 500;

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

function api_config(): array
{
    static $config = null;
    if (is_array($config)) {
        return $config;
    }

    $path = __DIR__ . '/config.php';
    if (!is_file($path)) {
        throw new RuntimeException(
            'Missing api/config.php. Copy api/config.example.php and configure it.'
        );
    }
    $loaded = require $path;
    if (!is_array($loaded)) {
        throw new RuntimeException('api/config.php must return a configuration array.');
    }

    foreach (['db_dsn', 'db_user', 'db_password', 'mib_root'] as $key) {
        if (!array_key_exists($key, $loaded) || !is_string($loaded[$key])) {
            throw new RuntimeException("Invalid or missing {$key} in api/config.php.");
        }
    }
    if ($loaded['db_dsn'] === '' || $loaded['db_user'] === '' || $loaded['mib_root'] === '') {
        throw new RuntimeException('Database DSN, user, and MIB root must not be empty.');
    }

    $config = $loaded;
    return $config;
}

function api_db(): PDO
{
    static $connection = null;
    if ($connection instanceof PDO) {
        return $connection;
    }

    $config = api_config();
    $connection = new PDO(
        $config['db_dsn'],
        $config['db_user'],
        $config['db_password'],
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
    return $connection;
}

function api_json(array $payload, int $status = 200, string $cacheControl = 'no-store'): never
{
    http_response_code($status);
    header("Cache-Control: {$cacheControl}");
    echo json_encode(
        $payload,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

function api_error(string $message, int $status = 400): never
{
    api_json(['error' => $message], $status);
}

function api_int(string $name, int $fallback, int $minimum, int $maximum): int
{
    $raw = $_GET[$name] ?? null;
    if ($raw === null || $raw === '') {
        return $fallback;
    }
    if (!is_scalar($raw) || filter_var($raw, FILTER_VALIDATE_INT) === false) {
        api_error("Invalid {$name}.");
    }
    return max($minimum, min($maximum, (int) $raw));
}

function api_text(string $name, int $maximumLength = 160): string
{
    $raw = $_GET[$name] ?? '';
    if (!is_string($raw)) {
        api_error("Invalid {$name}.");
    }
    $value = trim($raw);
    if (strlen($value) > $maximumLength * 4) {
        api_error("{$name} is too long.");
    }
    return $value;
}

function api_like(string $value): string
{
    return str_replace(['=', '%', '_'], ['==', '=%', '=_'], $value);
}

function api_type_condition(string $alias, string $filter, array &$parameters): string
{
    if ($filter === '' || $filter === 'all') {
        return '';
    }
    if ($filter === 'identity') {
        return "{$alias}.declaration_type NOT IN ('OBJECT-TYPE', 'NOTIFICATION-TYPE', 'TRAP-TYPE')";
    }
    $allowed = [
        'OBJECT-TYPE',
        'NOTIFICATION-TYPE',
        'TRAP-TYPE',
        'OBJECT IDENTIFIER',
        'MODULE-IDENTITY',
        'OBJECT-IDENTITY',
        'OBJECT-GROUP',
        'NOTIFICATION-GROUP',
        'MODULE-COMPLIANCE',
        'AGENT-CAPABILITIES',
    ];
    if (!in_array($filter, $allowed, true)) {
        api_error('Invalid type filter.');
    }
    $parameters['filter_type'] = $filter;
    return "{$alias}.declaration_type = :filter_type";
}

function api_definition(array $row, bool $rich = false): array
{
    $definition = [
        'id' => (int) $row['id'],
        'moduleId' => (int) $row['module_id'],
        'name' => $row['name'],
        'type' => $row['declaration_type'],
        'oid' => $row['oid'],
        'parentOid' => $row['parent_oid'],
        'treeParentOid' => $row['tree_parent_oid'],
        'module' => $row['module_name'],
        'fileName' => $row['file_name'],
        'provider' => $row['provider'],
        'downloadable' => (bool) $row['downloadable'],
        'detailsAvailable' => (bool) $row['details_available'],
        'hasChildren' => (bool) ($row['has_children'] ?? false),
    ];
    if ($rich) {
        $definition += [
            'syntax' => $row['syntax_text'],
            'access' => $row['access_text'],
            'status' => $row['status_text'],
            'index' => $row['index_text'],
            'units' => $row['units_text'],
            'revision' => $row['revision_text'],
            'description' => $row['description_text'],
            'raw' => $row['raw_declaration'],
        ];
    }
    return $definition;
}

set_exception_handler(static function (Throwable $error): never {
    error_log((string) $error);
    api_error('The MIB service is temporarily unavailable.', 500);
});
