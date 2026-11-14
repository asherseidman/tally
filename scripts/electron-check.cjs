// Run inside Electron's runtime (ELECTRON_RUN_AS_NODE=1): proves better-sqlite3 loads against Electron's ABI.
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE t(x)');
db.prepare('INSERT INTO t VALUES (?)').run(42);
const row = db.prepare('SELECT x, sqlite_version() v FROM t').get();
console.log(`  electron ${process.versions.electron} / node ABI ${process.versions.modules}: x=${row.x}, sqlite ${row.v}`);
