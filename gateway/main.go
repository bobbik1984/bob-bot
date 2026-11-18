package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed public/*
var embeddedPublic embed.FS

type ProviderEntry struct {
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	APIKey  string `json:"apiKey"`
}

type Config struct {
	Port           string                   `json:"port"`
	PIN            string                   `json:"pin"`
	CookieSecret   string                   `json:"cookieSecret"`
	ActiveProvider string                   `json:"activeProvider"`
	ActiveModel    string                   `json:"activeModel"`
	ActiveBaseURL  string                   `json:"activeBaseUrl"`
	ActiveAPIKey   string                   `json:"activeApiKey"`
	Providers      map[string]ProviderEntry `json:"providers"`
}

type Message struct {
	Role string `json:"role"`
	Text string `json:"text"`
	Time int64  `json:"time,omitempty"`
}

type Event struct {
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
	History   []Message `json:"-"`
}

var (
	cfg           Config
	convsLock     sync.RWMutex
	conversations = make(map[string]*Conversation)
	runningCID    string
	sseClients    = make(map[chan []byte]bool)
	sseLock       sync.Mutex
)

func main() {
	cfg = loadConfig()

	log.Printf("Starting Bob-Bot (Go Native Gateway) on port :%s", cfg.Port)
	log.Printf("Active Provider: %s | Model: %s", cfg.ActiveProvider, cfg.ActiveModel)
	if cfg.ActiveAPIKey == "" {
		log.Println("WARNING: Active API Key is not set. Chat will prompt for key in Settings.")
	} else {
		log.Printf("Active API Key configured (hint: %s)", maskKey(cfg.ActiveAPIKey))
	}

	mux := http.NewServeMux()

	// Static routes
	subFS, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		log.Fatalf("Failed to sub embed FS: %v", err)
	}

	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			data, err := subFS.Open("index.html")
			if err != nil {
				http.Error(w, "index.html missing", 500)
				return
			}
			defer data.Close()
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			io.Copy(w, data)
			return
		}
		http.FileServer(http.FS(subFS)).ServeHTTP(w, r)
	})

	// API routes
	mux.HandleFunc("GET /api/state", handleState)
	mux.HandleFunc("GET /api/version", handleVersion)
	mux.HandleFunc("POST /api/login", handleLogin)
	mux.HandleFunc("POST /api/logout", handleLogout)
	mux.HandleFunc("GET /api/events", handleEvents)

	mux.HandleFunc("GET /api/conversations", handleListConversations)
	mux.HandleFunc("POST /api/conversations", handleCreateConversation)
	mux.HandleFunc("GET /api/conversations/", handleGetConversation)
	mux.HandleFunc("POST /api/conversations/delete", handleDeleteConversation)
	mux.HandleFunc("POST /api/conversations/rename", handleRenameConversation)

	mux.HandleFunc("POST /api/chat", handleChat)
	mux.HandleFunc("POST /api/model", handleSaveModel)
	mux.HandleFunc("POST /api/key", handleSaveKey)

	// Stub endpoints to satisfy UI tabs
	mux.HandleFunc("GET /api/clerk", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]interface{}{"items": []string{}, "unread": 0}) })
	mux.HandleFunc("GET /api/extensions", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]interface{}{"mcp": []string{}}) })
	mux.HandleFunc("GET /api/features", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]interface{}{"items": []string{}}) })
	mux.HandleFunc("GET /api/memory", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, []string{}) })
	mux.HandleFunc("GET /api/proactive", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]interface{}{"enabled": false}) })
	mux.HandleFunc("GET /api/wechat/status", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]interface{}{"running": false}) })
	mux.HandleFunc("GET /api/push/config", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]interface{}{"publicKey": "", "subscriptions": 0}) })
	mux.HandleFunc("GET /api/push/log", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]interface{}{"items": []string{}}) })
	mux.HandleFunc("GET /api/models", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]interface{}{"deepseek": []string{}, "current": cfg.ActiveModel}) })

	// WeChat bridge compatibility endpoints
	mux.HandleFunc("POST /v1/chat", handleV1Chat)
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) { jsonResp(w, 200, map[string]string{"status": "ok", "model": cfg.ActiveModel}) })

	server := &http.Server{
		Addr:         ":" + cfg.Port,
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
		pin = "1234"
	}
	secret := os.Getenv("BOBBOT_SECRET")
	if secret == "" {
		secret = "bobbot_secret_token_salt_2026"
	}

	dataDir := "./data"
	os.MkdirAll(dataDir, 0755)
	cfgPath := filepath.Join(dataDir, "config.json")

	c := Config{
		Port:           port,
		PIN:            pin,
		CookieSecret:   secret,
		ActiveProvider: "gemini",
		ActiveModel:    "gemini-2.5-flash",
		ActiveBaseURL:  "https://generativelanguage.googleapis.com/v1beta",
		Providers: map[string]ProviderEntry{
			"gemini": {
				BaseURL: "https://generativelanguage.googleapis.com/v1beta",
				Model:   "gemini-2.5-flash",
			},
			"openai": {
				BaseURL: "https://api.openai.com/v1",
				Model:   "gpt-4o-mini",
			},
			"openrouter": {
				BaseURL: "https://openrouter.ai/api/v1",
				Model:   "google/gemini-2.5-flash",
			},
			"xai": {
				BaseURL: "https://api.x.ai/v1",
				Model:   "grok-3-mini",
			},
			"deepseek": {
				BaseURL: "https://api.deepseek.com/v1",
				Model:   "deepseek-chat",
			},
			"moonshot": {
				BaseURL: "https://api.moonshot.cn/v1",
				Model:   "moonshot-v1-8k",
			},
			"qwen": {
				BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				Model:   "qwen-plus",
			},
			"zhipu": {
				BaseURL: "https://open.bigmodel.cn/api/paas/v4",
				Model:   "glm-4-flash",
			},
			"doubao": {
				BaseURL: "https://ark.cn-beijing.volces.com/api/v3",
				Model:   "Doubao-Seed-1.6-flash",
			},
			"custom": {
				BaseURL: "",
				Model:   "",
			},
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
	return os.WriteFile(filepath.Join(dataDir, "config.json"), b, 0600)
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
		resp["budget"] = map[string]interface{}{"spentUsd": 0.0, "capUsd": 100.0, "exceeded": false}
		resp["unread"] = 0
		resp["build"] = map[string]string{"version": "0.3.0-go", "builtAt": "2026-11-18"}
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

	initData, _ := json.Marshal(map[string]interface{}{
		"type":    "hello",
		"budget":  map[string]interface{}{"spentUsd": 0.0, "capUsd": 100.0},
		"running": runningCID,
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
	convsLock.RLock()
	defer convsLock.RUnlock()

	list := make([]map[string]interface{}, 0, len(conversations))
	for _, c := range conversations {
		list = append(list, map[string]interface{}{
			"id":         c.ID,
			"title":      c.Title,
			"created_at": c.CreatedAt,
		})
	}
	jsonResp(w, 200, map[string]interface{}{
		"items":   list,
		"running": runningCID,
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

	broadcast(map[string]string{"type": "conversations"})
	jsonResp(w, 200, map[string]string{"id": id})
}

func handleGetConversation(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/conversations/")
	convsLock.RLock()
	conv, exists := conversations[id]
	convsLock.RUnlock()

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
	delete(conversations, body.ID)
	convsLock.Unlock()

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

	if err := saveConfig(); err != nil {
		log.Printf("Failed to save config: %v", err)
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

	entry := cfg.Providers[cfg.ActiveProvider]
	entry.APIKey = key
	cfg.Providers[cfg.ActiveProvider] = entry
	cfg.ActiveAPIKey = key

	saveConfig()
	jsonResp(w, 200, map[string]bool{"ok": true})
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
	if cfg.ActiveAPIKey == "" {
		jsonResp(w, 400, map[string]string{"error": "NO_KEY", "message": "Please configure API key in Settings"})
		return
	}

	cid := body.CID
	convsLock.Lock()
	conv, ok := conversations[cid]
	if !ok {
		cid = fmt.Sprintf("conv_%d", time.Now().UnixNano())
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
		if len(conv.Title) > 30 {
			conv.Title = conv.Title[:30] + "..."
		}
	}
	runningCID = cid
	convsLock.Unlock()

	userEv := Event{Type: "message", Role: "user", Text: text, CID: cid}
	convsLock.Lock()
	conv.Events = append(conv.Events, userEv)
	conv.History = append(conv.History, Message{Role: "user", Text: text, Time: time.Now().Unix()})
	convsLock.Unlock()
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

		if cfg.ActiveProvider == "gemini" && !strings.Contains(cfg.ActiveBaseURL, "openai") {
			aiText, err = callGeminiStream(conv.History, cid)
		} else {
			aiText, err = callOpenAIStream(cfg.ActiveBaseURL, cfg.ActiveAPIKey, cfg.ActiveModel, conv.History, cid)
		}

		if err != nil {
			log.Printf("AI stream call error: %v", err)
			errEv := Event{Type: "error", Text: fmt.Sprintf("API Error: %v", err), CID: cid}
			broadcast(errEv)
			return
		}

		aiEv := Event{Type: "message", Role: "assistant", Text: aiText, CID: cid}
		convsLock.Lock()
		conv.Events = append(conv.Events, aiEv)
		conv.History = append(conv.History, Message{Role: "model", Text: aiText, Time: time.Now().Unix()})
		convsLock.Unlock()
	}()

	jsonResp(w, 200, map[string]string{"ok": "true", "cid": cid})
}

func callGeminiStream(history []Message, cid string) (string, error) {
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:streamGenerateContent?alt=sse&key=%s", cfg.ActiveModel, cfg.ActiveAPIKey)

	type ContentPart struct {
		Text string `json:"text"`
	}
	type Content struct {
		Role  string        `json:"role"`
		Parts []ContentPart `json:"parts"`
	}
	type ReqBody struct {
		Contents []Content `json:"contents"`
	}

	contents := make([]Content, 0, len(history))
	for _, m := range history {
		role := m.Role
		if role == "assistant" {
			role = "model"
		}
		contents = append(contents, Content{
			Role:  role,
			Parts: []ContentPart{{Text: m.Text}},
		})
	}

	b, _ := json.Marshal(ReqBody{Contents: contents})
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		errBytes, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("status %d: %s", resp.StatusCode, string(errBytes))
	}

	var full strings.Builder
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
					Parts []struct {
						Text string `json:"text"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
		}
		if err := json.Unmarshal([]byte(raw), &chunk); err == nil {
			for _, cand := range chunk.Candidates {
				for _, part := range cand.Content.Parts {
					if part.Text != "" {
						full.WriteString(part.Text)
						broadcast(Event{
							Type: "message",
							Role: "assistant",
							Text: full.String(),
							CID:  cid,
						})
					}
				}
			}
		}
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

	type ChatMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type ReqBody struct {
		Model    string    `json:"model"`
		Messages []ChatMsg `json:"messages"`
		Stream   bool      `json:"stream"`
	}

	messages := make([]ChatMsg, 0, len(history))
	for _, m := range history {
		role := m.Role
		if role == "model" {
			role = "assistant"
		}
		messages = append(messages, ChatMsg{
			Role:    role,
			Content: m.Text,
		})
	}

	reqBytes, err := json.Marshal(ReqBody{
		Model:    model,
		Messages: messages,
		Stream:   true,
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

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		errBytes, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(errBytes))
	}

	var full strings.Builder
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
					Role             string `json:"role"`
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}

		if err := json.Unmarshal([]byte(raw), &chunk); err == nil {
			if chunk.Error != nil && chunk.Error.Message != "" {
				return full.String(), fmt.Errorf("API Error: %s", chunk.Error.Message)
			}
			for _, choice := range chunk.Choices {
				content := choice.Delta.Content
				if content != "" {
					full.WriteString(content)
					broadcast(Event{
						Type: "message",
						Role: "assistant",
						Text: full.String(),
						CID:  cid,
					})
				}
			}
		}
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
