-- MIS Connections table
-- Stores connection profiles for WCP and AE with encrypted tokens
-- Tokens are AES-GCM encrypted at the application layer before storage

CREATE TABLE IF NOT EXISTS mis_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                          -- Display name (e.g. "PALA-Future", "AE Production")
    type TEXT NOT NULL CHECK (type IN ('wcp', 'ae')),  -- Connection type
    is_active BOOLEAN DEFAULT false,             -- Only one can be active at a time

    -- WCP-specific fields
    cluster TEXT,                                 -- e.g. "eu", "us", "future.dev.cloudi.city"
    ecan TEXT,                                   -- Esko Cloud Account Number
    repo_id TEXT,                                -- Repository ID

    -- AE-specific fields
    server_url TEXT,                             -- AE server base URL

    -- Encrypted token (AES-GCM encrypted, stored as base64)
    encrypted_token TEXT,                        -- The encrypted equipment/auth token
    token_iv TEXT,                               -- Initialization vector for AES-GCM (base64)

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: No public access, only service key
ALTER TABLE mis_connections ENABLE ROW LEVEL SECURITY;

-- No RLS policies = only service key can access (same pattern as other tables)

-- Index for quick active lookup
CREATE INDEX IF NOT EXISTS idx_mis_connections_active ON mis_connections (is_active) WHERE is_active = true;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_mis_connections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mis_connections_updated_at
    BEFORE UPDATE ON mis_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_mis_connections_updated_at();
