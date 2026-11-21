package life

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReturnAtTheRightMoment(t *testing.T) {
	dir := t.TempDir()
	a, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Date(2026, 11, 20, 8, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }
	add := func(kind, place string, at time.Time) Item {
		v := Input{ID: id(), Kind: kind, Text: "sample", Place: place}
		if !at.IsZero() {
			v.At = at.UnixMilli()
		}
		i, e := a.add(v)
		if e != nil {
			t.Fatal(e)
		}
		return i
	}
	w := add("wish", "West Bund", now.Add(5*24*time.Hour))
	b := add("save", "West Bund", now.Add(time.Hour))
	p := add("plan", "west bund", now.Add(48*time.Hour))
	get := func(id string) Item {
		xs, e := a.list()
		if e != nil {
			t.Fatal(e)
		}
		for _, i := range xs {
			if i.ID == id {
				return i
			}
		}
		t.Fatal("lost item")
		return Item{}
	}
	if get(w.ID).Related != p.ID || get(b.ID).Signal != "" {
		t.Fatal("wrong opportunity or bookmark became active")
	}
	if e = a.act(p.ID, "drop", ""); e != nil {
		t.Fatal(e)
	}
	if get(w.ID).Signal != "" {
		t.Fatal("cancelled plan still active")
	}
	now = now.Add(4 * 24 * time.Hour)
	sig := get(w.ID).Signal
	if !strings.HasPrefix(sig, "deadline:") {
		t.Fatal("missing deadline without new input")
	}
	if e = a.act(w.ID, "seen", "obsolete"); e == nil {
		t.Fatal("stale receipt")
	}
	if e = a.act(w.ID, "seen", sig); e != nil {
		t.Fatal(e)
	}
	a, e = Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	a.now = func() time.Time { return now }
	if get(w.ID).Seen != sig {
		t.Fatal("receipt lost on restart")
	}
	if e = a.act(w.ID, "done", ""); e != nil {
		t.Fatal(e)
	}
	if get(w.ID).Signal != "" {
		t.Fatal("closed item still active")
	}
}
func TestInputAndHTTP(t *testing.T) {
	a, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	m := http.NewServeMux()
	a.Mount(m, Host{Authorized: func(r *http.Request) bool { return r.Header.Get("X-Test") == "ok" }, Classic: func(http.ResponseWriter, *http.Request) {}})
	for _, p := range []string{"/api/life/items", "/api/life/art/bogus", "/api/life/push"} {
		w := httptest.NewRecorder()
		m.ServeHTTP(w, httptest.NewRequest("GET", p, nil))
		if w.Code != 401 {
			t.Fatal(p, w.Code)
		}
	}
	w := httptest.NewRecorder()
	m.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "life-ui.js") {
		t.Fatal("home")
	}
	in := Input{ID: id(), Kind: "save", Text: "poster", Photo: "data:image/png;base64,SGVsbG8="}
	if _, e = a.add(in); e == nil {
		t.Fatal("accepted fake image")
	}
	in.Photo = ""
	first, e := a.add(in)
	if e != nil {
		t.Fatal(e)
	}
	again, e := a.add(in)
	if e != nil || first.ID != again.ID || len(a.state.Items) != 1 {
		t.Fatal("duplicate")
	}
	if _, ok := pushURL("https://127.0.0.1/"); ok {
		t.Fatal("invalid endpoint")
	}
}
