package app

import "time"

type RuntimeProfile struct {
	Cluster    map[string]any `json:"cluster"`
	RemoteWrite map[string]any `json:"remoteWrite"`
	Governance map[string]any `json:"governance"`
	Deployment map[string]any `json:"deployment"`
}

type ConfigDraft struct {
	ID             int64          `json:"id"`
	Mode           string         `json:"mode"`
	YAML           string         `json:"yaml"`
	JSON           map[string]any `json:"json"`
	Structured     map[string]any `json:"structuredConfig"`
	RuntimeProfile RuntimeProfile `json:"runtimeProfile"`
	Author         string         `json:"author"`
	Note           string         `json:"note"`
	CreatedAt      time.Time      `json:"createdAt"`
	UpdatedAt      time.Time      `json:"updatedAt"`
}

type Revision struct {
	ID             int64          `json:"id"`
	RevisionKey    string         `json:"revisionKey"`
	Mode           string         `json:"mode"`
	YAML           string         `json:"yaml"`
	JSON           map[string]any `json:"json"`
	RuntimeProfile RuntimeProfile `json:"runtimeProfile"`
	Author         string         `json:"author"`
	Note           string         `json:"note"`
	CreatedAt      time.Time      `json:"createdAt"`
}

type AuditEntry struct {
	ID         int64     `json:"id"`
	Action     string    `json:"action"`
	Author     string    `json:"author"`
	Summary    string    `json:"summary"`
	RevisionID *int64    `json:"revisionId,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}
