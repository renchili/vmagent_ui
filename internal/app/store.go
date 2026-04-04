package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS config_drafts (
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
		)` ,
		`CREATE TABLE IF NOT EXISTS revisions (
			id BIGINT PRIMARY KEY AUTO_INCREMENT,
			revision_key VARCHAR(64) NOT NULL UNIQUE,
			mode VARCHAR(32) NOT NULL,
			yaml_text LONGTEXT NOT NULL,
			json_payload JSON NOT NULL,
			runtime_profile JSON NOT NULL,
			author_name VARCHAR(255) NOT NULL,
			note_text TEXT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS audit_logs (
			id BIGINT PRIMARY KEY AUTO_INCREMENT,
			action_name VARCHAR(64) NOT NULL,
			author_name VARCHAR(255) NOT NULL,
			summary_text TEXT NOT NULL,
			revision_id BIGINT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			INDEX idx_audit_created_at(created_at),
			CONSTRAINT fk_audit_revision FOREIGN KEY (revision_id) REFERENCES revisions(id) ON DELETE SET NULL
		)` ,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetCurrentDraft(ctx context.Context) (*ConfigDraft, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, mode, yaml_text, json_payload, structured_payload, runtime_profile, author_name, COALESCE(note_text,''), created_at, updated_at FROM config_drafts WHERE is_current = TRUE ORDER BY id DESC LIMIT 1`)
	var d ConfigDraft
	var jsonRaw, structuredRaw, runtimeRaw []byte
	if err := row.Scan(&d.ID, &d.Mode, &d.YAML, &jsonRaw, &structuredRaw, &runtimeRaw, &d.Author, &d.Note, &d.CreatedAt, &d.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(jsonRaw, &d.JSON); err != nil { return nil, err }
	if err := json.Unmarshal(structuredRaw, &d.Structured); err != nil { return nil, err }
	if err := json.Unmarshal(runtimeRaw, &d.RuntimeProfile); err != nil { return nil, err }
	return &d, nil
}

func (s *Store) SaveDraft(ctx context.Context, draft *ConfigDraft) error {
	jsonPayload, _ := json.Marshal(draft.JSON)
	structuredPayload, _ := json.Marshal(draft.Structured)
	runtimePayload, _ := json.Marshal(draft.RuntimeProfile)
	if _, err := s.db.ExecContext(ctx, `UPDATE config_drafts SET is_current = FALSE WHERE is_current = TRUE`); err != nil { return err }
	result, err := s.db.ExecContext(ctx, `INSERT INTO config_drafts (mode, yaml_text, json_payload, structured_payload, runtime_profile, author_name, note_text, is_current) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`, draft.Mode, draft.YAML, jsonPayload, structuredPayload, runtimePayload, draft.Author, nullableText(draft.Note))
	if err != nil { return err }
	id, _ := result.LastInsertId()
	draft.ID = id
	return nil
}

func (s *Store) CreateRevision(ctx context.Context, draft *ConfigDraft) (*Revision, error) {
	jsonPayload, _ := json.Marshal(draft.JSON)
	runtimePayload, _ := json.Marshal(draft.RuntimeProfile)
	rev := &Revision{RevisionKey: time.Now().UTC().Format("20060102T150405.000000000Z07:00"), Mode: draft.Mode, YAML: draft.YAML, JSON: draft.JSON, RuntimeProfile: draft.RuntimeProfile, Author: draft.Author, Note: draft.Note}
	result, err := s.db.ExecContext(ctx, `INSERT INTO revisions (revision_key, mode, yaml_text, json_payload, runtime_profile, author_name, note_text) VALUES (?, ?, ?, ?, ?, ?, ?)`, rev.RevisionKey, rev.Mode, rev.YAML, jsonPayload, runtimePayload, rev.Author, nullableText(rev.Note))
	if err != nil { return nil, err }
	id, _ := result.LastInsertId()
	rev.ID = id
	return rev, nil
}

func (s *Store) ListRevisions(ctx context.Context) ([]Revision, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, revision_key, mode, yaml_text, json_payload, runtime_profile, author_name, COALESCE(note_text,''), created_at FROM revisions ORDER BY id DESC LIMIT 100`)
	if err != nil { return nil, err }
	defer rows.Close()
	items := []Revision{}
	for rows.Next() {
		var r Revision
		var jsonRaw, runtimeRaw []byte
		if err := rows.Scan(&r.ID, &r.RevisionKey, &r.Mode, &r.YAML, &jsonRaw, &runtimeRaw, &r.Author, &r.Note, &r.CreatedAt); err != nil { return nil, err }
		if err := json.Unmarshal(jsonRaw, &r.JSON); err != nil { return nil, err }
		if err := json.Unmarshal(runtimeRaw, &r.RuntimeProfile); err != nil { return nil, err }
		items = append(items, r)
	}
	return items, rows.Err()
}

func (s *Store) AppendAudit(ctx context.Context, action, author, summary string, revisionID *int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO audit_logs (action_name, author_name, summary_text, revision_id) VALUES (?, ?, ?, ?)`, action, author, summary, revisionID)
	return err
}

func (s *Store) ListAudit(ctx context.Context) ([]AuditEntry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, action_name, author_name, summary_text, revision_id, created_at FROM audit_logs ORDER BY id DESC LIMIT 200`)
	if err != nil { return nil, err }
	defer rows.Close()
	items := []AuditEntry{}
	for rows.Next() {
		var entry AuditEntry
		var revisionID sql.NullInt64
		if err := rows.Scan(&entry.ID, &entry.Action, &entry.Author, &entry.Summary, &revisionID, &entry.CreatedAt); err != nil { return nil, err }
		if revisionID.Valid { entry.RevisionID = &revisionID.Int64 }
		items = append(items, entry)
	}
	return items, rows.Err()
}

func nullableText(value string) any {
	if value == "" { return nil }
	return value
}

func (s *Store) SeedDraftIfEmpty(ctx context.Context, draft *ConfigDraft) error {
	existing, err := s.GetCurrentDraft(ctx)
	if err != nil { return err }
	if existing != nil { return nil }
	if err := s.SaveDraft(ctx, draft); err != nil { return fmt.Errorf("seed draft: %w", err) }
	return nil
}
