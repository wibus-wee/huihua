-- Synthetic native-store compatibility fixture. Source of truth; DB is generated.
CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO cursorDiskKV VALUES('composerData:partial','{"name":"partial","fullConversationHeadersOnly":[{"bubbleId":"missing"}]}');
