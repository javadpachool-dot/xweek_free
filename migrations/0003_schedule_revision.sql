CREATE TABLE IF NOT EXISTS schedule_revision (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO schedule_revision (id, value) VALUES (1, 0);

DROP TRIGGER IF EXISTS tasks_revision_insert;
DROP TRIGGER IF EXISTS tasks_revision_update;
DROP TRIGGER IF EXISTS tasks_revision_delete;
DROP TRIGGER IF EXISTS task_groups_revision_insert;
DROP TRIGGER IF EXISTS task_groups_revision_update;
DROP TRIGGER IF EXISTS task_groups_revision_delete;

CREATE TRIGGER tasks_revision_insert AFTER INSERT ON tasks
BEGIN UPDATE schedule_revision SET value = value + 1 WHERE id = 1; END;
CREATE TRIGGER tasks_revision_update AFTER UPDATE ON tasks
BEGIN UPDATE schedule_revision SET value = value + 1 WHERE id = 1; END;
CREATE TRIGGER tasks_revision_delete AFTER DELETE ON tasks
BEGIN UPDATE schedule_revision SET value = value + 1 WHERE id = 1; END;
CREATE TRIGGER task_groups_revision_insert AFTER INSERT ON task_groups
BEGIN UPDATE schedule_revision SET value = value + 1 WHERE id = 1; END;
CREATE TRIGGER task_groups_revision_update AFTER UPDATE ON task_groups
BEGIN UPDATE schedule_revision SET value = value + 1 WHERE id = 1; END;
CREATE TRIGGER task_groups_revision_delete AFTER DELETE ON task_groups
BEGIN UPDATE schedule_revision SET value = value + 1 WHERE id = 1; END;
