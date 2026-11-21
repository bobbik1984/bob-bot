// Package life follows personal intentions across visits to Bob.
package life

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const Version = "0.4.0-life.3"

type Item struct {
	ID      string
	Kind    string // wish, plan or save
	Text    string
	Place   string
	At      int64 // deadline for wishes; start time for plans, Unix milliseconds
	Created int64
	Status  string
	Image   string
	Snooze  int64
	Signal  string
	Related string
	Seen    string
}
type Input struct {
	ID, Kind, Text, Place, Photo string
	At                           int64
}
type store struct {
	Items     []Item
	Key       string
	Month     string
	VisionUSD float64
	Subs      map[string]string // endpoint => last delivered signal
}
type App struct {
	mu    sync.Mutex
	dir   string
	state store
	now   func() time.Time
}

func Open(dir string) (*App, error) {
	a := &App{dir: dir, now: time.Now}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	b, e := os.ReadFile(filepath.Join(dir, "state.json"))
	if e == nil {
		e = json.Unmarshal(b, &a.state)
	} else if os.IsNotExist(e) {
		e = nil
	}
	if e != nil {
		return nil, e
	}
	if a.state.Subs == nil {
		a.state.Subs = map[string]string{}
	}
	if a.state.Key == "" {
		key, e := makePushKey()
		if e != nil {
			return nil, e
		}
		a.state.Key = key
		if e = a.save(a.state); e != nil {
			return nil, e
		}
	}
	if _, e = pushPrivate(a.state.Key); e != nil {
		return nil, e
	}
	return a, nil
}
func atomicWrite(path string, b []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".pending-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
func (a *App) save(next store) error {
	b, e := json.Marshal(next)
	if e != nil {
		return e
	}
	if e = atomicWrite(filepath.Join(a.dir, "state.json"), b); e != nil {
		return e
	}
	a.state = next
	return nil
}
func (a *App) copy() store {
	s := a.state
	s.Items = append([]Item{}, s.Items...)
	s.Subs = make(map[string]string, len(a.state.Subs))
	for k, v := range a.state.Subs {
		s.Subs[k] = v
	}
	return s
}
func fileID(s string) bool {
	if len(s) != 32 {
		return false
	}
	_, e := hex.DecodeString(s)
	return e == nil
}
func validatePhoto(raw string) ([]byte, string, error) {
	pre, encoded, ok := strings.Cut(raw, ",")
	if !ok || len(encoded) > 2800000 {
		return nil, "", errors.New("image")
	}
	b, e := base64.StdEncoding.DecodeString(encoded)
	if e != nil {
		return nil, "", errors.New("image")
	}
	cfg, kind, e := image.DecodeConfig(bytes.NewReader(b))
	if e != nil || (kind != "png" && kind != "jpeg") || pre != "data:image/"+kind+";base64" || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 4096 || cfg.Height > 4096 {
		return nil, "", errors.New("image")
	}
	return b, kind, nil
}
func norm(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), "")) }
func match(i Item, items []Item, now time.Time) (string, string) {
	n := now.UnixMilli()
	if i.Kind != "wish" || i.Status != "open" || i.Snooze > n || (i.At != 0 && i.At < n) {
		return "", ""
	}
	place := norm(i.Place)
	var best *Item
	if place != "" {
		for j := range items {
			p := &items[j]
			if p.Kind != "plan" || p.Status != "open" || norm(p.Place) != place || p.At < n || p.At > now.Add(72*time.Hour).UnixMilli() || (i.At != 0 && p.At > i.At) {
				continue
			}
			if best == nil || p.At < best.At {
				best = p
			}
		}
	}
	if best != nil {
		return "visit:" + best.ID, best.ID
	}
	if i.At != 0 && i.At <= now.Add(24*time.Hour).UnixMilli() {
		return fmt.Sprintf("deadline:%d", i.At), ""
	}
	return "", ""
}
func refresh(s *store, t time.Time) bool {
	changed := false
	for n := range s.Items {
		i := &s.Items[n]
		signal, other := match(*i, s.Items, t)
		if i.Signal != signal || i.Related != other {
			i.Signal, i.Related = signal, other
			changed = true
		}
	}
	return changed
}
func (a *App) add(v Input) (Item, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	v.Text = strings.TrimSpace(v.Text)
	v.Place = strings.TrimSpace(v.Place)
	if !fileID(v.ID) || len(v.Text) > 4800 || len(v.Place) > 240 || (v.Text == "" && v.Photo == "") || (v.Kind != "wish" && v.Kind != "plan" && v.Kind != "save") {
		return Item{}, errors.New("invalid")
	}
	for _, i := range a.state.Items {
		if i.ID == v.ID {
			return i, nil
		}
	}
	if v.At < 0 || v.At > now.AddDate(10, 0, 0).UnixMilli() || (v.Kind == "plan" && v.At <= now.UnixMilli()) {
		return Item{}, errors.New("time")
	}
	s := a.copy()
	i := Item{ID: v.ID, Kind: v.Kind, Text: v.Text, Place: v.Place, At: v.At, Created: now.UnixMilli(), Status: "open"}
	if v.Photo != "" {
		b, kind, e := validatePhoto(v.Photo)
		if e != nil {
			return Item{}, e
		}
		i.Image = kind
		if e = atomicWrite(filepath.Join(a.dir, i.ID+"."+kind), b); e != nil {
			return Item{}, errors.New("storage")
		}
	}
	s.Items = append(s.Items, i)
	refresh(&s, now)
	if e := a.save(s); e != nil {
		if i.Image != "" {
			os.Remove(filepath.Join(a.dir, i.ID+"."+i.Image))
		}
		return Item{}, errors.New("storage")
	}
	return i, nil
}
func (a *App) act(id, act, signal string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.copy()
	now := a.now()
	refresh(&s, now)
	for n := range s.Items {
		i := &s.Items[n]
		if i.ID != id {
			continue
		}
		switch act {
		case "done", "drop":
			i.Status = act
		case "seen":
			if i.Signal == "" || signal != i.Signal {
				return errors.New("stale")
			}
			i.Seen = i.Signal
		case "later":
			if i.Status != "open" {
				return errors.New("closed")
			}
			i.Snooze = now.Add(24 * time.Hour).UnixMilli()
			i.Seen = ""
			for k := range s.Subs {
				if strings.HasSuffix(k, "\n"+id) {
					delete(s.Subs, k)
				}
			}
		default:
			return errors.New("invalid")
		}
		refresh(&s, now)
		if a.save(s) != nil {
			return errors.New("storage")
		}
		return nil
	}
	return errors.New("missing")
}
func (a *App) list() ([]Item, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.copy()
	if refresh(&s, a.now()) {
		if e := a.save(s); e != nil {
			return nil, e
		}
	}
	sort.SliceStable(s.Items, func(i, j int) bool { return s.Items[i].Created > s.Items[j].Created })
	return s.Items, nil
}
func (a *App) Run(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		a.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
func id() string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
