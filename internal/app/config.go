package app

import "os"

type Config struct {
	Host              string
	Port              string
	DSN               string
	StaticDir         string
	DefaultConfigPath string
	DefaultAuthor     string
	ApplyMode         string
	ReloadURL         string
	ReloadSignalPID   string
	RestartCommand    string
	VmagentConfigPath string
}

func LoadConfig() Config {
	return Config{
		Host:              getenv("HOST", "0.0.0.0"),
		Port:              getenv("PORT", "3099"),
		DSN:               getenv("MYSQL_DSN", "root:root@tcp(127.0.0.1:3306)/vmagent_ui?parseTime=true&multiStatements=true"),
		StaticDir:         getenv("STATIC_DIR", "public"),
		DefaultConfigPath: getenv("DEFAULT_CONFIG_PATH", "config/sample-vmagent.yml"),
		DefaultAuthor:     getenv("DEFAULT_AUTHOR", "web-ui"),
		ApplyMode:         getenv("APPLY_MODE", "noop"),
		ReloadURL:         os.Getenv("VMAGENT_RELOAD_URL"),
		ReloadSignalPID:   os.Getenv("VMAGENT_PID"),
		RestartCommand:    os.Getenv("VMAGENT_RESTART_CMD"),
		VmagentConfigPath: getenv("VMAGENT_CONFIG_PATH", "/etc/vmagent/config.yml"),
	}
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
