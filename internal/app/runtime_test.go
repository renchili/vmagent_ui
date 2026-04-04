package app

import "testing"

func TestNormalizeAndValidateRuntimeProfile(t *testing.T) {
	profile := NormalizeRuntimeProfile(RuntimeProfile{})
	if profile.Deployment["target"] != "docker" {
		t.Fatalf("expected default deployment target docker")
	}
	if len(ValidateRuntimeProfile(profile)) != 0 {
		t.Fatalf("expected normalized default profile valid")
	}
	bad := NormalizeRuntimeProfile(RuntimeProfile{Cluster: map[string]any{"membersCount": 0}, RemoteWrite: map[string]any{"tmpDataPath": ""}, Deployment: map[string]any{"target": "bad"}})
	if len(ValidateRuntimeProfile(bad)) < 2 {
		t.Fatalf("expected validation errors, got %#v", ValidateRuntimeProfile(bad))
	}
}

func TestRenderDeploymentArtifacts(t *testing.T) {
	profile := NormalizeRuntimeProfile(RuntimeProfile{Cluster: map[string]any{"enabled": true, "membersCount": 3, "memberNum": 1, "replicationFactor": 1}, RemoteWrite: map[string]any{"shardByURL": true, "tmpDataPath": "/data"}})
	artifacts := RenderDeploymentArtifacts(profile, "/etc/vmagent/config.yml")
	if artifacts.Compose["yaml"] == "" || artifacts.Systemd["unit"] == "" || artifacts.Docker["command"] == "" {
		t.Fatalf("expected rendered artifacts, got %#v", artifacts)
	}
}
