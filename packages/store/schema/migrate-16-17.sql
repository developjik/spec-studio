BEGIN IMMEDIATE;
ALTER TABLE project ADD COLUMN active_screen_id TEXT;
ALTER TABLE project ADD COLUMN screen_order TEXT NOT NULL DEFAULT '[]';
UPDATE project SET active_screen_id = (SELECT id FROM obj WHERE project_id = project.id AND kind = 'screen' AND deleted_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1);
UPDATE project SET screen_order = (SELECT json_group_array(id) FROM (SELECT id FROM obj WHERE project_id=project.id AND kind='screen' AND deleted_at IS NULL ORDER BY created_at,rowid));
PRAGMA user_version = 17;
COMMIT;
