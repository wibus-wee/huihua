-- Source of truth; cargo xtask regenerate owns the DB.
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO cursorDiskKV VALUES('composerData:old-map','{"composerId":"old-map","name":"old format","fullConversationHeadersOnly":[{"bubbleId":"b1"},{"bubbleId":"b2"}],"conversationMap":{"b1":{"type":1,"text":"legacy hello"},"b2":{"type":2,"text":"legacy reply"}}}');
