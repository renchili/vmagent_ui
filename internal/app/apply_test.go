package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestApplyConfigPrefersReloadURL(t *testing.T) {
	called := false
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()
	s := &Server{cfg: Config{ReloadURL: ts.URL, RestartCommand: "echo should-not-run", ApplyMode: "noop"}}
	result := s.applyConfig()
	if !called || result["method"] != "http-reload" || result["ok"] != true {
		t.Fatalf("unexpected apply result: %#v", result)
	}
}
