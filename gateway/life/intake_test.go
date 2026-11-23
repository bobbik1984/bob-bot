package life

import (
	"testing"
	"time"
)

func TestOwnerTaskOverridesPosterCampaign(t *testing.T) {
	draft := map[string]any{"workflow": "campaign", "confidence": 0.6, "due": "2026-11-20"}
	applyIntakeInstruction(draft, "只记待办：周五前核对海报细节。", time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC))
	if draft["workflow"] != "todo" || draft["due"] != "2026-11-27" || draft["title"] != "周五前核对海报细节。" || draft["confidence"] != 1.0 {
		t.Fatalf("unexpected draft: %#v", draft)
	}
}

func TestIntakeWeekdayAtReceipt(t *testing.T) {
	saturday := time.Date(2026, 11, 21, 17, 30, 0, 0, time.FixedZone("CST", 8*3600))
	for text, want := range map[string]string{
		"只记待办，周五前核对海报细节": "2026-11-27",
		"下周日之前核对":        "2026-11-29",
		"本星期五截止":         "2026-11-20",
		"项目说明":           "",
		"周一前确认，周五前复核":    "",
	} {
		if got := intakeWeekday(text, saturday); got != want {
			t.Errorf("%q: got %q, want %q", text, got, want)
		}
	}
}
