CREATE TABLE IF NOT EXISTS config_drafts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    mode VARCHAR(32) NOT NULL,
    yaml_text LONGTEXT NOT NULL,
    json_payload JSON NOT NULL,
    structured_payload JSON NOT NULL,
    runtime_profile JSON NOT NULL,
    author_name VARCHAR(255) NOT NULL,
    note_text TEXT NULL,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS revisions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    revision_key VARCHAR(64) NOT NULL UNIQUE,
    mode VARCHAR(32) NOT NULL,
    yaml_text LONGTEXT NOT NULL,
    json_payload JSON NOT NULL,
    runtime_profile JSON NOT NULL,
    author_name VARCHAR(255) NOT NULL,
    note_text TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    action_name VARCHAR(64) NOT NULL,
    author_name VARCHAR(255) NOT NULL,
    summary_text TEXT NOT NULL,
    revision_id BIGINT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_created_at(created_at),
    CONSTRAINT fk_audit_revision FOREIGN KEY (revision_id) REFERENCES revisions(id) ON DELETE SET NULL
);
