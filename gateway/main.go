package main

import (
	"bobbot/life"
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"
)

//go:embed public/*
var embeddedPublic embed.FS

type ProviderEntry struct {
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	APIKey  string `json:"apiKey"`
}

type ProactiveConfig struct {
	Enabled bool     `json:"enabled"`
	Level   float64  `json:"level"`
	Times   []string `json:"times"`
}

type CityLocation struct {
	ID        int64   `json:"id,omitempty"`
	Language  string  `json:"language,omitempty"`
	Name      string  `json:"name"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Timezone  string  `json:"timezone"`
}

type Config struct {
	Location       *CityLocation            `json:"location,omitempty"`
	Port           string                   `json:"port"`
	PIN            string                   `json:"pin"`
	CookieSecret   string                   `json:"cookieSecret"`
	ActiveProvider string                   `json:"activeProvider"`
	ActiveModel    string                   `json:"activeModel"`
	ActiveBaseURL  string                   `json:"activeBaseUrl"`
	ActiveAPIKey   string                   `json:"activeApiKey"`
	Providers      map[string]ProviderEntry `json:"providers"`
	Lang           string                   `json:"lang"`
	Theme          string                   `json:"theme"`
	Timezone       string                   `json:"timezone"`
	TimezoneChosen bool                     `json:"timezoneChosen"`
	BudgetCapUsd   float64                  `json:"budgetCapUsd"`
	BudgetSpentUsd float64                  `json:"budgetSpentUsd"`
	Proactive      ProactiveConfig          `json:"proactive"`
}

type Message struct {
	Role string `json:"role"`
	Text string `json:"text"`
	Time int64  `json:"time,omitempty"`
}

type Event struct {
	At     int64       `json:"at,omitempty"`
	Type   string      `json:"type"`
	Role   string      `json:"role,omitempty"`
	Text   string      `json:"text,omitempty"`
	CID    string      `json:"cid,omitempty"`
	Status string      `json:"status,omitempty"`
	Budget interface{} `json:"budget,omitempty"`
	Data   interface{} `json:"data,omitempty"`
}

type Conversation struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt int64     `json:"created_at"`
	Events    []Event   `json:"events"`
	History   []Message `json:"history"`
}

var (
	cfgLock       sync.RWMutex
	cfg           Config
	convsLock     sync.RWMutex
	conversations = make(map[string]*Conversation)
	runningCID    string
	sseClients    = make(map[chan []byte]bool)
	sseLock       sync.Mutex
)

func main() {
	cfg = loadConfig()
	loadConversations()
	loadFeatures()

	log.Printf("Starting Bob-Bot (Go Native Gateway) on port :%s", cfg.Port)
	log.Printf("Active Provider: %s | Model: %s", cfg.ActiveProvider, cfg.ActiveModel)
	if cfg.ActiveAPIKey == "" {
		log.Println("WARNING: Active API Key is not set. Chat will prompt for key in Settings.")
	} else {
		log.Printf("Active API Key configured (hint: %s)", maskKey(cfg.ActiveAPIKey))
	}

	mux := http.NewServeMux()
	app, err := life.Open(filepath.Join("data", "life"))
	if err != nil {
		log.Fatal("life storage: ", err)
	}
	life.MountPWA(mux)
	app.Mount(mux, life.Host{Authorized: authed, Assistant: serveAssistant, VisionConfig: activeVision})
	go app.Run(context.Background())

	// Static routes
	subFS, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		log.Fatalf("Failed to sub embed FS: %v", err)
	}

	mux.Handle("GET /", http.FileServer(http.FS(subFS)))

	// API routes
	mux.HandleFunc("GET /api/state", handleState)
	mux.HandleFunc("GET /api/version", handleVersion)
	mux.HandleFunc("POST /api/login", handleLogin)
	mux.HandleFunc("POST /api/logout", handleLogout)
	owner := func(handler http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !authed(r) {
				http.Error(w, "auth", http.StatusUnauthorized)
				return
			}
			handler(w, r)
		}
	}
	mux.HandleFunc("GET /api/events", owner(handleEvents))

	mux.HandleFunc("GET /api/conversations", owner(handleListConversations))
	mux.HandleFunc("POST /api/conversations", owner(handleCreateConversation))
	mux.HandleFunc("GET /api/conversations/", owner(handleGetConversation))
	mux.HandleFunc("POST /api/conversations/delete", owner(handleDeleteConversation))
	mux.HandleFunc("POST /api/conversations/rename", owner(handleRenameConversation))

	mux.HandleFunc("POST /api/chat", owner(handleChat))
	mux.HandleFunc("POST /api/model", owner(handleSaveModel))
	mux.HandleFunc("POST /api/key", owner(handleSaveKey))
	mux.HandleFunc("POST /api/budget", owner(handleSaveBudget))
	mux.HandleFunc("POST /api/prefs", owner(handleSavePrefs))
	mux.HandleFunc("GET /api/clerk", owner(handleGetClerk))
	mux.HandleFunc("POST /api/clerk/timezone", handleSaveTimezone)
	mux.HandleFunc("GET /api/proactive", handleGetProactive)
	mux.HandleFunc("POST /api/proactive", handleSaveProactive)
	mux.HandleFunc("GET /api/features", handleGetFeatures)
	mux.HandleFunc("POST /api/features/trial", handleFeatureTrial)
	mux.HandleFunc("POST /api/features/remove", handleFeatureRemove)
	mux.HandleFunc("GET /f/", handleServeFeatureAsset)

	// Stub endpoints to satisfy remaining UI tabs
	mux.HandleFunc("GET /api/extensions", func(w http.ResponseWriter, r *http.Request) {
		jsonResp(w, 200, map[string]interface{}{"mcp": []string{}, "skills": []string{}})
	})
	mux.HandleFunc("GET /api/memory", func(w http.ResponseWriter, r *http.Request) {
		jsonResp(w, 200, map[string]interface{}{"items": []string{}, "insights": []string{}})
	})
	mux.HandleFunc("GET /api/wechat/status", func(w http.ResponseWriter, r *http.Request) {
		jsonResp(w, 200, map[string]interface{}{"running": false})
	})
	mux.HandleFunc("GET /api/push/log", func(w http.ResponseWriter, r *http.Request) {
		jsonResp(w, 200, map[string]interface{}{"items": []string{}})
	})
	mux.HandleFunc("GET /api/models", func(w http.ResponseWriter, r *http.Request) {
		jsonResp(w, 200, map[string]interface{}{"deepseek": []string{}, "current": cfg.ActiveModel})
	})

	// WeChat bridge compatibility endpoints
	mux.HandleFunc("POST /v1/chat", handleV1Chat)
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		jsonResp(w, 200, map[string]string{"status": "ok", "model": cfg.ActiveModel})
	})

	server := &http.Server{
		Addr:         net.JoinHostPort(os.Getenv("BOBBOT_LISTEN_HOST"), cfg.Port),
		Handler:      mux,
		ReadTimeout:  120 * time.Second,
		WriteTimeout: 120 * time.Second,
	}

	log.Fatal(server.ListenAndServe())
}

func maskKey(k string) string {
	if k == "" {
		return ""
	}
	if len(k) <= 8 {
		return "****"
	}
	return k[:4] + "..." + k[len(k)-4:]
}

func loadConfig() Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	pin := os.Getenv("BOBBOT_PIN")
	if pin == "" {
		log.Fatal("Owner PIN is required")
	}
	secret := os.Getenv("BOBBOT_SECRET")
	if secret == "" {
		secret = lifeSessionSecret()
	}

	dataDir := "./data"
	os.MkdirAll(dataDir, 0755)
	cfgPath := filepath.Join(dataDir, "config.json")

	c := Config{
		Port:           port,
		PIN:            pin,
		CookieSecret:   secret,
		ActiveProvider: "gemini",
		ActiveModel:    "gemini-4-neon",
		ActiveBaseURL:  "https://generativelanguage.googleapis.com/v1beta",
		Providers: map[string]ProviderEntry{
			"gemini": {
				BaseURL: "https://generativelanguage.googleapis.com/v1beta",
				Model:   "gemini-4-neon",
			},
			"openai": {
				BaseURL: "https://api.openai.com/v1",
				Model:   "gpt-6.2-sol",
			},
			"openrouter": {
				BaseURL: "https://openrouter.ai/api/v1",
				Model:   "google/gemini-4-neon",
			},
			"xai": {
				BaseURL: "https://api.x.ai/v1",
				Model:   "grok-4.7",
			},
			"deepseek": {
				BaseURL: "https://api.deepseek.com/v1",
				Model:   "deepseek-flash",
			},
			"moonshot": {
				BaseURL: "https://api.moonshot.cn/v1",
				Model:   "kimi-k3.1-pro",
			},
			"qwen": {
				BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				Model:   "qwen4-max",
			},
			"zhipu": {
				BaseURL: "https://open.bigmodel.cn/api/paas/v4",
				Model:   "glm-5.3-flash",
			},
			"doubao": {
				BaseURL: "https://ark.cn-beijing.volces.com/api/v3",
				Model:   "doubao-seed-2-1-turbo-260813",
			},
			"custom": {
				BaseURL: "",
				Model:   "",
			},
		},
		Lang:           "auto",
		Theme:          "auto",
		Timezone:       "Asia/Shanghai",
		TimezoneChosen: false,
		BudgetCapUsd:   100.0,
		BudgetSpentUsd: 0.0,
		Proactive: ProactiveConfig{
			Enabled: false,
			Level:   0.35,
			Times:   []string{"09:00", "20:00"},
		},
	}

	// Try reading persisted config.json
	if fbytes, err := os.ReadFile(cfgPath); err == nil {
		var diskCfg Config
		if err := json.Unmarshal(fbytes, &diskCfg); err == nil {
			if diskCfg.ActiveProvider != "" {
				c.ActiveProvider = diskCfg.ActiveProvider
			}
			if diskCfg.ActiveModel != "" {
				c.ActiveModel = diskCfg.ActiveModel
			}
			if diskCfg.ActiveBaseURL != "" {
				c.ActiveBaseURL = diskCfg.ActiveBaseURL
			}
			if diskCfg.ActiveAPIKey != "" {
				c.ActiveAPIKey = diskCfg.ActiveAPIKey
			}
			if diskCfg.Providers != nil {
				for k, v := range diskCfg.Providers {
					c.Providers[k] = v
				}
			}
			if diskCfg.Lang != "" {
				c.Lang = diskCfg.Lang
			}
			if diskCfg.Theme != "" {
				c.Theme = diskCfg.Theme
			}
			if diskCfg.Timezone != "" {
				c.Timezone = diskCfg.Timezone
			}
			c.TimezoneChosen = diskCfg.TimezoneChosen
			c.Location = diskCfg.Location
			if diskCfg.BudgetCapUsd > 0 {
				c.BudgetCapUsd = diskCfg.BudgetCapUsd
			}
			if diskCfg.BudgetSpentUsd > 0 {
				c.BudgetSpentUsd = diskCfg.BudgetSpentUsd
			}
			if diskCfg.Proactive.Level > 0 || len(diskCfg.Proactive.Times) > 0 || diskCfg.Proactive.Enabled {
				c.Proactive = diskCfg.Proactive
				if c.Proactive.Times == nil {
					c.Proactive.Times = []string{}
				}
			}
		}
	}

	// Environment variable overrides
	gemKey := os.Getenv("GEMINI_API_KEY")
	if gemKey == "" {
		gemKey = os.Getenv("GOOGLE_API_KEY")
	}
	if gemKey == "" {
		if kbytes, err := os.ReadFile(filepath.Join(dataDir, "gemini_key.txt")); err == nil {
			gemKey = strings.TrimSpace(string(kbytes))
		}
	}
	if gemKey != "" {
		g := c.Providers["gemini"]
		if g.APIKey == "" {
			g.APIKey = gemKey
			c.Providers["gemini"] = g
		}
		if c.ActiveProvider == "gemini" && c.ActiveAPIKey == "" {
			c.ActiveAPIKey = gemKey
		}
	}

	// Ensure ActiveAPIKey is filled from provider map if blank
	if p, ok := c.Providers[c.ActiveProvider]; ok && p.APIKey != "" && c.ActiveAPIKey == "" {
		c.ActiveAPIKey = p.APIKey
	}

	return c
}

func saveConfig() error {
	dataDir := "./data"
	os.MkdirAll(dataDir, 0755)
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dataDir, "config.json.tmp")
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dataDir, "config.json"))
}

func loadConversations() {
	b, err := os.ReadFile(filepath.Join("./data", "conversations.json"))
	if err != nil {
		return
	}
	var list []*Conversation
	if err := json.Unmarshal(b, &list); err != nil {
		return
	}
	convsLock.Lock()
	defer convsLock.Unlock()
	for _, c := range list {
		if c != nil && c.ID != "" {
			if c.Events == nil {
				c.Events = make([]Event, 0)
			}
			if c.History == nil {
				c.History = make([]Message, 0)
			}
			conversations[c.ID] = c
		}
	}
}

var conversationSave sync.Mutex

func saveConversations() {
	conversationSave.Lock()
	defer conversationSave.Unlock()
	convsLock.RLock()
	list := make([]*Conversation, 0, len(conversations))
	for _, c := range conversations {
		list = append(list, c)
	}
	b, err := json.MarshalIndent(list, "", "  ")
	convsLock.RUnlock()

	os.MkdirAll("./data", 0755)
	if err != nil {
		log.Printf("Failed to marshal conversations: %v", err)
		return
	}
	tmp := filepath.Join("./data", "conversations.json.tmp")
	if err := os.WriteFile(tmp, b, 0600); err == nil {
		os.Rename(tmp, filepath.Join("./data", "conversations.json"))
	}
}

var cityToIANA = map[string]string{
	// China & East Asia
	"北京": "Asia/Shanghai", "beijing": "Asia/Shanghai", "peking": "Asia/Shanghai",
	"上海": "Asia/Shanghai", "shanghai": "Asia/Shanghai",
	"深圳": "Asia/Shanghai", "shenzhen": "Asia/Shanghai",
	"广州": "Asia/Shanghai", "guangzhou": "Asia/Shanghai",
	"杭州": "Asia/Shanghai", "hangzhou": "Asia/Shanghai",
	"成都": "Asia/Shanghai", "chengdu": "Asia/Shanghai",
	"重庆": "Asia/Shanghai", "chongqing": "Asia/Shanghai",
	"南京": "Asia/Shanghai", "nanjing": "Asia/Shanghai",
	"武汉": "Asia/Shanghai", "wuhan": "Asia/Shanghai",
	"西安": "Asia/Shanghai", "xian": "Asia/Shanghai", "xi'an": "Asia/Shanghai",
	"天津": "Asia/Shanghai", "tianjin": "Asia/Shanghai",
	"苏州": "Asia/Shanghai", "suzhou": "Asia/Shanghai",
	"中国": "Asia/Shanghai", "china": "Asia/Shanghai", "cst": "Asia/Shanghai",
	"香港": "Asia/Hong_Kong", "hong kong": "Asia/Hong_Kong", "hongkong": "Asia/Hong_Kong", "hk": "Asia/Hong_Kong",
	"澳门": "Asia/Macau", "macau": "Asia/Macau", "macao": "Asia/Macau",
	"台北": "Asia/Taipei", "taipei": "Asia/Taipei", "台湾": "Asia/Taipei", "taiwan": "Asia/Taipei",
	"新加坡": "Asia/Singapore", "singapore": "Asia/Singapore", "sg": "Asia/Singapore",
	"东京": "Asia/Tokyo", "tokyo": "Asia/Tokyo", "大阪": "Asia/Tokyo", "osaka": "Asia/Tokyo", "日本": "Asia/Tokyo", "japan": "Asia/Tokyo",
	"首尔": "Asia/Seoul", "seoul": "Asia/Seoul", "韩国": "Asia/Seoul", "korea": "Asia/Seoul",
	"曼谷": "Asia/Bangkok", "bangkok": "Asia/Bangkok",
	"吉隆坡": "Asia/Kuala_Lumpur", "kuala lumpur": "Asia/Kuala_Lumpur",
	"迪拜": "Asia/Dubai", "dubai": "Asia/Dubai",
	"悉尼": "Australia/Sydney", "sydney": "Australia/Sydney",
	"墨尔本": "Australia/Melbourne", "melbourne": "Australia/Melbourne",
	"奥克兰": "Pacific/Auckland", "auckland": "Pacific/Auckland",
	// Europe
	"伦敦": "Europe/London", "london": "Europe/London", "uk": "Europe/London",
	"巴黎": "Europe/Paris", "paris": "Europe/Paris",
	"柏林": "Europe/Berlin", "berlin": "Europe/Berlin",
	"法兰克福": "Europe/Berlin", "frankfurt": "Europe/Berlin",
	"阿姆斯特丹": "Europe/Amsterdam", "amsterdam": "Europe/Amsterdam",
	"苏黎世": "Europe/Zurich", "zurich": "Europe/Zurich",
	"莫斯科": "Europe/Moscow", "moscow": "Europe/Moscow",
	// Americas
	"纽约": "America/New_York", "new york": "America/New_York", "nyc": "America/New_York",
	"波士顿": "America/New_York", "boston": "America/New_York",
	"华盛顿": "America/New_York", "washington": "America/New_York",
	"迈阿密": "America/New_York", "miami": "America/New_York",
	"多伦多": "America/Toronto", "toronto": "America/Toronto",
	"芝加哥": "America/Chicago", "chicago": "America/Chicago",
	"达拉斯": "America/Chicago", "dallas": "America/Chicago",
	"休斯顿": "America/Chicago", "houston": "America/Chicago",
	"丹佛": "America/Denver", "denver": "America/Denver",
	"洛杉矶": "America/Los_Angeles", "los angeles": "America/Los_Angeles", "la": "America/Los_Angeles",
	"旧金山": "America/Los_Angeles", "san francisco": "America/Los_Angeles", "sf": "America/Los_Angeles", "硅谷": "America/Los_Angeles",
	"西雅图": "America/Los_Angeles", "seattle": "America/Los_Angeles",
	"温哥华": "America/Vancouver", "vancouver": "America/Vancouver",
	"utc": "UTC", "gmt": "UTC",
}

func resolveTimezone(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("EMPTY_TIMEZONE")
	}
	// Strip parenthetical hints like "北京 (Asia/Shanghai)"
	if idx := strings.Index(s, "("); idx != -1 {
		if end := strings.Index(s[idx:], ")"); end != -1 {
			inside := strings.TrimSpace(s[idx+1 : idx+end])
			if _, err := time.LoadLocation(inside); err == nil {
				return inside, nil
			}
		}
		s = strings.TrimSpace(s[:idx])
	}
	if mapped, ok := cityToIANA[strings.ToLower(s)]; ok {
		return mapped, nil
	}
	if _, err := time.LoadLocation(s); err == nil {
		return s, nil
	}
	return "", fmt.Errorf("UNKNOWN_TIMEZONE")
}

func authed(r *http.Request) bool {
	cookie, err := r.Cookie("bobbot_session")
	if err != nil || cookie.Value == "" {
		return false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return false
	}
	exp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || exp < time.Now().Unix() {
		return false
	}
	expected := signSession(parts[0], cfg.CookieSecret)
	return hmac.Equal([]byte(parts[1]), []byte(expected))
}

func signSession(exp, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(exp + "." + cfg.PIN))
	return hex.EncodeToString(mac.Sum(nil))
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PIN string `json:"pin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "INVALID_JSON"})
		return
	}
	if body.PIN != cfg.PIN {
		jsonResp(w, 401, map[string]string{"error": "WRONG_PIN"})
		return
	}

	exp := time.Now().Add(30 * 24 * time.Hour).Unix()
	expStr := strconv.FormatInt(exp, 10)
	sig := signSession(expStr, cfg.CookieSecret)
	val := expStr + "." + sig

	http.SetCookie(w, &http.Cookie{
		Name:     "bobbot_session",
		Value:    val,
		Path:     "/",
		Expires:  time.Unix(exp, 0),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	jsonResp(w, 200, map[string]bool{"ok": true})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     "bobbot_session",
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
	})
	jsonResp(w, 200, map[string]bool{"ok": true})
}

func handleState(w http.ResponseWriter, r *http.Request) {
	isAuthed := authed(r)
	resp := map[string]interface{}{
		"authed": isAuthed,
		"pinSet": true,
	}
	if isAuthed {
		cfgLock.RLock()
		savedProviders := make(map[string]interface{})
		for pName, pEntry := range cfg.Providers {
			savedProviders[pName] = map[string]interface{}{
				"hasKey":  pEntry.APIKey != "",
				"keyHint": maskKey(pEntry.APIKey),
				"model":   pEntry.Model,
				"baseUrl": pEntry.BaseURL,
			}
		}
		resp["provider"] = cfg.ActiveProvider
		resp["model"] = cfg.ActiveModel
		resp["baseUrl"] = cfg.ActiveBaseURL
		resp["hasKey"] = cfg.ActiveAPIKey != ""
		resp["keyHint"] = maskKey(cfg.ActiveAPIKey)
		resp["savedProviders"] = savedProviders
		resp["lang"] = cfg.Lang
		resp["theme"] = cfg.Theme
		resp["timezone"] = cfg.Timezone
		resp["location"] = cfg.Location
		resp["timezoneChosen"] = cfg.TimezoneChosen
		resp["budget"] = map[string]interface{}{
			"spentUsd": cfg.BudgetSpentUsd,
			"capUsd":   cfg.BudgetCapUsd,
			"exceeded": cfg.BudgetCapUsd > 0 && cfg.BudgetSpentUsd >= cfg.BudgetCapUsd,
		}
		resp["unread"] = 0
		resp["build"] = map[string]string{"version": "0.4.0-go", "commit": "go-unify", "at": "2026-11-19"}
		cfgLock.RUnlock()
	}
	jsonResp(w, 200, resp)
}

func handleVersion(w http.ResponseWriter, r *http.Request) {
	jsonResp(w, 200, map[string]string{
		"name":     "bobbot",
		"version":  "0.3.0-go",
		"engine":   "Multi-Provider Go Native Gateway",
		"provider": cfg.ActiveProvider,
		"model":    cfg.ActiveModel,
	})
}

func handleEvents(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", 500)
		return
	}

	msgChan := make(chan []byte, 64)
	sseLock.Lock()
	sseClients[msgChan] = true
	sseLock.Unlock()

	defer func() {
		sseLock.Lock()
		delete(sseClients, msgChan)
		close(msgChan)
		sseLock.Unlock()
	}()

	cfgLock.RLock()
	initBudget := map[string]interface{}{"spentUsd": cfg.BudgetSpentUsd, "capUsd": cfg.BudgetCapUsd, "exceeded": cfg.BudgetCapUsd > 0 && cfg.BudgetSpentUsd >= cfg.BudgetCapUsd}
	cfgLock.RUnlock()
	convsLock.RLock()
	active := runningCID
	convsLock.RUnlock()
	initData, _ := json.Marshal(map[string]interface{}{
		"type":    "hello",
		"budget":  initBudget,
		"running": active,
		"pending": []string{},
		"unread":  0,
	})
	fmt.Fprintf(w, "data: %s\n\n", initData)
	flusher.Flush()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case msg := <-msgChan:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-ticker.C:
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func broadcast(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	sseLock.Lock()
	defer sseLock.Unlock()
	for ch := range sseClients {
		select {
		case ch <- data:
		default:
		}
	}
}

func handleListConversations(w http.ResponseWriter, r *http.Request) {
	type summary struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		CreatedAt int64  `json:"created_at"`
		UpdatedAt int64  `json:"updatedAt"`
	}
	convsLock.RLock()
	list := make([]summary, 0, len(conversations))
	for _, c := range conversations {
		updatedAt := time.Unix(c.CreatedAt, 0).UnixMilli()
		if n := len(c.Events); n > 0 {
			updatedAt = max(updatedAt, c.Events[n-1].At)
		}
		list = append(list, summary{ID: c.ID, Title: c.Title, CreatedAt: c.CreatedAt, UpdatedAt: updatedAt})
	}
	running := runningCID
	convsLock.RUnlock()
	sort.Slice(list, func(i, j int) bool {
		if list[i].UpdatedAt == list[j].UpdatedAt {
			return list[i].ID < list[j].ID
		}
		return list[i].UpdatedAt > list[j].UpdatedAt
	})
	jsonResp(w, 200, map[string]interface{}{
		"items":   list,
		"running": running,
	})
}

func handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	id := fmt.Sprintf("conv_%d", time.Now().UnixNano())
	conv := &Conversation{
		ID:        id,
		Title:     "New Chat",
		CreatedAt: time.Now().Unix(),
		Events:    make([]Event, 0),
		History:   make([]Message, 0),
	}
	convsLock.Lock()
	conversations[id] = conv
	convsLock.Unlock()
	saveConversations()

	broadcast(map[string]string{"type": "conversations"})
	jsonResp(w, 200, map[string]string{"id": id})
}

func handleGetConversation(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/conversations/")
	convsLock.RLock()
	conv, exists := conversations[id]
	defer convsLock.RUnlock()

	if !exists {
		jsonResp(w, 404, map[string]string{"error": "NO_CONVERSATION"})
		return
	}
	jsonResp(w, 200, map[string]interface{}{
		"id":     id,
		"events": conv.Events,
	})
}

func handleDeleteConversation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	convsLock.Lock()
	if body.ID == runningCID {
		convsLock.Unlock()
		jsonResp(w, http.StatusConflict, map[string]string{"error": "BUSY_OTHER"})
		return
	}
	delete(conversations, body.ID)
	convsLock.Unlock()
	saveConversations()

	broadcast(map[string]string{"type": "conversations"})
	jsonResp(w, 200, map[string]bool{"ok": true})
}

func handleRenameConversation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	convsLock.Lock()
	if c, ok := conversations[body.ID]; ok {
		c.Title = body.Title
	}
	convsLock.Unlock()
	saveConversations()

	broadcast(map[string]string{"type": "conversations"})
	jsonResp(w, 200, map[string]bool{"ok": true})
}

func handleSaveModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		BaseURL  string `json:"baseUrl"`
		Key      string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}

	pKey := strings.TrimSpace(body.Provider)
	if pKey == "" {
		pKey = "gemini"
	}
	model := strings.TrimSpace(body.Model)
	if model == "" {
		jsonResp(w, 400, map[string]string{"error": "MODEL_REQUIRED"})
		return
	}
	baseUrl := strings.TrimSpace(body.BaseURL)
	key := strings.TrimSpace(body.Key)

	cfgLock.Lock()
	entry := cfg.Providers[pKey]
	entry.Model = model
	if baseUrl != "" {
		entry.BaseURL = baseUrl
	}
	if key != "" {
		entry.APIKey = key
	}
	cfg.Providers[pKey] = entry

	cfg.ActiveProvider = pKey
	cfg.ActiveModel = model
	cfg.ActiveBaseURL = entry.BaseURL
	cfg.ActiveAPIKey = entry.APIKey

	err := saveConfig()
	cfgLock.Unlock()
	if err != nil {
		log.Printf("Failed to save config: %v", err)
		jsonResp(w, 500, map[string]string{"error": "SAVE_FAILED"})
		return
	}

	log.Printf("Updated model: Provider=%s, Model=%s, BaseURL=%s, KeyConfigured=%v",
		cfg.ActiveProvider, cfg.ActiveModel, cfg.ActiveBaseURL, cfg.ActiveAPIKey != "")

	jsonResp(w, 200, map[string]bool{"ok": true})
}

func handleSaveKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}
	key := strings.TrimSpace(body.Key)
	if key == "" {
		jsonResp(w, 400, map[string]string{"error": "EMPTY_KEY"})
		return
	}

	cfgLock.Lock()
	entry := cfg.Providers[cfg.ActiveProvider]
	entry.APIKey = key
	cfg.Providers[cfg.ActiveProvider] = entry
	cfg.ActiveAPIKey = key
	err := saveConfig()
	cfgLock.Unlock()
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "SAVE_FAILED"})
		return
	}
	jsonResp(w, 200, map[string]bool{"ok": true})
}

func handleSaveBudget(w http.ResponseWriter, r *http.Request) {
	if !authed(r) {
		jsonResp(w, 401, map[string]string{"error": "UNAUTHED"})
		return
	}
	var body struct {
		CapUsd float64 `json:"capUsd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.CapUsd < 0 {
		jsonResp(w, 400, map[string]string{"error": "INVALID_BUDGET"})
		return
	}
	cfgLock.Lock()
	cfg.BudgetCapUsd = body.CapUsd
	err := saveConfig()
	b := map[string]interface{}{
		"spentUsd": cfg.BudgetSpentUsd,
		"capUsd":   cfg.BudgetCapUsd,
		"exceeded": cfg.BudgetCapUsd > 0 && cfg.BudgetSpentUsd >= cfg.BudgetCapUsd,
	}
	cfgLock.Unlock()
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "SAVE_FAILED"})
		return
	}
	broadcast(Event{Type: "budget", Budget: b})
	jsonResp(w, 200, map[string]interface{}{"ok": true, "budget": b})
}

func handleSavePrefs(w http.ResponseWriter, r *http.Request) {
	if !authed(r) {
		jsonResp(w, 401, map[string]string{"error": "UNAUTHED"})
		return
	}
	var body struct {
		Lang  string `json:"lang"`
		Theme string `json:"theme"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}
	cfgLock.Lock()
	if body.Lang != "" {
		cfg.Lang = body.Lang
	}
	if body.Theme != "" {
		cfg.Theme = body.Theme
	}
	err := saveConfig()
	cfgLock.Unlock()
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "SAVE_FAILED"})
		return
	}
	jsonResp(w, 200, map[string]bool{"ok": true})
}

func handleGetClerk(w http.ResponseWriter, r *http.Request) {
	cfgLock.RLock()
	tz := cfg.Timezone
	location := cfg.Location
	chosen := cfg.TimezoneChosen
	cfgLock.RUnlock()
	jsonResp(w, 200, map[string]interface{}{
		"timezone":       tz,
		"timezoneChosen": chosen,
		"location":       location,
		"todos":          []interface{}{},
		"jobs":           []interface{}{},
		"drafts":         []interface{}{},
		"inbox":          []interface{}{},
		"channels":       []interface{}{},
		"unread":         0,
	})
}

func handleSaveTimezone(w http.ResponseWriter, r *http.Request) {
	if !authed(r) {
		jsonResp(w, 401, map[string]string{"error": "UNAUTHED"})
		return
	}
	var body struct {
		Location *CityLocation `json:"location"`
		Timezone string        `json:"timezone"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}
	if city := body.Location; city != nil {
		city.Name = strings.TrimSpace(city.Name)
		if city.Name == "" || len(city.Name) > 256 || city.Latitude < -90 || city.Latitude > 90 || city.Longitude < -180 || city.Longitude > 180 {
			jsonResp(w, 400, map[string]string{"error": "INVALID_CITY"})
			return
		}
		body.Timezone = city.Timezone
	}
	resolved, err := resolveTimezone(body.Timezone)
	if err != nil {
		jsonResp(w, 400, map[string]string{"error": "UNKNOWN_TIMEZONE", "message": "Enter a city name (e.g. Beijing, Tokyo, New York) or IANA timezone (e.g. Asia/Shanghai)"})
		return
	}
	cfgLock.Lock()
	if body.Location == nil && cfg.Location != nil {
		cfgLock.Unlock()
		jsonResp(w, 409, map[string]string{"error": "CITY_ALREADY_SET"})
		return
	}
	previousLocation, previousZone, previousChosen := cfg.Location, cfg.Timezone, cfg.TimezoneChosen
	cfg.Location = body.Location
	cfg.Timezone = resolved
	cfg.TimezoneChosen = true
	saveErr := saveConfig()
	if saveErr != nil {
		cfg.Location, cfg.Timezone, cfg.TimezoneChosen = previousLocation, previousZone, previousChosen
	}
	cfgLock.Unlock()
	if saveErr != nil {
		jsonResp(w, 500, map[string]string{"error": "SAVE_FAILED"})
		return
	}
	jsonResp(w, 200, map[string]interface{}{"ok": true, "timezone": resolved})
}

func handleGetProactive(w http.ResponseWriter, r *http.Request) {
	cfgLock.RLock()
	p := cfg.Proactive
	cfgLock.RUnlock()
	if p.Times == nil {
		p.Times = []string{}
	}
	jsonResp(w, 200, p)
}

func handleSaveProactive(w http.ResponseWriter, r *http.Request) {
	if !authed(r) {
		jsonResp(w, 401, map[string]string{"error": "UNAUTHED"})
		return
	}
	var body struct {
		Enabled *bool    `json:"enabled"`
		Level   *float64 `json:"level"`
		Times   []string `json:"times"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}
	cfgLock.Lock()
	if body.Enabled != nil {
		cfg.Proactive.Enabled = *body.Enabled
	}
	if body.Level != nil {
		cfg.Proactive.Level = *body.Level
	}
	if body.Times != nil {
		cfg.Proactive.Times = body.Times
	}
	err := saveConfig()
	p := cfg.Proactive
	cfgLock.Unlock()
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "SAVE_FAILED"})
		return
	}
	jsonResp(w, 200, p)
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
		CID  string `json:"cid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}

	text := strings.TrimSpace(body.Text)
	if text == "" {
		jsonResp(w, 400, map[string]string{"error": "EMPTY"})
		return
	}
	cfgLock.RLock()
	provider, baseURL, key, model := cfg.ActiveProvider, cfg.ActiveBaseURL, cfg.ActiveAPIKey, cfg.ActiveModel
	cfgLock.RUnlock()
	if key == "" {
		jsonResp(w, 400, map[string]string{"error": "NO_KEY", "message": "Please configure API key in Settings"})
		return
	}

	cid := body.CID
	convsLock.Lock()
	if runningCID != "" {
		convsLock.Unlock()
		jsonResp(w, http.StatusConflict, map[string]string{"error": "BUSY_OTHER"})
		return
	}
	conv, ok := conversations[cid]
	if !ok {
		if cid != "assistant" {
			cid = fmt.Sprintf("conv_%d", time.Now().UnixNano())
		}
		conv = &Conversation{
			ID:        cid,
			Title:     text,
			CreatedAt: time.Now().Unix(),
			Events:    make([]Event, 0),
			History:   make([]Message, 0),
		}
		conversations[cid] = conv
	}
	if len(conv.History) == 0 && conv.Title == "New Chat" {
		conv.Title = text
		if title := []rune(conv.Title); len(title) > 30 {
			conv.Title = string(title[:30]) + "…"
		}
	}
	runningCID = cid
	convsLock.Unlock()

	userEv := Event{At: time.Now().UnixMilli(), Type: "message", Role: "user", Text: text, CID: cid}
	convsLock.Lock()
	conv.Events = append(conv.Events, userEv)
	conv.History = append(conv.History, Message{Role: "user", Text: text, Time: time.Now().Unix()})
	convsLock.Unlock()
	saveConversations()
	broadcast(userEv)

	broadcast(Event{Type: "status", Status: "thinking", CID: cid})

	go func() {
		defer func() {
			convsLock.Lock()
			runningCID = ""
			convsLock.Unlock()
			broadcast(Event{Type: "status", Status: "idle", CID: cid})
		}()

		var aiText string
		var err error

		if provider == "gemini" && !strings.Contains(baseURL, "openai") {
			aiText, err = callGeminiStream(conv.History, cid)
		} else {
			aiText, err = callOpenAIStream(baseURL, key, model, conv.History, cid)
		}

		if err != nil {
			log.Printf("AI stream call error: %v", err)
			errEv := Event{Type: "error", Text: fmt.Sprintf("API Error: %v", err), CID: cid}
			broadcast(errEv)
			return
		}

		aiEv := Event{At: time.Now().UnixMilli(), Type: "message", Role: "assistant", Text: aiText, CID: cid}
		convsLock.Lock()
		conv.Events = append(conv.Events, aiEv)
		conv.History = append(conv.History, Message{Role: "model", Text: aiText, Time: time.Now().Unix()})
		convsLock.Unlock()
		saveConversations()
		broadcast(aiEv)
	}()

	jsonResp(w, 200, map[string]string{"ok": "true", "cid": cid})
}

func bobToolSchemas() []map[string]interface{} {
	return []map[string]interface{}{
		{
			"name":        "install_feature",
			"description": "Install or update a live UI plugin/widget package mounted directly into Bob's web interface (starts in 3-minute trial mode with Keep/Undo buttons).",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"name":        map[string]interface{}{"type": "string", "description": "Short lowercase identifier, e.g. 'weather-badge'"},
					"title":       map[string]interface{}{"type": "string", "description": "Human-readable title, e.g. 'Weather Badge'"},
					"description": map[string]interface{}{"type": "string", "description": "Brief description of what the feature does"},
					"css":         map[string]interface{}{"type": "string", "description": "Optional scoped CSS"},
					"panel_html":  map[string]interface{}{"type": "string", "description": "Optional settings/detail panel HTML"},
					"widgets": map[string]interface{}{
						"type":        "array",
						"description": "UI widgets to mount into slots",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"id":     map[string]interface{}{"type": "string", "description": "Widget id, e.g. 'badge'"},
								"anchor": map[string]interface{}{"type": "string", "description": "Slot name: 'header-right', 'home', 'clerk-top', or 'settings-top'"},
								"place":  map[string]interface{}{"type": "string", "description": "'start' or 'end'"},
								"width":  map[string]interface{}{"type": "integer", "description": "Width in pixels (header-right: 60-160)"},
								"height": map[string]interface{}{"type": "integer", "description": "Height in pixels (header-right: 28-38)"},
								"html":   map[string]interface{}{"type": "string", "description": "Self-contained HTML/CSS/JS for the sandboxed widget iframe"},
							},
							"required": []string{"id", "anchor", "html"},
						},
					},
				},
				"required": []string{"name", "title", "widgets"},
			},
		},
		{
			"name":        "remove_feature",
			"description": "Remove an installed UI feature/plugin by its name.",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"name": map[string]interface{}{"type": "string", "description": "Feature name to remove"},
				},
				"required": []string{"name"},
			},
		},
		{
			"name":        "list_features",
			"description": "List all currently installed UI features/plugins.",
			"parameters": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
	}
}

func callGeminiStream(history []Message, cid string) (string, error) {
	cfgLock.RLock()
	model := cfg.ActiveModel
	apiKey := cfg.ActiveAPIKey
	cfgLock.RUnlock()

	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:streamGenerateContent?alt=sse&key=%s", model, apiKey)

	contents := make([]map[string]interface{}, 0, len(history)+4)
	for _, m := range history {
		role := m.Role
		if role == "assistant" {
			role = "model"
		}
		contents = append(contents, map[string]interface{}{
			"role":  role,
			"parts": []map[string]interface{}{{"text": m.Text}},
		})
	}

	tools := []map[string]interface{}{
		{"functionDeclarations": bobToolSchemas()},
	}
	sysInst := map[string]interface{}{
		"parts": []map[string]interface{}{{"text": bobSystemPrompt()}},
	}

	var full strings.Builder
	client := &http.Client{Timeout: 90 * time.Second}

	for round := 0; round < 4; round++ {
		reqBody := map[string]interface{}{
			"systemInstruction": sysInst,
			"contents":          contents,
			"tools":             tools,
		}
		b, _ := json.Marshal(reqBody)
		req, err := http.NewRequest("POST", url, bytes.NewReader(b))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}

		if resp.StatusCode != 200 {
			errBytes, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return "", fmt.Errorf("status %d: %s", resp.StatusCode, string(errBytes))
		}

		type fnCall struct {
			Name string                 `json:"name"`
			Args map[string]interface{} `json:"args"`
		}
		var calls []fnCall
		var rawModelParts []map[string]interface{}

		reader := bufio.NewReader(resp.Body)
		broadcast(Event{Type: "status", Status: "replying", CID: cid})

		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				break
			}
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			raw := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if raw == "" {
				continue
			}

			var chunk struct {
				Candidates []struct {
					Content struct {
						Parts []map[string]interface{} `json:"parts"`
					} `json:"content"`
				} `json:"candidates"`
			}
			if err := json.Unmarshal([]byte(raw), &chunk); err == nil {
				for _, cand := range chunk.Candidates {
					for _, part := range cand.Content.Parts {
						rawModelParts = append(rawModelParts, part)
						isThought, _ := part["thought"].(bool)
						if txt, ok := part["text"].(string); ok && txt != "" && !isThought {
							full.WriteString(txt)
							broadcast(Event{
								Type: "delta",
								Role: "assistant",
								Text: full.String(),
								CID:  cid,
							})
						}
						if fcRaw, ok := part["functionCall"].(map[string]interface{}); ok {
							name, _ := fcRaw["name"].(string)
							args, _ := fcRaw["args"].(map[string]interface{})
							if args == nil {
								args = map[string]interface{}{}
							}
							if name != "" {
								calls = append(calls, fnCall{Name: name, Args: args})
							}
						}
					}
				}
			}
		}
		resp.Body.Close()

		if len(calls) == 0 {
			break
		}

		// Preserve exact raw model parts (including thoughtSignature) + append tool responses
		respParts := make([]map[string]interface{}, 0, len(calls))
		for _, fc := range calls {
			resultStr := executeBobTool(fc.Name, fc.Args, cid)
			var resultObj map[string]interface{}
			if err := json.Unmarshal([]byte(resultStr), &resultObj); err != nil {
				resultObj = map[string]interface{}{"result": resultStr}
			}
			respParts = append(respParts, map[string]interface{}{
				"functionResponse": map[string]interface{}{
					"name":     fc.Name,
					"response": resultObj,
				},
			})
		}
		contents = append(contents,
			map[string]interface{}{"role": "model", "parts": rawModelParts},
			map[string]interface{}{"role": "user", "parts": respParts},
		)
	}

	return full.String(), nil
}

func callOpenAIStream(baseURL, apiKey, model string, history []Message, cid string) (string, error) {
	if apiKey == "" {
		return "", fmt.Errorf("API key is not configured for provider")
	}

	u := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		u = "https://" + u
	}
	if !strings.HasSuffix(u, "/chat/completions") {
		u = u + "/chat/completions"
	}

	if u == "https://api.openai.com/v1/chat/completions" && model == "gpt-6.2-sol" {
		return callResponsesStream("https://api.openai.com/v1/responses", apiKey, model, history, cid)
	}

	messages := make([]map[string]interface{}, 0, len(history)+5)
	messages = append(messages, map[string]interface{}{
		"role":    "system",
		"content": bobSystemPrompt(),
	})
	for _, m := range history {
		role := m.Role
		if role == "model" {
			role = "assistant"
		}
		messages = append(messages, map[string]interface{}{
			"role":    role,
			"content": m.Text,
		})
	}

	oaiTools := make([]map[string]interface{}, 0, 3)
	for _, s := range bobToolSchemas() {
		oaiTools = append(oaiTools, map[string]interface{}{
			"type":     "function",
			"function": s,
		})
	}

	var full strings.Builder
	client := &http.Client{Timeout: 90 * time.Second}

	for round := 0; round < 4; round++ {
		reqBytes, err := json.Marshal(map[string]interface{}{
			"model":    model,
			"messages": messages,
			"tools":    oaiTools,
			"stream":   true,
		})
		if err != nil {
			return "", err
		}

		req, err := http.NewRequest("POST", u, bytes.NewReader(reqBytes))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)

		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}

		if resp.StatusCode != 200 {
			errBytes, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(errBytes))
		}

		type accTool struct {
			ID   string
			Name string
			Args strings.Builder
		}
		toolAcc := map[int]*accTool{}
		var roundText strings.Builder

		reader := bufio.NewReader(resp.Body)
		broadcast(Event{Type: "status", Status: "replying", CID: cid})

		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				break
			}
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			raw := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if raw == "" {
				continue
			}
			if raw == "[DONE]" {
				break
			}

			var chunk struct {
				Choices []struct {
					Delta struct {
						Role      string `json:"role"`
						Content   string `json:"content"`
						ToolCalls []struct {
							Index    int    `json:"index"`
							ID       string `json:"id"`
							Function struct {
								Name      string `json:"name"`
								Arguments string `json:"arguments"`
							} `json:"function"`
						} `json:"tool_calls"`
					} `json:"delta"`
				} `json:"choices"`
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
			}

			if err := json.Unmarshal([]byte(raw), &chunk); err == nil {
				if chunk.Error != nil && chunk.Error.Message != "" {
					resp.Body.Close()
					return full.String(), fmt.Errorf("API Error: %s", chunk.Error.Message)
				}
				for _, choice := range chunk.Choices {
					if choice.Delta.Content != "" {
						roundText.WriteString(choice.Delta.Content)
						full.WriteString(choice.Delta.Content)
						broadcast(Event{
							Type: "delta",
							Role: "assistant",
							Text: full.String(),
							CID:  cid,
						})
					}
					for _, tc := range choice.Delta.ToolCalls {
						acc, ok := toolAcc[tc.Index]
						if !ok {
							acc = &accTool{}
							toolAcc[tc.Index] = acc
						}
						if tc.ID != "" {
							acc.ID = tc.ID
						}
						if tc.Function.Name != "" {
							acc.Name = tc.Function.Name
						}
						if tc.Function.Arguments != "" {
							acc.Args.WriteString(tc.Function.Arguments)
						}
					}
				}
			}
		}
		resp.Body.Close()

		if len(toolAcc) == 0 {
			break
		}

		tcList := make([]map[string]interface{}, 0, len(toolAcc))
		toolMsgs := make([]map[string]interface{}, 0, len(toolAcc))
		for idx := 0; idx < len(toolAcc); idx++ {
			acc, ok := toolAcc[idx]
			if !ok {
				continue
			}
			id := acc.ID
			if id == "" {
				id = fmt.Sprintf("call_%d_%d", round, idx)
			}
			argsStr := acc.Args.String()
			tcList = append(tcList, map[string]interface{}{
				"id":   id,
				"type": "function",
				"function": map[string]interface{}{
					"name":      acc.Name,
					"arguments": argsStr,
				},
			})
			var argsMap map[string]interface{}
			_ = json.Unmarshal([]byte(argsStr), &argsMap)
			if argsMap == nil {
				argsMap = map[string]interface{}{}
			}
			resStr := executeBobTool(acc.Name, argsMap, cid)
			toolMsgs = append(toolMsgs, map[string]interface{}{
				"role":         "tool",
				"tool_call_id": id,
				"content":      resStr,
			})
		}
		messages = append(messages, map[string]interface{}{
			"role":       "assistant",
			"content":    roundText.String(),
			"tool_calls": tcList,
		})
		messages = append(messages, toolMsgs...)
	}

	return full.String(), nil
}

func handleV1Chat(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Message string `json:"message"`
		CID     string `json:"conversation_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResp(w, 400, map[string]string{"error": "BAD_JSON"})
		return
	}
	hist := []Message{{Role: "user", Text: body.Message}}
	var resp string
	var err error
	if cfg.ActiveProvider == "gemini" && !strings.Contains(cfg.ActiveBaseURL, "openai") {
		resp, err = callGeminiStream(hist, body.CID)
	} else {
		resp, err = callOpenAIStream(cfg.ActiveBaseURL, cfg.ActiveAPIKey, cfg.ActiveModel, hist, body.CID)
	}
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": err.Error()})
		return
	}
	jsonResp(w, 200, map[string]string{"response": resp})
}

func jsonResp(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
