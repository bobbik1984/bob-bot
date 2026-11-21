package life

import (
	"testing"
	"time"
)

func TestAreaMatch(t *testing.T) {
	for _, tc := range []struct {
		wish, plan Item
		want       bool
	}{
		{Item{Place: "西岸美术馆"}, Item{Place: "上海西岸"}, true},
		{Item{Place: "West Bund"}, Item{Place: " west BUND "}, true},
		{Item{Place: "龙美术馆", City: "上海市", Area: "西岸"}, Item{Place: "上海西岸"}, true},
		{Item{Place: "A馆", City: "上海", Area: "西岸"}, Item{Place: "B街", City: "上海市", Area: "西岸"}, true},
		{Item{Place: "西岸美术馆", City: "上海"}, Item{Place: "杭州市西岸"}, false},
		{Item{Place: "中山路", City: "广州"}, Item{Place: "中山路", City: "厦门"}, false},
		{Item{Place: "西岸美术馆"}, Item{Place: "西岸博物馆"}, false},
		{Item{Place: "西岸新区"}, Item{Place: "上海西岸"}, false},
		{Item{}, Item{}, false},
	} {
		if got := samePlace(placeOf(tc.wish), placeOf(tc.plan)); got != tc.want {
			t.Errorf("%v / %v: got %v", tc.wish, tc.plan, got)
		}
		if got := samePlace(placeOf(tc.plan), placeOf(tc.wish)); got != tc.want {
			t.Errorf("asymmetric match for %s", tc.wish.Place)
		}
	}
}

func TestNeighborhoodPersistsAndTriggers(t *testing.T) {
	dir := t.TempDir()
	a, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	wish, err := a.add(Input{ID: id(), Kind: "wish", Text: "看展", Place: "龙美术馆", City: "上海", Area: "西岸"})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := a.add(Input{ID: id(), Kind: "plan", Text: "聚餐", Place: "上海西岸", At: time.Now().Add(time.Hour).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	a, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := a.list()
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range items {
		if i.ID == wish.ID && i.Related == plan.ID && i.Area == "西岸" {
			return
		}
	}
	t.Fatal("missing persisted opportunity")
}

func TestNoNeighborhoodReminderAcrossAmbiguousCities(t *testing.T) {
	now := time.Now()
	wish := Item{Kind: "wish", Status: "open", Place: "西岸美术馆"}
	plans := []Item{
		{ID: "sh", Kind: "plan", Status: "open", Place: "上海西岸", At: now.Add(time.Hour).UnixMilli()},
		{ID: "hz", Kind: "plan", Status: "open", Place: "杭州市西岸", At: now.Add(2 * time.Hour).UnixMilli()},
	}
	if signal, _ := match(wish, plans, now); signal != "" {
		t.Fatal("ambiguous city matched")
	}
	wish.City = "上海"
	if _, id := match(wish, plans, now); id != "sh" {
		t.Fatal("explicit city was not used")
	}
}
