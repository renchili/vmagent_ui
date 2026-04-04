package app

import "testing"

func TestScanConfigChangeDetectsMetricsVolumeAndGrowth(t *testing.T) {
	bundle := DefaultRuleBundle()
	bundle.Enabled = true
	bundle.EnforcementMode = "block"
	bundle.Rules.MetricsVolume.Enabled = true
	bundle.Rules.MetricsVolume.EstimatedSeriesPerTarget = 1000
	bundle.Rules.MetricsVolume.MaxEstimatedSeries = 500
	bundle.Rules.MetricsVolume.MaxLabelCombinationsPerMetric = 2
	bundle.Rules.MetricsVolume.HighCardinalityLabels = []string{"trace_id"}
	bundle.Rules.MetricsVolume.GrowthTrend.Enabled = true
	bundle.Rules.MetricsVolume.GrowthTrend.MinHistoryPoints = 3
	bundle.Rules.MetricsVolume.GrowthTrend.ConsecutiveGrowthPeriods = 3
	bundle.Rules.MetricsVolume.GrowthTrend.MaxGrowthRatio = 0.2
	bundle.Rules.MetricsVolume.GrowthTrend.ObservedTotalSeriesHistory = []float64{100, 140, 180, 260}
	bundle.Rules.MetricsVolume.ObservedMetrics = []ObservedMetric{{Name: "http_requests_total", LabelCombinations: 5}}

	next := map[string]any{
		"scrape_configs": []any{
			map[string]any{"job_name": "api", "static_configs": []any{map[string]any{"targets": []any{"a:9100"}, "labels": map[string]any{"trace_id": "abc", "env": "prod"}}}},
		},
	}
	scan := ScanConfigChange(map[string]any{}, next, bundle, "advanced")
	if !scan.HasRisk {
		t.Fatalf("expected risk")
	}
	types := map[string]bool{}
	for _, item := range scan.Findings { types[item.RuleType] = true }
	for _, key := range []string{"metricsVolume.totalSeriesBudget", "metricsVolume.singleMetricLabelCardinality", "metricsVolume.highRiskLabel", "metricsVolume.growthTrend"} {
		if !types[key] { t.Fatalf("expected finding %s, got %#v", key, scan.Findings) }
	}
	if scan.DecisionPolicy.RequiredAction != "force_apply" {
		t.Fatalf("expected force_apply policy, got %s", scan.DecisionPolicy.RequiredAction)
	}
}

func TestEvaluateRiskDecision(t *testing.T) {
	scan := RiskScan{HasRisk: true, DecisionPolicy: buildDecisionPolicy(true, "block", "token-123")}
	denied := EvaluateRiskDecision(scan, "force_apply", "wrong", "reason", true)
	if denied.OK {
		t.Fatalf("expected wrong token to fail")
	}
	allowed := EvaluateRiskDecision(scan, "force_apply", "token-123", "approved by operator", true)
	if !allowed.OK || allowed.FinalAction != "force_apply" {
		t.Fatalf("expected force apply success, got %#v", allowed)
	}
}
