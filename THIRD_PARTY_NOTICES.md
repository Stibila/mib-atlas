# Third-party content

The MIB Atlas source repository does not include MIB files or a generated SQL
index. MIBs placed below `server-mibs/` by a deployment operator are separate
third-party works and are not covered by this project's MIT License.

The SQL generator indexes every detected MIB and enables its original download.
Deployment operators are therefore responsible for confirming that they may:

- possess and process each MIB;
- store derived searchable data in MySQL;
- host the original file; and
- offer the original file for download.

Keep copyright, license, attribution, and revision notices intact. Public
availability on a website does not by itself grant redistribution permission.
Retain any notices required by each MIB's governing terms alongside the
deployed collection.
