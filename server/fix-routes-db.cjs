const db = require('better-sqlite3')('database.sqlite');
db.prepare("UPDATE upgrade_proposals SET status = 'rejected' WHERE status IN ('pending', 'implementing')").run();
console.log('Pending proposals cleared.');
