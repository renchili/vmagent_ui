package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/go-sql-driver/mysql"
	"gopkg.in/yaml.v3"
)

type Server struct {
	cfg   Config
	r     *gin.Engine
	db    *sql.DB
	store *Store
}

type submitRequest struct {
	Mode           string         `json:"mode"`
	Structured     map[string]any `json:"structuredConfig"`
	YAML           string         `json:"yaml"`
	JSON           map[string]any `json:"json"`
	RuntimeProfile RuntimeProfile `json:"runtimeProfile"`
	Note           string         `json:"note"`
	Author         string         `json:"author"`
}

func NewServer(cfg Config) (*Server, error) {
	db, err := sql.Open("mysql", cfg.DSN)
	if err != nil { return nil, err }
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetMaxIdleConns(5)
	db.SetMaxOpenConns(10)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil { return nil, err }
	store := NewStore(db)
	if err := store.Migrate(ctx); err != nil { return nil, err }
	seed, err := loadSeedDraft(cfg)
	if err != nil { return nil, err }
	if err := store.SeedDraftIfEmpty(ctx, seed); err != nil { return nil, err }

	r := gin.Default()
	r.Static("/", cfg.StaticDir)
	s := &Server{cfg: cfg, r: r, db: db, store: store}
	s.routes()
	return s, nil
}

func (s *Server) Run() error { return s.r.Run(fmt.Sprintf("%s:%s", s.cfg.Host, s.cfg.Port)) }

func (s *Server) routes() {
	s.r.GET("/api/health", s.handleHealth)
	s.r.GET("/api/config", s.handleGetConfig)
	s.r.POST("/api/config", s.handleSaveDraft)
	s.r.POST("/api/validate", s.handleValidate)
	s.r.POST("/api/publish", s.handlePublish)
	s.r.GET("/api/revisions", s.handleListRevisions)
	s.r.GET("/api/audit", s.handleAudit)
}

func (s *Server) handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true, "backend": "go-gin", "database": "mysql", "configPath": s.cfg.VmagentConfigPath})
}

func (s *Server) handleGetConfig(c *gin.Context) {
	draft, err := s.store.GetCurrentDraft(c.Request.Context())
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	if draft == nil { c.JSON(http.StatusNotFound, gin.H{"error": "draft not found"}); return }
	c.JSON(http.StatusOK, gin.H{
		"yaml": draft.YAML,
		"json": draft.JSON,
		"parsed": draft.JSON,
		"structuredConfig": draft.Structured,
		"mode": draft.Mode,
		"runtimeProfile": draft.RuntimeProfile,
		"sourcePath": s.cfg.VmagentConfigPath,
		"draftPath": "mysql:config_drafts.current",
		"runtimeProfilePath": "mysql:config_drafts.runtime_profile",
		"ruleBundle": draft.RuntimeProfile.Governance["ruleBundle"],
		"riskScan": gin.H{"hasRisk": false, "summary": "Go 后端已接管基础配置读写；风险扫描迁移中。"},
	})
}

func (s *Server) handleValidate(c *gin.Context) {
	payload, draft, err := s.parseSubmit(c)
	if err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()}); return }
	c.JSON(http.StatusOK, gin.H{
		"ok": true,
		"mode": payload.Mode,
		"yaml": draft.YAML,
		"json": draft.JSON,
		"parsed": draft.JSON,
		"structuredConfig": draft.Structured,
		"runtimeProfile": draft.RuntimeProfile,
		"validation": gin.H{"ok": true, "backend": "go-gin", "notes": []string{"基础 YAML/JSON 解析通过", "完整风险规则迁移到 Go 仍在进行"}},
		"riskScan": gin.H{"hasRisk": false, "summary": "Go 后端验证通过（第一阶段迁移版）"},
	})
}

func (s *Server) handleSaveDraft(c *gin.Context) {
	_, draft, err := s.parseSubmit(c)
	if err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()}); return }
	if err := s.store.SaveDraft(c.Request.Context(), draft); err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	if err := s.store.AppendAudit(c.Request.Context(), "save_draft", draft.Author, summaryOrDefault(draft.Note, "Saved draft"), nil); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": draft.ID, "yaml": draft.YAML, "json": draft.JSON, "structuredConfig": draft.Structured, "runtimeProfile": draft.RuntimeProfile})
}

func (s *Server) handlePublish(c *gin.Context) {
	_, draft, err := s.parseSubmit(c)
	if err != nil { c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()}); return }
	if err := s.store.SaveDraft(c.Request.Context(), draft); err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	rev, err := s.store.CreateRevision(c.Request.Context(), draft)
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	if err := writeConfigFile(s.cfg.VmagentConfigPath, draft.YAML); err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	if err := s.store.AppendAudit(c.Request.Context(), "publish", draft.Author, summaryOrDefault(draft.Note, "Published config"), &rev.ID); err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	c.JSON(http.StatusOK, gin.H{"ok": true, "revision": rev, "applyResult": gin.H{"method": s.cfg.ApplyMode, "ok": true, "message": "apply pipeline placeholder for Go backend"}})
}

func (s *Server) handleListRevisions(c *gin.Context) {
	items, err := s.store.ListRevisions(c.Request.Context())
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (s *Server) handleAudit(c *gin.Context) {
	items, err := s.store.ListAudit(c.Request.Context())
	if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (s *Server) parseSubmit(c *gin.Context) (*submitRequest, *ConfigDraft, error) {
	var payload submitRequest
	if err := c.ShouldBindJSON(&payload); err != nil { return nil, nil, err }
	if payload.Mode == "" { payload.Mode = "normal" }
	if payload.Author == "" { payload.Author = s.cfg.DefaultAuthor }
	var yamlText string
	jsonPayload := payload.JSON
	if payload.Mode == "advanced" {
		yamlText = strings.TrimSpace(payload.YAML)
		if yamlText == "" && jsonPayload == nil { return nil, nil, errors.New("yaml or json required in advanced mode") }
		if yamlText == "" {
			raw, _ := yaml.Marshal(jsonPayload)
			yamlText = string(raw)
		}
		if jsonPayload == nil {
			if err := yaml.Unmarshal([]byte(yamlText), &jsonPayload); err != nil { return nil, nil, err }
		}
	} else {
		if payload.Structured == nil { return nil, nil, errors.New("structuredConfig required in normal mode") }
		jsonPayload = structuredToConfigPayload(payload.Structured)
		raw, _ := yaml.Marshal(jsonPayload)
		yamlText = string(raw)
	}
	if payload.RuntimeProfile.Cluster == nil { payload.RuntimeProfile.Cluster = map[string]any{} }
	if payload.RuntimeProfile.RemoteWrite == nil { payload.RuntimeProfile.RemoteWrite = map[string]any{} }
	if payload.RuntimeProfile.Governance == nil { payload.RuntimeProfile.Governance = map[string]any{} }
	if payload.RuntimeProfile.Deployment == nil { payload.RuntimeProfile.Deployment = map[string]any{} }
	draft := &ConfigDraft{Mode: payload.Mode, YAML: yamlText, JSON: jsonPayload, Structured: payload.Structured, RuntimeProfile: payload.RuntimeProfile, Author: payload.Author, Note: payload.Note}
	return &payload, draft, nil
}

func structuredToConfigPayload(structured map[string]any) map[string]any {
	result := map[string]any{}
	if global, ok := structured["global"].(map[string]any); ok { result["global"] = global }
	if remoteWrite, ok := structured["remoteWrite"]; ok { result["remote_write"] = remoteWrite }
	if jobs, ok := structured["jobs"].([]any); ok {
		scrape := make([]map[string]any, 0, len(jobs))
		for _, item := range jobs {
			job, _ := item.(map[string]any)
			targetsAny, _ := job["targets"].([]any)
			staticTargets := []string{}
			staticConfigs := []map[string]any{}
			for _, t := range targetsAny {
				target, _ := t.(map[string]any)
				address, _ := target["address"].(string)
				if address != "" { staticTargets = append(staticTargets, address) }
			}
			if len(staticTargets) > 0 { staticConfigs = append(staticConfigs, map[string]any{"targets": staticTargets}) }
			scrape = append(scrape, map[string]any{"job_name": job["jobName"], "metrics_path": job["metricsPath"], "scheme": job["scheme"], "static_configs": staticConfigs})
		}
		result["scrape_configs"] = scrape
	}
	return result
}

func loadSeedDraft(cfg Config) (*ConfigDraft, error) {
	raw, err := os.ReadFile(cfg.DefaultConfigPath)
	if err != nil { return nil, err }
	jsonPayload := map[string]any{}
	if err := yaml.Unmarshal(raw, &jsonPayload); err != nil { return nil, err }
	return &ConfigDraft{Mode: "advanced", YAML: string(raw), JSON: jsonPayload, Structured: map[string]any{}, RuntimeProfile: RuntimeProfile{Cluster: map[string]any{}, RemoteWrite: map[string]any{}, Governance: map[string]any{"ruleBundle": map[string]any{"enabled": false, "enforcementMode": "warn"}}, Deployment: map[string]any{"target": "docker"}}, Author: cfg.DefaultAuthor, Note: "seed draft"}, nil
}

func writeConfigFile(pathName, content string) error {
	if pathName == "" { return nil }
	if err := os.MkdirAll(filepath.Dir(pathName), 0o755); err != nil { return err }
	return os.WriteFile(pathName, []byte(content), 0o644)
}

func summaryOrDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" { return fallback }
	return value
}

func mustJSON(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}
