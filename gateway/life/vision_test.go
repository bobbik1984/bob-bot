package life

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestConfiguredVisionRequests(t *testing.T) {
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(img.Bytes())
	photo := "data:image/png;base64," + encoded
	for _, tc := range []struct {
		provider, base string
		native         bool
	}{
		{"gemini", "/v1beta", true}, {"gemini", "/v1beta/openai", false}, {"qwen", "/compatible-mode/v1", false}, {"kimi", "/v1", false}, {"openai", "/v1", false},
	} {
		t.Run(tc.provider+tc.base, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				raw, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
				}
				var body map[string]any
				if json.Unmarshal(raw, &body) != nil {
					t.Error("invalid request")
					return
				}
				if r.Method != "POST" || r.URL.RawQuery != "" || strings.Contains(string(raw), "fixture-key") {
					t.Error("unexpected transport")
				}
				answer := map[string]string{"Title": "看展", "Place": "西岸美术馆", "City": "上海", "Area": "西岸", "Date": ""}
				extracted, _ := json.Marshal(answer)
				if tc.native {
					if r.URL.Path != tc.base+"/models/selected-vision:generateContent" || r.Header.Get("x-goog-api-key") != "fixture-key" || r.Header.Get("Authorization") != "" {
						t.Error("wrong native route or auth")
					}
					parts := body["contents"].([]any)[0].(map[string]any)["parts"].([]any)
					inline := parts[1].(map[string]any)["inlineData"].(map[string]any)
					if inline["mimeType"] != "image/png" || inline["data"] != encoded || body["systemInstruction"] == nil {
						t.Error("bad inline image")
					}
					json.NewEncoder(w).Encode(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"thought": true, "text": "ignore"}, map[string]any{"text": string(extracted)}}}}}})
				} else {
					if r.URL.Path != tc.base+"/chat/completions" || body["model"] != "selected-vision" || r.Header.Get("Authorization") != "Bearer fixture-key" || r.Header.Get("x-goog-api-key") != "" {
						t.Error("wrong compatible route or auth")
					}
					parts := body["messages"].([]any)[1].(map[string]any)["content"].([]any)
					if parts[1].(map[string]any)["image_url"].(map[string]any)["url"] != photo {
						t.Error("image changed")
					}
					json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "```json\n" + string(extracted) + "\n```"}}}})
				}
			}))
			defer server.Close()
			a, err := Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			config := VisionConfig{tc.provider, "selected-vision", server.URL + tc.base, "fixture-key", .01}
			host := Host{VisionConfig: func() VisionConfig { return config }}
			out, err := a.readIntent(context.Background(), host, photo, "本周看展", "2026-11-21")
			if err != nil || out.Area != "西岸" || out.Title != "看展" {
				t.Fatal(out, err)
			}
			_, err = a.readIntent(context.Background(), host, photo, "", "2026-11-21")
			if err == nil || err.Error() != "budget" || calls.Load() != 1 {
				t.Fatal("budget guard", calls.Load(), err)
			}
		})
	}
}

func TestVisionFailures(t *testing.T) {
	a, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var status atomic.Int32
	status.Store(http.StatusBadRequest)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(int(status.Load()))
		io.WriteString(w, "{}")
	}))
	defer server.Close()
	c := VisionConfig{Provider: "gemini", Model: "custom", BaseURL: server.URL, RemainingUSD: 1}
	host := Host{VisionConfig: func() VisionConfig { return c }}
	read := func(want string) {
		t.Helper()
		_, err := a.readIntent(context.Background(), host, "", "note", "2026-11-21")
		if err == nil || err.Error() != want {
			t.Fatal(want, err)
		}
	}
	read("visionUnavailable")
	c.APIKey = "fixture"
	c.BaseURL = server.URL + "?key=secret"
	read("visionUnavailable")
	if a.state.VisionUSD != 0 {
		t.Fatal("invalid config charged")
	}
	c.BaseURL = server.URL
	for _, tc := range []struct {
		code int
		want string
	}{{400, "providerRejected"}, {401, "providerAuth"}, {429, "providerLimit"}, {200, "provider"}} {
		status.Store(int32(tc.code))
		read(tc.want)
	}
}
