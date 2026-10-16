-- Approval creates a planned project before an institution supplies its
-- execution schedule and contractor. Unknown values must not be invented.
ALTER TABLE project ALTER COLUMN timeline_start DROP NOT NULL;
ALTER TABLE project ALTER COLUMN timeline_end DROP NOT NULL;
ALTER TABLE project ALTER COLUMN contractor DROP NOT NULL;
ALTER TABLE project ADD COLUMN certified_vote_session_id UUID;
CREATE UNIQUE INDEX project_certified_vote_session_id_key ON project(certified_vote_session_id);
