-- iMessage sync support
-- Run once in Supabase SQL editor before first sync

-- Unique constraint on touches.source_message_id so upsert deduplicates correctly
ALTER TABLE touches
  ADD COLUMN IF NOT EXISTS source_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS touches_source_message_id_unique
  ON touches (source_message_id)
  WHERE source_message_id IS NOT NULL;

-- source_message_id on text_messages for per-message deduplication
ALTER TABLE text_messages
  ADD COLUMN IF NOT EXISTS source_message_id text,
  ADD COLUMN IF NOT EXISTS source text;

CREATE UNIQUE INDEX IF NOT EXISTS text_messages_source_message_id_unique
  ON text_messages (source_message_id)
  WHERE source_message_id IS NOT NULL;

-- source column on unmatched_recipients (may already exist from calendar sync work)
ALTER TABLE unmatched_recipients
  ADD COLUMN IF NOT EXISTS source text;
