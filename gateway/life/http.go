package life

import (
	"embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

//go:embed web/*
var web embed.FS

// Set to the source archive digest for builds compiled on the target.
var sourceBuild string

type Host struct {
	Authorized func(*http.Request) bool
	Assistant  http.HandlerFunc
	// Snapshot the active gateway settings for each explicit extraction.
	VisionConfig func() VisionConfig
	Timezone     func() string
}

func webFile(name, typ string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, e := web.ReadFile("web/" + name)
		if e != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", typ)
		w.Write(b)
	}
}

// MountPWA owns the origin-wide installation and push anchors, separately from either UI.
func MountPWA(m *http.ServeMux) {
	m.HandleFunc("GET /sw.js", webFile("sw.js", "text/javascript; charset=utf-8"))
	m.HandleFunc("GET /push-client.js", webFile("push-client.js", "text/javascript; charset=utf-8"))
	manifest := webFile("manifest.json", "application/manifest+json")
	m.HandleFunc("GET /life.webmanifest", manifest)
	m.HandleFunc("GET /manifest.webmanifest", manifest)
}
func (a *App) Mount(m *http.ServeMux, host Host) {
	a.mountIntake(m, host)
	m.HandleFunc("GET /{$}", host.Assistant)
	m.HandleFunc("GET /classic", func(w http.ResponseWriter, r *http.Request) {
		u := *r.URL
		u.Path = "/"
		http.Redirect(w, r, u.RequestURI(), http.StatusTemporaryRedirect)
	})
	m.HandleFunc("GET /life-turn.mjs", webFile("turn.mjs", "text/javascript; charset=utf-8"))
	m.HandleFunc("GET /life-ui.js", webFile("life.js", "text/javascript; charset=utf-8"))
	m.HandleFunc("GET /life-calendar.mjs", webFile("calendar.mjs", "text/javascript; charset=utf-8"))
	m.HandleFunc("GET /api/life/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		body := map[string]string{"version": Version}
		if sourceBuild != "" {
			body["build"] = sourceBuild
		}
		reply(w, 200, body)
	})
	route := func(pattern string, h func(http.ResponseWriter, *http.Request) error) {
		m.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "private, no-store")
			if !host.Authorized(r) {
				http.Error(w, "auth", 401)
				return
			}
			if r.Method == "POST" && (r.Header.Get("Sec-Fetch-Site") == "cross-site" || strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json") {
				http.Error(w, "type", 403)
				return
			}
			if e := h(w, r); e != nil {
				code := 400
				switch e.Error() {
				case "expired":
					code = 410
				case "pushFailed":
					code = 502
				case "storage":
					code = 500
				case "missing":
					code = 404
				case "stale":
					code = 409
				case "visionUnavailable", "budget":
					code = 409
				case "provider", "providerAuth", "providerLimit", "providerRejected":
					code = 502
				}
				http.Error(w, e.Error(), code)
			}
		})
	}
	decode := func(w http.ResponseWriter, r *http.Request, v any) error {
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 3<<20))
		if dec.Decode(v) != nil {
			return errors.New("invalid")
		}
		return nil
	}
	route("GET /api/life/items", func(w http.ResponseWriter, r *http.Request) error {
		items, e := a.list()
		if e != nil {
			return errors.New("storage")
		}
		reply(w, 200, items)
		return nil
	})
	route("POST /api/life/items", func(w http.ResponseWriter, r *http.Request) error {
		var v Input
		if e := decode(w, r, &v); e != nil {
			return e
		}
		item, e := a.add(v)
		if e != nil {
			return e
		}
		reply(w, 200, item)
		return nil
	})
	route("POST /api/life/calendar", func(w http.ResponseWriter, r *http.Request) error {
		var v struct{ Events []calendarEvent }
		if e := decode(w, r, &v); e != nil {
			return e
		}
		result, e := a.importCalendar(v.Events)
		if e != nil {
			return e
		}
		reply(w, 200, result)
		return nil
	})
	route("POST /api/life/action", func(w http.ResponseWriter, r *http.Request) error {
		var v struct{ ID, Action, Signal string }
		if e := decode(w, r, &v); e != nil {
			return e
		}
		if e := a.act(v.ID, v.Action, v.Signal); e != nil {
			return e
		}
		reply(w, 200, true)
		return nil
	})
	route("GET /api/life/art/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !fileID(id) {
			return errors.New("missing")
		}
		a.mu.Lock()
		ext := ""
		for _, i := range a.state.Items {
			if i.ID == id {
				ext = i.Image
				break
			}
		}
		a.mu.Unlock()
		if ext != "png" && ext != "jpeg" {
			return errors.New("missing")
		}
		f, e := os.Open(filepath.Join(a.dir, id+"."+ext))
		if e != nil {
			return errors.New("missing")
		}
		defer f.Close()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", "image/"+ext)
		_, _ = io.Copy(w, f)
		return nil
	})
	config := func(w http.ResponseWriter, r *http.Request) error {
		key, err := a.Push.publicKey()
		if err != nil {
			return errors.New("storage")
		}
		reply(w, 200, map[string]any{"key": key, "publicKey": key, "subscriptions": len(a.Push.endpoints())})
		return nil
	}
	route("GET /api/life/push", config)
	route("GET /api/push/config", config)
	syncPush := func(w http.ResponseWriter, r *http.Request) error {
		var v struct {
			PushSubscription
			Subscription     *PushSubscription
			PreviousEndpoint string
			Remove           bool
			Preview          *bool
		}
		if err := decode(w, r, &v); err != nil {
			return err
		}
		if v.Subscription != nil {
			v.PushSubscription = *v.Subscription
		}
		if _, ok := pushURL(v.Endpoint); !ok {
			return errors.New("pushHost")
		}
		if v.Remove {
			if err := a.Push.remove(v.Endpoint, nil); err != nil {
				return errors.New("storage")
			}
			reply(w, 200, true)
			return nil
		}
		device, err := a.Push.sync(v.PushSubscription, v.PreviousEndpoint, v.Preview)
		if err != nil {
			return err
		}
		reply(w, 200, map[string]any{"preview": device.Preview, "subscriptions": len(a.Push.endpoints())})
		return nil
	}
	route("POST /api/life/push", syncPush)
	route("POST /api/push/subscribe", syncPush)
	testPush := func(w http.ResponseWriter, r *http.Request) error {
		var v struct{ Endpoint string }
		if err := decode(w, r, &v); err != nil {
			return err
		}
		if err := a.Push.sendTo(r.Context(), v.Endpoint, PushMessage{}, true); err != nil {
			return err
		}
		reply(w, 200, map[string]bool{"accepted": true})
		return nil
	}
	route("POST /api/life/push/test", testPush)
	route("POST /api/push/test", testPush)
	route("POST /api/life/read", func(w http.ResponseWriter, r *http.Request) error {
		var v struct{ Photo, Text, Today string }
		if e := decode(w, r, &v); e != nil {
			return e
		}
		result, e := a.readIntent(r.Context(), host, v.Photo, v.Text, v.Today)
		if e != nil {
			return e
		}
		reply(w, 200, result)
		return nil
	})
}
