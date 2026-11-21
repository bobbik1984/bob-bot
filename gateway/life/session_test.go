package life

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestPersistentSessionSecret(t *testing.T) {
	dir := t.TempDir()
	var wg sync.WaitGroup
	keys := make([]string, 8)
	for i := range keys {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			var err error
			keys[n], err = SessionSecret(dir)
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	for _, key := range keys {
		if len(key) != 64 || key != keys[0] {
			t.Fatal("inconsistent signing key")
		}
	}
	p := filepath.Join(dir, "session.key")
	if err := os.WriteFile(p, []byte("incomplete"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := SessionSecret(dir); err == nil {
		t.Fatal("unexpected rotation of a damaged key")
	}
}
