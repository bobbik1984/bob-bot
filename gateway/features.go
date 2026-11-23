package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type WidgetSpec struct {
	ID     string `json:"id"`
	Anchor string `json:"anchor"`
	Place  string `json:"place"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	HTML   string `json:"html,omitempty"`
}

type FeaturePackage struct {
	Name        string       `json:"name"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Version     int          `json:"version"`
	Status      string       `json:"status"`
	Trial       bool         `json:"trial"`
	CSS         string       `json:"css,omitempty"`
	PanelHTML   string       `json:"panelHtml,omitempty"`
	Widgets     []WidgetSpec `json:"widgets"`
}

type FeatureTrial struct {
	Name      string          `json:"name"`
	Title     string          `json:"title"`
	ExpiresAt int64           `json:"expiresAt"`
	Previous  *FeaturePackage `json:"previous,omitempty"`
	WasNew    bool            `json:"wasNew"`
}

type FeatureStore struct {
	Items map[string]*FeaturePackage `json:"items"`
}

var (
	featLock     sync.RWMutex
	features     = make(map[string]*FeaturePackage)
	activeTrial  *FeatureTrial
	trialTimer   *time.Timer
	featNameRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{1,32}$`)
	widgetIDRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,20}$`)
	validAnchors = map[string]bool{
		"header-right": true,
		"home":         true,
		"clerk-top":    true,
		"settings-top": true,
	}
)

const trialDuration = 3 * time.Minute

func loadFeatures() {
	b, err := os.ReadFile(filepath.Join("./data", "features.json"))
	if err != nil {
		return
	}
	var st FeatureStore
	if err := json.Unmarshal(b, &st); err != nil {
		return
	}
	featLock.Lock()
	defer featLock.Unlock()
	if st.Items != nil {
		for k, v := range st.Items {
			if v != nil && v.Name != "" {
				v.Trial = false
				if v.Status == "" {
					v.Status = "ok"
				}
				features[k] = v
			}
		}
	}
}

func saveFeaturesLocked() error {
	os.MkdirAll("./data", 0755)
	st := FeatureStore{Items: features}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join("./data", "features.json.tmp")
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join("./data", "features.json"))
}

func clampInt(v, low, high, fallback int) int {
	if v <= 0 {
		v = fallback
	}
	if v < low {
		return low
	}
	if v > high {
		return high
	}
	return v
}

func installFeature(pkg FeaturePackage) (*FeaturePackage, error) {
	pkg.Name = strings.ToLower(strings.TrimSpace(pkg.Name))
	if !featNameRe.MatchString(pkg.Name) {
		return nil, fmt.Errorf("invalid feature name %q (use lowercase letters, digits, hyphens, 2-33 chars)", pkg.Name)
	}
	if strings.TrimSpace(pkg.Title) == "" {
		pkg.Title = pkg.Name
	}
	if len(pkg.Widgets) == 0 && strings.TrimSpace(pkg.CSS) == "" && strings.TrimSpace(pkg.PanelHTML) == "" {
		return nil, fmt.Errorf("feature must include at least one widget, css, or panel_html")
	}
	if len(pkg.Widgets) > 4 {
		return nil, fmt.Errorf("maximum 4 widgets per feature")
	}

	seen := map[string]bool{}
	cleanWidgets := make([]WidgetSpec, 0, len(pkg.Widgets))
	for i, w := range pkg.Widgets {
		id := strings.ToLower(strings.TrimSpace(w.ID))
		if id == "" {
			id = fmt.Sprintf("w%d", i+1)
		}
		if !widgetIDRe.MatchString(id) || seen[id] {
			return nil, fmt.Errorf("invalid or duplicate widget id %q", id)
		}
		seen[id] = true
		anchor := strings.TrimSpace(w.Anchor)
		if !validAnchors[anchor] {
			anchor = "header-right"
		}
		place := strings.TrimSpace(w.Place)
		if place != "start" && place != "end" && place != "before" && place != "after" {
			place = "end"
		}
		if strings.TrimSpace(w.HTML) == "" {
			return nil, fmt.Errorf("widget %q has empty html", id)
		}
		defW, defH := 320, 120
		maxW, maxH := 1200, 600
		if anchor == "header-right" {
			defW, defH = 110, 34
			maxW, maxH = 160, 40
		}
		cleanWidgets = append(cleanWidgets, WidgetSpec{
			ID:     id,
			Anchor: anchor,
			Place:  place,
			Width:  clampInt(w.Width, 20, maxW, defW),
			Height: clampInt(w.Height, 20, maxH, defH),
			HTML:   w.HTML,
		})
	}
	pkg.Widgets = cleanWidgets
	pkg.Status = "ok"

	featLock.Lock()
	if trialTimer != nil {
		trialTimer.Stop()
		trialTimer = nil
	}
	// If another trial was open, commit it first so we don't lose it unexpectedly
	if activeTrial != nil {
		if prevF, ok := features[activeTrial.Name]; ok {
			prevF.Trial = false
		}
		activeTrial = nil
	}

	var prevCopy *FeaturePackage
	wasNew := true
	ver := 1
	if existing, ok := features[pkg.Name]; ok {
		cp := *existing
		prevCopy = &cp
		wasNew = false
		ver = existing.Version + 1
	}
	pkg.Version = ver
	pkg.Trial = true
	saved := pkg
	features[pkg.Name] = &saved

	expires := time.Now().Add(trialDuration)
	activeTrial = &FeatureTrial{
		Name:      pkg.Name,
		Title:     pkg.Title,
		ExpiresAt: expires.UnixMilli(),
		Previous:  prevCopy,
		WasNew:    wasNew,
	}
	nameForTimer := pkg.Name
	trialTimer = time.AfterFunc(trialDuration, func() {
		revertTrial(nameForTimer, "timeout")
	})
	_ = saveFeaturesLocked()
	featLock.Unlock()

	broadcast(map[string]interface{}{"type": "features"})
	return &saved, nil
}

func revertTrial(name, reason string) {
	featLock.Lock()
	if activeTrial == nil || (name != "" && activeTrial.Name != name) {
		featLock.Unlock()
		return
	}
	t := activeTrial
	activeTrial = nil
	if trialTimer != nil {
		trialTimer.Stop()
		trialTimer = nil
	}
	if t.WasNew {
		delete(features, t.Name)
	} else if t.Previous != nil {
		t.Previous.Trial = false
		features[t.Name] = t.Previous
	}
	_ = saveFeaturesLocked()
	featLock.Unlock()

	broadcast(map[string]interface{}{"type": "features"})
	broadcast(map[string]interface{}{"type": "trial_done", "kept": false, "title": t.Title, "reason": reason})
}

func decideTrial(keep bool) {
	if !keep {
		revertTrial("", "rejected")
		return
	}
	featLock.Lock()
	if activeTrial == nil {
		featLock.Unlock()
		return
	}
	t := activeTrial
	activeTrial = nil
	if trialTimer != nil {
		trialTimer.Stop()
		trialTimer = nil
	}
	if f, ok := features[t.Name]; ok {
		f.Trial = false
	}
	_ = saveFeaturesLocked()
	featLock.Unlock()

	broadcast(map[string]interface{}{"type": "features"})
	broadcast(map[string]interface{}{"type": "trial_done", "kept": true, "title": t.Title})
}

func removeFeature(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	featLock.Lock()
	_, ok := features[name]
	if ok {
		delete(features, name)
		if activeTrial != nil && activeTrial.Name == name {
			activeTrial = nil
			if trialTimer != nil {
				trialTimer.Stop()
				trialTimer = nil
			}
		}
		_ = saveFeaturesLocked()
	}
	featLock.Unlock()
	if ok {
		broadcast(map[string]interface{}{"type": "features"})
	}
	return ok
}

func handleGetFeatures(w http.ResponseWriter, r *http.Request) {
	featLock.RLock()
	items := make([]map[string]interface{}, 0, len(features))
	for _, f := range features {
		wMeta := make([]map[string]interface{}, 0, len(f.Widgets))
		for _, wd := range f.Widgets {
			wMeta = append(wMeta, map[string]interface{}{
				"id":     wd.ID,
				"anchor": wd.Anchor,
				"place":  wd.Place,
				"width":  wd.Width,
				"height": wd.Height,
			})
		}
		panel := ""
		if strings.TrimSpace(f.PanelHTML) != "" {
			panel = "panel.html"
		}
		items = append(items, map[string]interface{}{
			"name":        f.Name,
			"title":       f.Title,
			"description": f.Description,
			"version":     f.Version,
			"status":      f.Status,
			"trial":       f.Trial,
			"style":       strings.TrimSpace(f.CSS) != "",
			"panel":       panel,
			"hasPrevious": false,
			"widgets":     wMeta,
		})
	}
	var trialResp interface{} = nil
	if activeTrial != nil {
		rem := activeTrial.ExpiresAt - time.Now().UnixMilli()
		if rem < 0 {
			rem = 0
		}
		trialResp = map[string]interface{}{
			"name":        activeTrial.Name,
			"title":       activeTrial.Title,
			"remainingMs": rem,
		}
	}
	featLock.RUnlock()
	sort.Slice(items, func(i, j int) bool {
		return items[i]["name"].(string) < items[j]["name"].(string)
	})

	jsonResp(w, 200, map[string]interface{}{
		"items": items,
		"trial": trialResp,
	})
}

func handleFeatureTrial(w http.ResponseWriter, r *http.Request) {
	if !authed(r) {
		jsonResp(w, 401, map[string]string{"error": "UNAUTHED"})
		return
	}
	var body struct {
		Keep bool `json:"keep"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}
	decideTrial(body.Keep)
	jsonResp(w, 200, map[string]bool{"ok": true})
}

func handleFeatureRemove(w http.ResponseWriter, r *http.Request) {
	if !authed(r) {
		jsonResp(w, 401, map[string]string{"error": "UNAUTHED"})
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}
	removeFeature(body.Name)
	jsonResp(w, 200, map[string]bool{"ok": true})
}

const bobWidgetBridge = `<style id="bob-theme-base">
:root { color-scheme: light dark; }
html, body {
  margin: 0; padding: 0;
  background: transparent !important;
  color: var(--text, inherit);
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
</style>
<script>
(function(){
  const qsTheme = new URLSearchParams(location.search).get('t');
  if (qsTheme === 'dark' || qsTheme === 'light') {
    document.documentElement.dataset.theme = qsTheme;
    document.documentElement.style.colorScheme = qsTheme;
  }
  const listeners = [];
  window.bob = {
    theme: qsTheme || 'light', lang: 'en', state: null,
    onInit(fn){ listeners.push(fn); },
    save(value){ window.parent.postMessage({ bob: 'save', value }, '*'); },
    resize(width, height){ window.parent.postMessage({ bob: 'resize', width, height }, '*'); },
    toast(text){ window.parent.postMessage({ bob: 'toast', text }, '*'); },
    prefill(text){ window.parent.postMessage({ bob: 'prefill', text }, '*'); }
  };
  window.addEventListener('message', function(e){
    const m = e.data;
    if (!m || m.bob !== 'init') return;
    window.bob.theme = m.theme || 'light';
    window.bob.lang = m.lang || 'en';
    window.bob.state = m.state;
    document.documentElement.dataset.theme = window.bob.theme;
    document.documentElement.style.colorScheme = window.bob.theme;
    if (m.vars) {
      for (const [k, v] of Object.entries(m.vars)) {
        if (v) document.documentElement.style.setProperty(k, v);
      }
    }
    listeners.forEach(fn => { try { fn(m); } catch(_){} });
  });
  function notifyReady(){ window.parent.postMessage({ bob: 'ready' }, '*'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notifyReady);
  else notifyReady();
})();
</script>`

func wrapWidgetHTML(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if !strings.Contains(strings.ToLower(trimmed), "<html") {
		trimmed = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" + trimmed + "</body></html>"
	}
	if !strings.Contains(trimmed, `id="bob-theme-base"`) {
		if idx := strings.Index(strings.ToLower(trimmed), "</head>"); idx != -1 {
			trimmed = trimmed[:idx] + bobWidgetBridge + trimmed[idx:]
		} else {
			trimmed = bobWidgetBridge + trimmed
		}
	}
	return trimmed
}

func handleServeFeatureAsset(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/f/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	name, file := parts[0], parts[1]

	featLock.RLock()
	f, ok := features[name]
	featLock.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	if file == "style.css" {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Write([]byte(f.CSS))
		return
	}
	if file == "panel.html" && strings.TrimSpace(f.PanelHTML) != "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(wrapWidgetHTML(f.PanelHTML)))
		return
	}
	if strings.HasPrefix(file, "widget-") && strings.HasSuffix(file, ".html") {
		wid := strings.TrimSuffix(strings.TrimPrefix(file, "widget-"), ".html")
		for _, wd := range f.Widgets {
			if wd.ID == wid {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				html := wd.HTML
				// Upgrade only the original Shanghai-only badge. Owner-edited widgets keep their own HTML.
				if wid == "weather-badge-widget" && fmt.Sprintf("%x", sha256.Sum256([]byte(html))) == "3777d54d7011a53081132effb9fd1f4cc4d911fbe3ff9ac7b0b2aec166a48574" {
					if builtIn, err := embeddedPublic.ReadFile("public/weather-badge.html"); err == nil {
						html = string(builtIn)
					}
				}
				w.Write([]byte(wrapWidgetHTML(html)))
				return
			}
		}
	}
	http.NotFound(w, r)
}

func bobSystemPrompt() string {
	cfgLock.RLock()
	tz := cfg.Timezone
	cfgLock.RUnlock()
	return fmt.Sprintf(`You are Bob, a self-extending personal AI assistant running on the user's own server (current user timezone: %s).
You HAVE the built-in ability to modify and extend your own web interface by installing, updating, or removing UI plugins/widgets using your tools:
- install_feature: Install or update a feature package containing one or more live sandboxed HTML/CSS/JS widgets mounted directly into the app UI.
- remove_feature: Remove an installed feature by name.
- list_features: List currently installed features.

When the user asks you to add a UI plugin, badge, widget, clock, weather indicator, quick-action bar, or theme tweak:
1. DO NOT say you cannot modify the interface. Actively build and install it using install_feature!
2. Choose the right anchor slot:
   - "header-right": compact badge in the top-right header bar (width 60-150, height 28-36, e.g. weather badge, live clock, status pill).
   - "home": card/widget on the main home view (width 280-600, height 80-260).
   - "clerk-top" or "settings-top": top of Clerk or Settings view.
3. MANDATORY Global Theme & Styling Contract (applies to EVERY widget/plugin automatically):
   - NEVER hardcode light/dark background, border, or text colors (NO #fff, #000, #111, white, black, rgb(...) on surfaces or text).
   - ALWAYS keep html and body background: transparent with overflow: hidden.
   - ALWAYS style cards, pills, borders, and text exclusively with the host's live CSS variables so every widget seamlessly adapts when the user switches Light/Dark themes:
     var(--bg), var(--surface), var(--surface-2), var(--surface-3), var(--text), var(--muted), var(--line), var(--accent), var(--accent-text), var(--accent-soft), var(--ok), var(--warn), var(--danger).
   - Keep header-right widgets compact, single-line, centered vertically (display:flex; align-items:center; justify-content:center; height:100%%).
   - Widgets run in a sandboxed iframe with allow-scripts and can fetch public CORS-friendly APIs directly (for weather, prefer Open-Meteo geocoding + forecast API https://api.open-meteo.com/v1/forecast or https://wttr.in/<city>?format=j1 with graceful fallback).
   - Newly installed features automatically enter a 3-minute trial with Keep/Undo buttons in the top-right corner; mention this briefly so the user knows they can click Keep to make it permanent.`, tz)
}

func executeBobTool(toolName string, args map[string]interface{}, cid string) string {
	log.Printf("Executing Bob tool: %s (cid=%s)", toolName, cid)
	broadcast(map[string]interface{}{"type": "step", "name": toolName, "cid": cid})

	switch toolName {
	case "list_features":
		featLock.RLock()
		names := make([]map[string]interface{}, 0, len(features))
		for _, f := range features {
			names = append(names, map[string]interface{}{
				"name":        f.Name,
				"title":       f.Title,
				"description": f.Description,
				"trial":       f.Trial,
				"widgets":     len(f.Widgets),
			})
		}
		featLock.RUnlock()
		b, _ := json.Marshal(map[string]interface{}{"ok": true, "features": names})
		return string(b)

	case "remove_feature":
		name, _ := args["name"].(string)
		ok := removeFeature(name)
		b, _ := json.Marshal(map[string]interface{}{"ok": ok, "removed": name})
		return string(b)

	case "install_feature":
		raw, _ := json.Marshal(args)
		var req struct {
			Name        string       `json:"name"`
			Title       string       `json:"title"`
			Description string       `json:"description"`
			CSS         string       `json:"css"`
			PanelHTML   string       `json:"panel_html"`
			Widgets     []WidgetSpec `json:"widgets"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			b, _ := json.Marshal(map[string]interface{}{"ok": false, "error": err.Error()})
			return string(b)
		}
		saved, err := installFeature(FeaturePackage{
			Name:        req.Name,
			Title:       req.Title,
			Description: req.Description,
			CSS:         req.CSS,
			PanelHTML:   req.PanelHTML,
			Widgets:     req.Widgets,
		})
		if err != nil {
			b, _ := json.Marshal(map[string]interface{}{"ok": false, "error": err.Error()})
			return string(b)
		}
		b, _ := json.Marshal(map[string]interface{}{
			"ok":      true,
			"name":    saved.Name,
			"title":   saved.Title,
			"version": saved.Version,
			"trial":   true,
			"message": "Feature installed in 3-minute trial mode and mounted live on the page. Ask the user to click Keep in the top-right bar to save it permanently.",
		})
		return string(b)

	default:
		b, _ := json.Marshal(map[string]interface{}{"ok": false, "error": "unknown tool: " + toolName})
		return string(b)
	}
}
