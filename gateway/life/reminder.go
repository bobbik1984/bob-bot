package life

import (
	"errors"
	"fmt"
	"time"
	_ "time/tzdata" // A static gateway must also recognize the phone's IANA time zone.
)

func validateRepeat(v Input) error {
	if v.Repeat == "" {
		return nil
	}
	if v.Kind != "reminder" || (v.Repeat != "daily" && v.Repeat != "weekly") || v.Zone == "" || v.Zone == "Local" {
		return errors.New("time")
	}
	if _, err := time.LoadLocation(v.Zone); err != nil {
		return errors.New("time")
	}
	return nil
}

// The signal identifies one occurrence. After downtime, only the most recent
// occurrence is delivered. Anchor recurring reminders to the owner's local clock.
func reminderSignal(i Item, now time.Time) string {
	if i.Status != "open" || i.At <= 0 || now.UnixMilli() < i.At || i.Snooze > now.UnixMilli() {
		return ""
	}
	due := time.UnixMilli(i.At)
	if i.Repeat != "" {
		zone, err := time.LoadLocation(i.Zone)
		if err != nil {
			return ""
		}
		local, first := now.In(zone), due.In(zone)
		day := local
		interval := 1
		if i.Repeat == "weekly" {
			interval = 7
			day = day.AddDate(0, 0, -(int(day.Weekday())-int(first.Weekday())+7)%7)
		}
		due = time.Date(day.Year(), day.Month(), day.Day(), first.Hour(), first.Minute(), first.Second(), first.Nanosecond(), zone)
		if due.After(now) {
			due = due.AddDate(0, 0, -interval)
		}
	}
	return fmt.Sprintf("due:%d", due.UnixMilli())
}
