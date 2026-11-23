package life

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// Import only the user's confirmed selection. UID-derived IDs make re-imports stable.
type calendarEvent struct {
	UID, Text, Place string
	At               int64
}
type importCount struct{ Added, Updated, Unchanged int }

func (a *App) importCalendar(events []calendarEvent) (importCount, error) {
	var count importCount
	if len(events) == 0 || len(events) > 200 {
		return count, errors.New("invalid")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	s, now := a.copy(), a.now()
	byID := make(map[string]int, len(s.Items))
	for n, i := range s.Items {
		byID[i.ID] = n
	}
	for _, ev := range events {
		text, place := strings.TrimSpace(ev.Text), strings.TrimSpace(ev.Place)
		if ev.UID == "" || len(ev.UID) > 2048 || text == "" || len(text) > 4800 || len(place) > 240 || ev.At <= now.UnixMilli() || ev.At > now.AddDate(1, 0, 1).UnixMilli() {
			return importCount{}, errors.New("invalid")
		}
		digest := sha256.Sum256([]byte("ical-event\x00" + ev.UID))
		id := hex.EncodeToString(digest[:16])
		if n, ok := byID[id]; ok {
			item := &s.Items[n]
			if item.Kind != "plan" {
				return importCount{}, errors.New("stale")
			}
			if item.Status != "open" || (item.Text == text && item.Place == place && item.At == ev.At) {
				count.Unchanged++
				continue
			}
			if item.At != ev.At {
				// A changed appointment time is a new decision even at the same venue.
				for n := range s.Items {
					wish := &s.Items[n]
					if wish.Related == item.ID {
						wish.Seen = ""
						for receipt := range s.Subs {
							if strings.HasSuffix(receipt, "\n"+wish.ID) {
								delete(s.Subs, receipt)
							}
						}
					}
				}
			}
			item.Text, item.Place, item.At = text, place, ev.At
			count.Updated++
			continue
		}
		byID[id] = len(s.Items)
		s.Items = append(s.Items, Item{ID: id, Kind: "plan", Text: text, Place: place, At: ev.At, Created: now.UnixMilli(), Status: "open"})
		count.Added++
	}
	if count.Added+count.Updated > 0 {
		refresh(&s, now)
		if a.save(s) != nil {
			return importCount{}, errors.New("storage")
		}
	}
	return count, nil
}
