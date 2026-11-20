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

type Host struct {
	Authorized func(*http.Request) bool
	Classic    http.HandlerFunc
	// Read the owner's existing official OpenAI key and remaining budget on each call.
	VisionConfig func() (apiKey string, remainingUSD float64)
}

func (a *App) Mount(m *http.ServeMux, host Host) {
	file := func(name, typ string) http.HandlerFunc {
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
	m.HandleFunc("GET /{$}", file("home.html", "text/html; charset=utf-8"))
	m.HandleFunc("GET /classic", host.Classic)
	m.HandleFunc("GET /life-ui.js", file("life.js", "text/javascript; charset=utf-8"))
	m.HandleFunc("GET /sw.js", file("sw.js", "text/javascript; charset=utf-8"))
	m.HandleFunc("GET /life.webmanifest", file("manifest.json", "application/manifest+json"))
	m.HandleFunc("GET /api/life/version", func(w http.ResponseWriter, r *http.Request) { reply(w, 200, map[string]string{"version": Version}) })
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
				case "storage":
					code = 500
				case "missing":
					code = 404
				case "stale":
					code = 409
				case "visionUnavailable", "budget":
					code = 409
				case "provider":
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
	route("GET /api/life/push", func(w http.ResponseWriter, r *http.Request) error {
		a.mu.Lock()
		defer a.mu.Unlock()
		k, e := pushPrivate(a.state.Key)
		if e != nil {
			return errors.New("storage")
		}
		pub, e := k.ECDH()
		if e != nil {
			return errors.New("storage")
		}
		reply(w, 200, map[string]string{"key": web64.EncodeToString(pub.PublicKey().Bytes())})
		return nil
	})
	route("POST /api/life/push", func(w http.ResponseWriter, r *http.Request) error {
		var p struct {
			Endpoint string
			Remove   bool
		}
		if e := decode(w, r, &p); e != nil {
			return e
		}
		if _, ok := pushURL(p.Endpoint); !ok {
			return errors.New("pushHost")
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		s := a.copy()
		if p.Remove {
			forgetDevice(s.Subs, p.Endpoint)
		} else {
			s.Subs[p.Endpoint] = ""
		}
		if e := a.save(s); e != nil {
			return errors.New("storage")
		}
		reply(w, 200, true)
		return nil
	})
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
