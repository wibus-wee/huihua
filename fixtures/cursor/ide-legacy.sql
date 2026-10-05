-- Synthetic native-store compatibility fixture. Source of truth; DB is generated.
CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO ItemTable VALUES('composer.composerData','{"allComposers":[{"composerId":"legacy-1","name":"legacy","conversation":[{"type":1,"text":"hi"},{"type":2,"richText":{"root":{"children":[{"text":"hello"}]}}}]}]}');
