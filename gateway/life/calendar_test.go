package life

import (
	"path/filepath"
	"testing"
	"time"
)

func TestCalendarImport(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "life")
	a, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	at := time.Now().Add(4 * time.Hour).UnixMilli()
	wish, e := a.add(Input{ID: id(), Kind: "wish", Text: "Exhibit", Place: "West Bank"})
	if e != nil {
		t.Fatal(e)
	}
	event := calendarEvent{UID: "owned@calendar", Text: "Dinner", Place: "West Bank", At: at}
	if c, e := a.importCalendar([]calendarEvent{event}); e != nil || c.Added != 1 {
		t.Fatal(c, e)
	}
	items, _ := a.list()
	var signal string
	for _, i := range items {
		if i.ID == wish.ID {
			signal = i.Signal
		}
	}
	if signal == "" {
		t.Fatal("no matching opportunity")
	}
	if c, e := a.importCalendar([]calendarEvent{event}); e != nil || c.Unchanged != 1 {
		t.Fatal(c, e)
	}
	event.Place = "Elsewhere"
	if c, e := a.importCalendar([]calendarEvent{event}); e != nil || c.Updated != 1 {
		t.Fatal(c, e)
	}
	event.UID = "new"
	if _, e := a.importCalendar([]calendarEvent{event, {UID: "bad", Text: "Past", At: 1}}); e == nil {
		t.Fatal("partial invalid batch")
	}
	a, e = Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	items, _ = a.list()
	if len(items) != 2 {
		t.Fatal("non-atomic import")
	}
	for _, i := range items {
		if i.ID == wish.ID && i.Signal != "" {
			t.Fatal("obsolete opportunity")
		}
	}
}
