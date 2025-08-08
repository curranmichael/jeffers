-- Migration 0005: Add TSTP fields to notebooks table
-- These fields store aggregated TSTP data from all objects in the notebook

-- Add summary field for aggregated summaries
ALTER TABLE notebooks ADD COLUMN summary TEXT;

-- Add tags as JSON array (stored as TEXT)
ALTER TABLE notebooks ADD COLUMN tags_json TEXT DEFAULT '[]';

-- Add propositions as JSON array (stored as TEXT)
ALTER TABLE notebooks ADD COLUMN propositions_json TEXT DEFAULT '[]';

-- Add timestamp for when TSTP was last generated
ALTER TABLE notebooks ADD COLUMN tstp_generated_at TEXT;

-- Add index for TSTP generation tracking
CREATE INDEX idx_notebooks_tstp_generated_at ON notebooks(tstp_generated_at);