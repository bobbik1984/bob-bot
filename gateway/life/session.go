package life

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// SessionSecret returns the owner's persistent signing secret when systemd supplies only a PIN.
func SessionSecret(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "session.key")
	read := func() (string, error) {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		raw, err := hex.DecodeString(string(b))
		if err != nil || len(raw) != 32 {
			return "", fmt.Errorf("invalid session key file")
		}
		return string(b), nil
	}
	if s, err := read(); !errors.Is(err, os.ErrNotExist) {
		return s, err
	}
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	key := hex.EncodeToString(bytes[:])
	f, err := os.CreateTemp(dir, ".session-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(key); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	// Publish only a complete key; a concurrent first start keeps the winner.
	if err = os.Link(f.Name(), path); errors.Is(err, os.ErrExist) {
		return read()
	}
	if err != nil {
		return "", err
	}
	return key, nil
}
