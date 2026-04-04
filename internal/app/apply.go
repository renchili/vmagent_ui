package app

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

func (s *Server) applyConfig() map[string]any {
	if s.cfg.ReloadURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.ReloadURL, bytes.NewBuffer(nil))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return map[string]any{"method": "http-reload", "ok": false, "error": err.Error(), "url": s.cfg.ReloadURL}
		}
		defer resp.Body.Close()
		return map[string]any{"method": "http-reload", "ok": resp.StatusCode >= 200 && resp.StatusCode < 300, "status": resp.StatusCode, "url": s.cfg.ReloadURL}
	}
	if s.cfg.ReloadSignalPID != "" {
		pid, err := strconv.Atoi(s.cfg.ReloadSignalPID)
		if err != nil {
			return map[string]any{"method": "sighup", "ok": false, "error": fmt.Sprintf("invalid pid: %v", err)}
		}
		if err := syscall.Kill(pid, syscall.SIGHUP); err != nil {
			return map[string]any{"method": "sighup", "ok": false, "pid": pid, "error": err.Error()}
		}
		return map[string]any{"method": "sighup", "ok": true, "pid": pid}
	}
	if s.cfg.RestartCommand != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "/bin/sh", "-lc", s.cfg.RestartCommand)
		output, err := cmd.CombinedOutput()
		if err != nil {
			return map[string]any{"method": "restart", "ok": false, "command": s.cfg.RestartCommand, "output": string(output), "error": err.Error()}
		}
		return map[string]any{"method": "restart", "ok": true, "command": s.cfg.RestartCommand, "output": string(output)}
	}
	return map[string]any{"method": defaultString(s.cfg.ApplyMode, "noop"), "ok": true, "message": "No reload/restart configured. Config written only."}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
