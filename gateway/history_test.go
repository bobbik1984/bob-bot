package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestHistoryListsMostRecentlyActiveConversationFirst(t *testing.T) {
	original := conversations
	t.Cleanup(func() { conversations = original })
	conversations = map[string]*Conversation{
		"resumed": {ID: "resumed", CreatedAt: 10, Events: []Event{{At: 11000}, {At: 25400}}},
		"empty":   {ID: "empty", CreatedAt: 20},
		"older":   {ID: "older", CreatedAt: 12},
	}

	response := httptest.NewRecorder()
	handleListConversations(response, httptest.NewRequest("GET", "/api/conversations", nil))
	var body struct {
		Items []struct {
			ID        string `json:"id"`
			CreatedAt int64  `json:"created_at"`
			UpdatedAt int64  `json:"updatedAt"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 3 {
		t.Fatalf("history has %d entries, want 3", len(body.Items))
	}
	for i, want := range []struct {
		id                   string
		createdAt, updatedAt int64
	}{{"resumed", 10, 25400}, {"empty", 20, 20000}, {"older", 12, 12000}} {
		got := body.Items[i]
		if got.ID != want.id || got.CreatedAt != want.createdAt || got.UpdatedAt != want.updatedAt {
			t.Errorf("history[%d] = %+v, want %+v", i, got, want)
		}
	}
}
