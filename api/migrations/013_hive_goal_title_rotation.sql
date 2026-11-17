-- 013_hive_goal_title_rotation.sql
-- C9: add title_index to hivv_hive_goal so titles rotate automatically each week.
ALTER TABLE hivv_hive_goal ADD COLUMN title_index INTEGER DEFAULT 0;
UPDATE hivv_hive_goal SET title_index = 0 WHERE id = 1;
