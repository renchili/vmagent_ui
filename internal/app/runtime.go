package app

import (
	"fmt"
	"strings"
)

type DeploymentArtifacts struct {
	Docker     map[string]any `json:"docker"`
	Compose    map[string]any `json:"compose"`
	Kubernetes map[string]any `json:"kubernetes"`
	Systemd    map[string]any `json:"systemd"`
}

func NormalizeRuntimeProfile(profile RuntimeProfile) RuntimeProfile {
	if profile.Cluster == nil { profile.Cluster = map[string]any{} }
	if profile.RemoteWrite == nil { profile.RemoteWrite = map[string]any{} }
	if profile.Governance == nil { profile.Governance = map[string]any{} }
	if profile.Deployment == nil { profile.Deployment = map[string]any{} }

	setDefault(profile.Cluster, "enabled", false)
	setDefault(profile.Cluster, "membersCount", 2)
	setDefault(profile.Cluster, "memberNum", 0)
	setDefault(profile.Cluster, "replicationFactor", 1)

	setDefault(profile.RemoteWrite, "shardByURL", false)
	setDefault(profile.RemoteWrite, "tmpDataPath", "/var/lib/vmagent-remotewrite-data")

	if _, ok := profile.Governance["ruleBundle"]; !ok {
		profile.Governance["ruleBundle"] = DefaultRuleBundle()
	}

	setDefault(profile.Deployment, "target", "docker")
	return profile
}

func ValidateRuntimeProfile(profile RuntimeProfile) []map[string]any {
	profile = NormalizeRuntimeProfile(profile)
	errors := []map[string]any{}
	if intValue(profile.Cluster["membersCount"]) <= 0 {
		errors = append(errors, validationError("runtime", "cluster.membersCount", "membersCount 必须大于 0"))
	}
	if intValue(profile.Cluster["memberNum"]) < 0 {
		errors = append(errors, validationError("runtime", "cluster.memberNum", "memberNum 必须大于等于 0"))
	}
	if intValue(profile.Cluster["replicationFactor"]) <= 0 {
		errors = append(errors, validationError("runtime", "cluster.replicationFactor", "replicationFactor 必须大于 0"))
	}
	if strings.TrimSpace(stringValue(profile.RemoteWrite["tmpDataPath"])) == "" {
		errors = append(errors, validationError("runtime", "remoteWrite.tmpDataPath", "tmpDataPath 不能为空"))
	}
	target := stringValue(profile.Deployment["target"])
	if target != "docker" && target != "kubernetes" && target != "systemd" {
		errors = append(errors, validationError("runtime", "deployment.target", "deployment.target 仅支持 docker / kubernetes / systemd"))
	}
	return errors
}

func RenderDeploymentArtifacts(profile RuntimeProfile, configPath string) DeploymentArtifacts {
	profile = NormalizeRuntimeProfile(profile)
	args := buildVmagentFlagArgs(profile, configPath)
	dockerImage := "victoriametrics/vmagent:latest"
	containerName := "vmagent"
	serviceName := "vmagent"
	tmpDataPath := stringValue(profile.RemoteWrite["tmpDataPath"])
	composeYAML := fmt.Sprintf("services:\n  vmagent:\n    image: %s\n    container_name: %s\n    restart: unless-stopped\n    command:\n%s    volumes:\n      - ./config.yml:%s:ro\n      - vmagent-data:%s\nvolumes:\n  vmagent-data: {}\n", dockerImage, containerName, yamlArgs(args), configPath, tmpDataPath)
	systemdUnit := fmt.Sprintf("[Unit]\nDescription=vmagent\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/local/bin/vmagent %s\nRestart=always\nStateDirectory=%s\n\n[Install]\nWantedBy=multi-user.target\n", strings.Join(args, " "), serviceName)
	k8sManifest := fmt.Sprintf("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: vmagent\n  namespace: monitoring\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: vmagent\n  template:\n    metadata:\n      labels:\n        app: vmagent\n    spec:\n      containers:\n        - name: vmagent\n          image: %s\n          args:\n%s", dockerImage, yamlArgs(args))
	return DeploymentArtifacts{
		Docker: map[string]any{"type": "docker", "command": fmt.Sprintf("docker run -d --name %s %s %s", containerName, dockerImage, strings.Join(args, " ")), "args": args},
		Compose: map[string]any{"type": "compose", "yaml": composeYAML, "args": args, "serviceName": containerName},
		Kubernetes: map[string]any{"type": "kubernetes", "manifest": k8sManifest, "args": args},
		Systemd: map[string]any{"type": "systemd", "unit": systemdUnit, "args": args, "execStart": fmt.Sprintf("/usr/local/bin/vmagent %s", strings.Join(args, " ")), "serviceName": serviceName, "paths": map[string]any{"unitFile": fmt.Sprintf("/etc/systemd/system/%s.service", serviceName), "configPath": configPath, "dataPath": tmpDataPath}},
	}
}

func BuildSystemdPlan(profile RuntimeProfile, configPath, targetDir string, enableWrites bool) map[string]any {
	artifacts := RenderDeploymentArtifacts(profile, configPath)
	serviceName := stringValue(artifacts.Systemd["serviceName"])
	if serviceName == "" { serviceName = "vmagent" }
	unitFile := fmt.Sprintf("%s/%s.service", strings.TrimRight(defaultString(targetDir, "/etc/systemd/system"), "/"), serviceName)
	warnings := []string{"默认只生成 plan，不直接执行 systemctl。"}
	if !enableWrites { warnings = append(warnings, "当前是 dry-run；不会写入 unit 文件。") }
	return map[string]any{
		"ok": true,
		"mode": ternary(enableWrites, "controlled-apply", "dry-run"),
		"enableWrites": enableWrites,
		"serviceName": serviceName,
		"unitFile": unitFile,
		"warnings": warnings,
		"steps": []map[string]any{{"type": "write-unit-file", "path": unitFile, "description": "写入 systemd unit 文件"}, {"type": "daemon-reload", "command": "systemctl daemon-reload", "description": "重新加载 systemd unit 定义"}, {"type": "restart-service", "command": fmt.Sprintf("systemctl restart %s", serviceName), "description": "重启 vmagent 服务"}},
		"artifactSummary": map[string]any{"execStart": artifacts.Systemd["execStart"], "configPath": configPath},
	}
}

func buildVmagentFlagArgs(profile RuntimeProfile, configPath string) []string {
	args := []string{fmt.Sprintf("-promscrape.config=%s", configPath)}
	if boolValue(profile.Cluster["enabled"]) {
		args = append(args,
			fmt.Sprintf("-promscrape.cluster.membersCount=%d", intValue(profile.Cluster["membersCount"])),
			fmt.Sprintf("-promscrape.cluster.memberNum=%d", intValue(profile.Cluster["memberNum"])),
			fmt.Sprintf("-promscrape.cluster.replicationFactor=%d", intValue(profile.Cluster["replicationFactor"])),
		)
	}
	if boolValue(profile.RemoteWrite["shardByURL"]) {
		args = append(args, "-remoteWrite.shardByURL")
	}
	if tmp := stringValue(profile.RemoteWrite["tmpDataPath"]); tmp != "" {
		args = append(args, fmt.Sprintf("-remoteWrite.tmpDataPath=%s", tmp))
	}
	return args
}

func yamlArgs(args []string) string {
	out := ""
	for _, arg := range args { out += fmt.Sprintf("      - %q\n", arg) }
	return out
}
func setDefault(m map[string]any, key string, value any) { if _, ok := m[key]; !ok { m[key] = value } }
func validationError(source, path, message string) map[string]any { return map[string]any{"source": source, "path": path, "message": message} }
func intValue(v any) int { switch x := v.(type) { case int: return x; case int64: return int(x); case float64: return int(x); default: return 0 } }
func boolValue(v any) bool { b, _ := v.(bool); return b }
func ternary(cond bool, a, b string) string { if cond { return a }; return b }
