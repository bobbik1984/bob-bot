package life

import (
	"testing"
	"time"
)

func TestReminderAfterRestartAndSnooze(t *testing.T) {
	dir := t.TempDir()
	a, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 21, 8, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }
	in := Input{ID: id(), Kind: "reminder", Text: "Pick up parcel", At: now.Add(time.Hour).UnixMilli(), Spoken: true}
	if _, err = a.add(in); err != nil {
		t.Fatal(err)
	}
	read := func() Item {
		items, e := a.list()
		if e != nil || len(items) != 1 {
			t.Fatalf("list: %v, %v", items, e)
		}
		return items[0]
	}
	if read().Signal != "" {
		t.Fatal("fired early")
	}
	now = now.Add(2 * time.Hour)
	a, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	a.now = func() time.Time { return now }
	fired := read()
	if !fired.Spoken || fired.Signal == "" {
		t.Fatal("missed while offline")
	}
	if _, err = a.add(in); err != nil {
		t.Fatal("retry after due", err)
	}
	if err = a.act(fired.ID, "later", fired.Signal); err != nil || read().Signal != "" {
		t.Fatal("snooze", err)
	}
	now = now.Add(25 * time.Hour)
	if read().Signal == "" {
		t.Fatal("lost snoozed reminder")
	}
	if err = a.act(fired.ID, "done", ""); err != nil || read().Signal != "" {
		t.Fatal("done", err)
	}
}
func TestRecurringReminderOwnerClock(t *testing.T) {
	zone, e := time.LoadLocation("America/New_York")
	if e != nil {
		t.Fatal(e)
	}
	first := time.Date(2026, 10, 30, 9, 30, 0, 0, zone)
	i := Item{Kind: "reminder", Status: "open", At: first.UnixMilli(), Repeat: "weekly", Zone: zone.String()}
	sig := reminderSignal(i, first)
	next := first.AddDate(0, 0, 7)
	if next.Sub(first) != 169*time.Hour || reminderSignal(i, next.Add(-time.Minute)) != sig || reminderSignal(i, next) == sig {
		t.Fatal("weekly wall time changed across DST")
	}
	i.Repeat = "daily"
	if reminderSignal(i, first.AddDate(0, 0, 1)) == sig {
		t.Fatal("daily occurrence suppressed")
	}
	for _, v := range []Input{{Repeat: "hourly", Kind: "reminder", Zone: "UTC"}, {Repeat: "daily", Kind: "wish", Zone: "UTC"}, {Repeat: "daily", Kind: "reminder", Zone: "unknown"}} {
		if validateRepeat(v) == nil {
			t.Fatal("accepted invalid recurrence")
		}
	}
}
