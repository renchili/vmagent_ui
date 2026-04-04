package main

import (
	"log"

	"github.com/renchili/vmagent_ui/internal/app"
)

func main() {
	cfg := app.LoadConfig()
	server, err := app.NewServer(cfg)
	if err != nil {
		log.Fatalf("init server: %v", err)
	}
	if err := server.Run(); err != nil {
		log.Fatalf("run server: %v", err)
	}
}
