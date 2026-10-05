-- Source of truth; cargo xtask regenerate owns the DB.
CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO ItemTable VALUES('composer.composerData','{"allComposers":[{"composerId":"index-1","name":"index-only","createdAt":1767225600000}]}');
