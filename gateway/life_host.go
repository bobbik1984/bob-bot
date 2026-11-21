package main

import (
	"bobbot/life"
	"log"
	"net/http"
	"path/filepath"
)

func serveAssistant(w http.ResponseWriter, r *http.Request) {
	b, err := embeddedPublic.ReadFile("public/index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(b)
}

func activeVision() life.VisionConfig {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return life.VisionConfig{Provider: cfg.ActiveProvider, Model: cfg.ActiveModel, BaseURL: cfg.ActiveBaseURL, APIKey: cfg.ActiveAPIKey, RemainingUSD: cfg.BudgetCapUsd - cfg.BudgetSpentUsd}
}

func lifeSessionSecret() string {
	key, err := life.SessionSecret(filepath.Join("data", "life"))
	if err != nil {
		log.Fatalf("session key: %v", err)
	}
	return key
}
