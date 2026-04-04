package app

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
)

type RuleBundle struct {
	Version         int                `json:"version"`
	Enabled         bool               `json:"enabled"`
	EnforcementMode string             `json:"enforcementMode"`
	Rules           RuleBundleRules    `json:"rules"`
}

type RuleBundleRules struct {
	LabelNaming       PatternRule        `json:"labelNaming"`
	MetricNaming      PatternRule        `json:"metricNaming"`
	SuspiciousChanges SuspiciousRule     `json:"suspiciousChanges"`
	MetricsVolume     MetricsVolumeRule  `json:"metricsVolume"`
}

type PatternRule struct {
	Enabled     bool   `json:"enabled"`
	Severity    string `json:"severity"`
	Pattern     string `json:"pattern"`
	Description string `json:"description"`
}

type SuspiciousRule struct {
	Enabled            bool   `json:"enabled"`
	Severity           string `json:"severity"`
	AdditionsThreshold int    `json:"additionsThreshold"`
	Description        string `json:"description"`
}

type MetricsVolumeRule struct {
	Enabled                        bool     `json:"enabled"`
	Severity                       string   `json:"severity"`
	EstimatedSeriesPerTarget       int      `json:"estimatedSeriesPerTarget"`
	MaxEstimatedSeries             int      `json:"maxEstimatedSeries"`
	MaxLabelCombinationsPerMetric  int      `json:"maxLabelCombinationsPerMetric"`
	HighCardinalityLabels          []string `json:"highCardinalityLabels"`
}

type RiskFinding struct {
	RuleType string `json:"ruleType"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Path     string `json:"path"`
}

type RiskScan struct {
	OK                    bool            `json:"ok"`
	HasRisk               bool            `json:"hasRisk"`
	RequiresManualDecision bool           `json:"requiresManualDecision"`
	Summary               string          `json:"summary"`
	Findings              []RiskFinding   `json:"findings"`
	DecisionPolicy        DecisionPolicy  `json:"decisionPolicy"`
}

type DecisionPolicy struct {
	RequiredAction string                 `json:"requiredAction"`
	Summary        string                 `json:"summary"`
	Semantics      map[string]string      `json:"semantics"`
	Confirmation   map[string]any         `json:"confirmation,omitempty"`
}

type RiskDecision struct {
	OK          bool           `json:"ok"`
	FinalAction string         `json:"finalAction"`
	Message     string         `json:"message,omitempty"`
	Audit       map[string]any `json:"audit"`
}

func DefaultRuleBundle() RuleBundle {
	return RuleBundle{
		Version: 1,
		Enabled: true,
		EnforcementMode: "warn",
		Rules: RuleBundleRules{
			LabelNaming: PatternRule{Enabled: true, Severity: "warning", Pattern: `^[a-z_][a-z0-9_]*$`, Description: "label snake_case"},
			MetricNaming: PatternRule{Enabled: true, Severity: "warning", Pattern: `^[a-z_:][a-z0-9_:]*$`, Description: "metric/job prometheus style"},
			SuspiciousChanges: SuspiciousRule{Enabled: true, Severity: "warning", AdditionsThreshold: 5, Description: "too many added targets/labels/jobs"},
			MetricsVolume: MetricsVolumeRule{Enabled: false, Severity: "warning", EstimatedSeriesPerTarget: 1000, MaxEstimatedSeries: 200000, MaxLabelCombinationsPerMetric: 1000, HighCardinalityLabels: []string{"user_id", "session_id", "trace_id", "request_id", "device_id"}},
		},
	}
}

func ScanConfigChange(previousConfig, nextConfig map[string]any, bundle RuleBundle, mode string) RiskScan {
	bundle = NormalizeRuleBundle(bundle)
	findings := []RiskFinding{}
	previousJobs := make(map[string]struct{})
	for _, item := range getScrapeConfigs(previousConfig) {
		if name := stringValue(item["job_name"]); name != "" { previousJobs[name] = struct{}{} }
	}
	addedJobs := []string{}
	for _, job := range getScrapeConfigs(nextConfig) {
		name := stringValue(job["job_name"])
		if name == "" { continue }
		if _, ok := previousJobs[name]; !ok { addedJobs = append(addedJobs, name) }
		if bundle.Enabled && bundle.Rules.MetricNaming.Enabled && !matchPattern(bundle.Rules.MetricNaming.Pattern, name) {
			findings = append(findings, makeFinding("metricNaming", bundle.Rules.MetricNaming.Severity, fmt.Sprintf("job_name %s 不符合命名规则", name), fmt.Sprintf("scrape_configs.%s.job_name", name)))
		}
		if bundle.Enabled && bundle.Rules.LabelNaming.Enabled {
			for i, group := range getStaticConfigs(job) {
				labels := mapValue(group["labels"])
				for key := range labels {
					if !matchPattern(bundle.Rules.LabelNaming.Pattern, key) {
						findings = append(findings, makeFinding("labelNaming", bundle.Rules.LabelNaming.Severity, fmt.Sprintf("label %s 不符合命名规则", key), fmt.Sprintf("scrape_configs.%s.static_configs[%d].labels.%s", name, i, key)))
					}
				}
			}
		}
	}
	if bundle.Enabled && bundle.Rules.SuspiciousChanges.Enabled {
		addedTargets := countTargets(nextConfig) - countTargets(previousConfig)
		addedLabels := countLabels(nextConfig) - countLabels(previousConfig)
		threshold := bundle.Rules.SuspiciousChanges.AdditionsThreshold
		if len(addedJobs) > 0 {
			findings = append(findings, makeFinding("suspiciousChanges", bundle.Rules.SuspiciousChanges.Severity, fmt.Sprintf("新增 %d 个 job：%v", len(addedJobs), addedJobs), "scrape_configs"))
		}
		if addedTargets >= threshold {
			findings = append(findings, makeFinding("suspiciousChanges", bundle.Rules.SuspiciousChanges.Severity, fmt.Sprintf("本次新增 %d 个 targets，超过阈值 %d", addedTargets, threshold), "scrape_configs[*].static_configs[*].targets"))
		}
		if addedLabels >= threshold {
			findings = append(findings, makeFinding("suspiciousChanges", bundle.Rules.SuspiciousChanges.Severity, fmt.Sprintf("本次新增 %d 个 labels，超过阈值 %d", addedLabels, threshold), "scrape_configs[*].static_configs[*].labels"))
		}
	}
	hasRisk := len(findings) > 0
	overrideToken := ""
	if hasRisk {
		sum := sha256.Sum256([]byte(fmt.Sprintf("%v|%v|%s|%v", nextConfig, bundle.EnforcementMode, mode, findings)))
		overrideToken = hex.EncodeToString(sum[:])[:16]
	}
	policy := buildDecisionPolicy(hasRisk, bundle.EnforcementMode, overrideToken)
	return RiskScan{OK: true, HasRisk: hasRisk, RequiresManualDecision: hasRisk, Summary: policy.Summary, Findings: findings, DecisionPolicy: policy}
}

func EvaluateRiskDecision(scan RiskScan, decision, overrideToken, overrideReason string, confirm bool) RiskDecision {
	if !scan.HasRisk {
		return RiskDecision{OK: true, FinalAction: defaultString(decision, "allow_apply"), Audit: map[string]any{"decision": defaultString(decision, "allow_apply"), "confirm": confirm, "overrideReason": overrideReason, "overrideTokenUsed": false}}
	}
	if decision == "block_apply" {
		return RiskDecision{OK: false, FinalAction: "block_apply", Message: "已由人工明确选择不生效，本次操作已终止。", Audit: map[string]any{"decision": "block_apply", "confirm": confirm, "overrideReason": overrideReason, "overrideTokenUsed": false}}
	}
	if scan.DecisionPolicy.RequiredAction == "allow_apply" {
		final := "allow_apply"
		if decision == "force_apply" { final = "force_apply" }
		return RiskDecision{OK: true, FinalAction: final, Audit: map[string]any{"decision": defaultString(decision, final), "confirm": confirm, "overrideReason": overrideReason, "overrideTokenUsed": overrideToken != ""}}
	}
	if decision != "force_apply" || !confirm {
		return RiskDecision{OK: false, FinalAction: "needs_confirmation", Message: "命中风险且当前为 block；需人工确认 confirm=true 且 decision=force_apply。", Audit: map[string]any{"decision": defaultString(decision, "needs_confirmation"), "confirm": confirm, "overrideReason": overrideReason, "overrideTokenUsed": false}}
	}
	needed, _ := scan.DecisionPolicy.Confirmation["overrideToken"].(string)
	if overrideToken != needed {
		return RiskDecision{OK: false, FinalAction: "needs_confirmation", Message: "overrideToken 无效或与当前风险扫描结果不匹配。", Audit: map[string]any{"decision": "force_apply", "confirm": true, "overrideReason": overrideReason, "overrideTokenUsed": overrideToken != ""}}
	}
	if overrideReason == "" {
		return RiskDecision{OK: false, FinalAction: "needs_confirmation", Message: "force_apply 时必须填写 overrideReason。", Audit: map[string]any{"decision": "force_apply", "confirm": true, "overrideReason": "", "overrideTokenUsed": true}}
	}
	return RiskDecision{OK: true, FinalAction: "force_apply", Audit: map[string]any{"decision": "force_apply", "confirm": true, "overrideReason": overrideReason, "overrideTokenUsed": true, "overrideToken": overrideToken}}
}

func NormalizeRuleBundle(bundle RuleBundle) RuleBundle {
	def := DefaultRuleBundle()
	if bundle.Version == 0 { bundle.Version = def.Version }
	if bundle.EnforcementMode == "" { bundle.EnforcementMode = def.EnforcementMode }
	if bundle.Rules.LabelNaming.Pattern == "" { bundle.Rules.LabelNaming = def.Rules.LabelNaming }
	if bundle.Rules.MetricNaming.Pattern == "" { bundle.Rules.MetricNaming = def.Rules.MetricNaming }
	if bundle.Rules.SuspiciousChanges.AdditionsThreshold == 0 { bundle.Rules.SuspiciousChanges = def.Rules.SuspiciousChanges }
	if bundle.Rules.MetricsVolume.EstimatedSeriesPerTarget == 0 { bundle.Rules.MetricsVolume = def.Rules.MetricsVolume }
	return bundle
}

func buildDecisionPolicy(hasRisk bool, enforcementMode, overrideToken string) DecisionPolicy {
	if !hasRisk {
		return DecisionPolicy{RequiredAction: "allow_apply", Summary: "未发现明显高风险变更，可直接生效。", Semantics: map[string]string{"warn": "无风险时直接允许。", "block": "无风险时直接允许。"}}
	}
	if enforcementMode == "warn" {
		return DecisionPolicy{RequiredAction: "allow_apply", Summary: "检测到风险候选：当前为 warn，只提醒，默认允许保存/发布；如人工决定不生效，可显式选择 block_apply。", Semantics: map[string]string{"warn": "只提醒，不强制拦截；不需要 overrideToken。", "block": "命中风险时会阻止，除非人工确认 force_apply。"}, Confirmation: map[string]any{"needed": false, "overrideToken": nil, "overrideReasonRequired": false}}
	}
	return DecisionPolicy{RequiredAction: "force_apply", Summary: "检测到风险候选：当前为 block，默认阻止保存/发布；只有人工确认后才能强制生效。", Semantics: map[string]string{"warn": "只提醒，不强制拦截；不需要 overrideToken。", "block": "命中风险后默认阻止；需 decision=force_apply + confirm=true + overrideToken + overrideReason。"}, Confirmation: map[string]any{"needed": true, "confirmField": "confirm", "decisionField": "decision", "overrideToken": overrideToken, "overrideReasonRequired": true}}
}

func makeFinding(ruleType, severity, message, path string) RiskFinding { return RiskFinding{RuleType: ruleType, Severity: severity, Message: message, Path: path} }
func getScrapeConfigs(config map[string]any) []map[string]any {
	items, ok := config["scrape_configs"].([]any)
	if !ok { return nil }
	out := make([]map[string]any, 0, len(items))
	for _, item := range items { out = append(out, mapValue(item)) }
	return out
}
func getStaticConfigs(job map[string]any) []map[string]any {
	items, ok := job["static_configs"].([]any)
	if !ok { return nil }
	out := make([]map[string]any, 0, len(items))
	for _, item := range items { out = append(out, mapValue(item)) }
	return out
}
func mapValue(v any) map[string]any { m, _ := v.(map[string]any); if m == nil { return map[string]any{} }; return m }
func stringValue(v any) string { s, _ := v.(string); return s }
func matchPattern(pattern, value string) bool { re, err := regexp.Compile(pattern); return err == nil && re.MatchString(value) }
func countTargets(config map[string]any) int { total := 0; for _, job := range getScrapeConfigs(config) { for _, group := range getStaticConfigs(job) { if targets, ok := group["targets"].([]any); ok { total += len(targets) } } }; return total }
func countLabels(config map[string]any) int { total := 0; for _, job := range getScrapeConfigs(config) { for _, group := range getStaticConfigs(job) { total += len(mapValue(group["labels"])) } }; return total }
func defaultString(v, fallback string) string { if v == "" { return fallback }; return v }
