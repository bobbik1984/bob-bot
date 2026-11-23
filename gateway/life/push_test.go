package life

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const vectorUA = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
const vectorAuth = "BTBZMqHH6r4Tts7J_aSIgg"
const testEndpoint = "https://web.push.apple.com/test-device"

func fixtureKeys() PushKeys { return PushKeys{vectorUA, vectorAuth} }
func decode64(t *testing.T, s string) []byte {
	t.Helper()
	b, e := web64.DecodeString(s)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestRFC8291Vector(t *testing.T) {
	// RFC 8291 section 5 and Appendix A. Public interoperability test material.
	sender, err := ecdh.P256().NewPrivateKey(decode64(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	data := decode64(t, "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24")
	body, err := sealPush(fixtureKeys(), data, sender, decode64(t, "DGv6ra1nlYgDCS1FRnbzlw"))
	if err != nil {
		t.Fatal(err)
	}
	wantHeader := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
	wantCipher := "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"
	if !bytes.Equal(body, append(decode64(t, wantHeader), decode64(t, wantCipher)...)) {
		t.Fatal("RFC wire vector mismatch")
	}
	max, err := encryptPush(fixtureKeys(), make([]byte, maxPushPlaintext))
	if err != nil || len(max) != 4096 {
		t.Fatal("max record", err)
	}
	if _, err = encryptPush(fixtureKeys(), make([]byte, maxPushPlaintext+1)); err == nil {
		t.Fatal("oversized payload")
	}
	for _, k := range []PushKeys{{}, {vectorUA, "AA"}, {"AA", vectorAuth}} {
		if _, err := encryptPush(k, []byte("test")); err == nil {
			t.Fatal("invalid keys accepted")
		}
	}
}

func openDevicePayload(t *testing.T, b []byte) map[string]string {
	t.Helper()
	if len(b) < 103 || binary.BigEndian.Uint32(b[16:20]) != 4096 || b[20] != 65 {
		t.Fatal("wire framing")
	}
	receiver, err := ecdh.P256().NewPrivateKey(decode64(t, "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"))
	if err != nil {
		t.Fatal(err)
	}
	sender, err := ecdh.P256().NewPublicKey(b[21:86])
	if err != nil {
		t.Fatal(err)
	}
	shared, err := receiver.ECDH(sender)
	if err != nil {
		t.Fatal(err)
	}
	info := append([]byte("WebPush: info\x00"), receiver.PublicKey().Bytes()...)
	info = append(info, sender.Bytes()...)
	ikm := mac256(mac256(decode64(t, vectorAuth), shared), append(info, 1))
	prk := mac256(b[:16], ikm)
	block, _ := aes.NewCipher(mac256(prk, []byte("Content-Encoding: aes128gcm\x00\x01"))[:16])
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, mac256(prk, []byte("Content-Encoding: nonce\x00\x01"))[:12], b[86:], nil)
	if err != nil || len(plain) < 2 || plain[len(plain)-1] != 2 {
		t.Fatal("receiver failed", err)
	}
	var msg map[string]string
	if err = json.Unmarshal(plain[:len(plain)-1], &msg); err != nil {
		t.Fatal(err)
	}
	return msg
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestPushMigrationDeliveryAndRecovery(t *testing.T) {
	dir := t.TempDir()
	key, err := makePushKey()
	if err != nil {
		t.Fatal(err)
	}
	legacy := store{Key: key, Subs: map[string]string{testEndpoint: "", testEndpoint + "\nitem": "decision"}}
	b, _ := json.Marshal(legacy)
	if err = os.WriteFile(filepath.Join(dir, "state.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	app, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if app.Push.secret() != key || app.state.Subs[testEndpoint+"\nitem"] != "decision" {
		t.Fatal("legacy identity or receipt lost")
	}
	status := 201
	var bodies [][]byte
	keyObject, _ := pushPrivate(key)
	client := &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, b)
		if len(b) > 0 && (r.Header.Get("Content-Encoding") != "aes128gcm" || r.Header.Get("Content-Type") != "application/octet-stream") {
			t.Fatal("encoding headers")
		}
		auth := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "vapid t="), ", k=")
		if len(auth) != 2 {
			t.Fatal("VAPID format")
		}
		jwt := strings.Split(auth[0], ".")
		if len(jwt) != 3 {
			t.Fatal("token")
		}
		var claim struct{ Aud string }
		if json.Unmarshal(decode64(t, jwt[1]), &claim) != nil || claim.Aud != "https://web.push.apple.com" {
			t.Fatal("audience")
		}
		digest := sha256.Sum256([]byte(jwt[0] + "." + jwt[1]))
		sig := decode64(t, jwt[2])
		pub, _ := keyObject.ECDH()
		if len(sig) != 64 || auth[1] != web64.EncodeToString(pub.PublicKey().Bytes()) || !ecdsa.Verify(&keyObject.PublicKey, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
			t.Fatal("VAPID identity changed")
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	app.Push.client = client
	ctx := context.Background()
	msg := PushMessage{"Appointment", "private contents", "private-tag", "/classic#plan"}
	if err = app.Push.Send(ctx, msg); err != nil || len(bodies) != 1 || len(bodies[0]) != 0 {
		t.Fatal("legacy wake", err)
	}
	sub := PushSubscription{Endpoint: testEndpoint, Keys: fixtureKeys()}
	if _, err = app.Push.sync(sub, "", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = app.Push.sync(PushSubscription{Endpoint: testEndpoint}, "", nil); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = app.Push.SendTo(ctx, testEndpoint, msg); err != nil {
			t.Fatal(err)
		}
	}
	if result := openDevicePayload(t, bodies[1]); len(result) != 1 || result["kind"] != "reminder" {
		t.Fatal("private lock screen leaked details")
	}
	if bytes.Equal(bodies[1][:16], bodies[2][:16]) || bytes.Equal(bodies[1][21:86], bodies[2][21:86]) {
		t.Fatal("reused salt or ECDH key")
	}
	detail := true
	if _, err = app.Push.sync(sub, "", &detail); err != nil {
		t.Fatal(err)
	}
	app, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	app.Push.client = client
	if err = app.Push.Send(ctx, msg); err != nil {
		t.Fatal(err)
	}
	if result := openDevicePayload(t, bodies[3]); result["body"] != msg.Body || result["title"] != msg.Title || result["tag"] != msg.Tag || result["url"] != msg.URL {
		t.Fatal("custom payload mismatch")
	}
	mux := http.NewServeMux()
	app.Mount(mux, Host{Authorized: func(r *http.Request) bool { return r.Header.Get("X-Test") == "ok" }, Assistant: func(http.ResponseWriter, *http.Request) {}})
	test := func(authed bool, endpoint string) int {
		w := httptest.NewRecorder()
		data, _ := json.Marshal(map[string]string{"endpoint": endpoint})
		r := httptest.NewRequest("POST", "/api/life/push/test", bytes.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		if authed {
			r.Header.Set("X-Test", "ok")
		}
		mux.ServeHTTP(w, r)
		return w.Code
	}
	if test(false, testEndpoint) != 401 || test(true, testEndpoint+"2") != 404 || test(true, testEndpoint) != 200 {
		t.Fatal("device test authorization or targeting")
	}
	if got := openDevicePayload(t, bodies[4]); got["kind"] != "test" {
		t.Fatal(got)
	}
	status = 429
	if test(true, testEndpoint) != 502 || len(app.Push.endpoints()) != 1 {
		t.Fatal("transient error lost device")
	}
	status = 410
	if test(true, testEndpoint) != 410 || len(app.Push.endpoints()) != 0 {
		t.Fatal("expired device still active")
	}
	if _, err = app.Push.sync(sub, "", nil); err == nil || err.Error() != "expired" {
		t.Fatal("resurrected expired endpoint")
	}
	sub.Endpoint += "new"
	device, err := app.Push.sync(sub, testEndpoint, nil)
	if err != nil || !device.Preview || len(app.Push.endpoints()) != 1 {
		t.Fatal("rotation lost preference", err)
	}
	if err = os.Remove(filepath.Join(dir, "push.json")); err != nil {
		t.Fatal(err)
	}
	if _, err = Open(dir); err == nil {
		t.Fatal("missing registry silently generated a replacement key")
	}
}

func TestStableInstallationAnchors(t *testing.T) {
	m := http.NewServeMux()
	MountPWA(m)
	var canonical string
	for _, path := range []string{"/life.webmanifest", "/manifest.webmanifest", "/sw.js", "/push-client.js"} {
		w := httptest.NewRecorder()
		m.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-cache" {
			t.Fatal(path, w.Code)
		}
		switch path {
		case "/life.webmanifest", "/manifest.webmanifest":
			var id struct{ ID, Scope string }
			if json.Unmarshal(w.Body.Bytes(), &id) != nil || id.ID != "/" || id.Scope != "/" {
				t.Fatal("manifest identity changed")
			}
			if canonical != "" && canonical != w.Body.String() {
				t.Fatal("split manifest identity")
			}
			canonical = w.Body.String()
		case "/sw.js":
			if !strings.Contains(w.Body.String(), "addEventListener('push',") || !strings.Contains(w.Body.String(), "addEventListener('notificationclick',") {
				t.Fatal("push worker listeners missing")
			}
		}
	}
}
func TestOriginAndIdempotentSync(t *testing.T) {
	prior := publicOrigin
	defer func() { publicOrigin = prior }()
	publicOrigin = "https://example.test"
	dir := t.TempDir()
	app, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	sub := PushSubscription{Endpoint: testEndpoint, Keys: fixtureKeys()}
	if _, err = app.Push.sync(sub, "", nil); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "push.json")
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err = os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err = app.Push.sync(sub, sub.Endpoint, nil); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil || !st.ModTime().Equal(old) {
		t.Fatal("unchanged sync rewrote the registry")
	}
	publicOrigin = ""
	next, err := Open(dir)
	if err != nil || next.Push.origin != "https://example.test" || next.Push.secret() != app.Push.secret() {
		t.Fatal("plain build lost installation identity", err)
	}
	publicOrigin = "https://other.test"
	if _, err = Open(dir); err == nil {
		t.Fatal("different production origin accepted")
	}
}
