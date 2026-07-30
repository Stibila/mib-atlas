# Database artifacts

`mib-atlas.sql` is generated from the local, recursively discovered
`server-mibs/` collection by `npm run build:server-data`. It is deployment data
and is intentionally ignored by Git. Import it into the MySQL or MariaDB
database used by the PHP API:

```bash
mysql --default-character-set=utf8mb4 -u USER -p DATABASE < database/mib-atlas.sql
```

The dump drops and recreates only the three `mib_atlas_*` tables. It does not
create or select a database. Back up production data before importing, do not
edit the generated dump manually, and deploy it with the same MIB source tree
from which it was built.
