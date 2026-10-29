-- Case- and diacritic-insensitive tokens with prefix indexes for 2, 3, and 4 characters (R21.1, R21.3).
CREATE VIRTUAL TABLE `search_fts` USING fts5(
  title, body,
  content = 'search_docs', content_rowid = 'doc_key',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);
--> statement-breakpoint
CREATE TRIGGER `search_docs_ai` AFTER INSERT ON `search_docs` BEGIN
  INSERT INTO search_fts (rowid, title, body) VALUES (new.doc_key, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_ad` AFTER DELETE ON `search_docs` BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body) VALUES ('delete', old.doc_key, old.title, old.body);
END;
--> statement-breakpoint
-- Flag changes such as withdrawal leave the index alone; only indexed text and keys rewrite it.
CREATE TRIGGER `search_docs_au` AFTER UPDATE OF doc_key, title, body ON `search_docs` BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body) VALUES ('delete', old.doc_key, old.title, old.body);
  INSERT INTO search_fts (rowid, title, body) VALUES (new.doc_key, new.title, new.body);
END;
