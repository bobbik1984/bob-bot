package life

import (
	"math"
	"net/url"
)

// The admission ledger reserves one cent for an extraction. Replace the reserve
// when the billed amount is known or the previously supported tariff applies.
const visionProvisionUSD = .01

type visionUsage struct {
	Cost   *float64
	Input  int `json:"prompt_tokens"`
	Output int `json:"completion_tokens"`
}

func (u visionUsage) amount(cfg VisionConfig, endpoint *url.URL) (float64, bool) {
	if cfg.Provider == "openrouter" && u.Cost != nil && *u.Cost >= 0 {
		return *u.Cost, true
	}
	// This legacy tariff is used only for billing, never for model selection.
	if cfg.Provider == "openai" && endpoint.Host == "api.openai.com" && cfg.Model == "gpt-4o-mini" && u.Input > 0 && u.Output >= 0 {
		return (float64(u.Input)*.15 + float64(u.Output)*.60) / 1e6, true
	}
	return 0, false
}

func (a *App) settleVision(month string, amount float64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state.Month != month {
		return nil
	}
	next := a.copy()
	next.VisionUSD = math.Max(0, next.VisionUSD-visionProvisionUSD+amount)
	return a.save(next)
}
