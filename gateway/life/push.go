package life

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var publicOrigin string // Set by the release builder from the registered public endpoint.
var web64 = base64.RawURLEncoding

func makePushKey() (string, error) {
	k, e := ecdh.P256().GenerateKey(rand.Reader)
	if e != nil {
		return "", e
	}
	return web64.EncodeToString(k.Bytes()), nil
}
func pushPrivate(s string) (*ecdsa.PrivateKey, error) {
	raw, e := web64.DecodeString(s)
	if e != nil {
		return nil, e
	}
	k, e := ecdh.P256().NewPrivateKey(raw)
	if e != nil {
		return nil, e
	}
	pub := k.PublicKey().Bytes()
	x, y := elliptic.Unmarshal(elliptic.P256(), pub)
	key := new(ecdsa.PrivateKey)
	key.Curve = elliptic.P256()
	key.X, key.Y = x, y
	key.D = new(big.Int).SetBytes(raw)
	return key, nil
}
func pushURL(s string) (*url.URL, bool) {
	u, e := url.Parse(s)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" || len(s) > 3000 {
		return nil, false
	}
	h := strings.ToLower(u.Hostname())
	ok := h == "fcm.googleapis.com" || strings.HasSuffix(h, ".push.apple.com") || h == "updates.push.services.mozilla.com" || strings.HasSuffix(h, ".push.services.mozilla.com") || strings.HasSuffix(h, ".notify.windows.com")
	return u, ok
}

var pushClient = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (p *PushService) post(ctx context.Context, endpoint string, payload []byte) (int, error) {
	u, ok := pushURL(endpoint)
	if !ok {
		return 400, fmt.Errorf("unsupported push endpoint")
	}
	priv, e := pushPrivate(p.secret())
	if e != nil {
		return 0, e
	}
	claims := map[string]any{"aud": "https://" + u.Host, "exp": time.Now().Add(time.Hour).Unix()}
	if p.origin != "" {
		claims["sub"] = p.origin
	}
	claim, _ := json.Marshal(claims)
	unsigned := web64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`)) + "." + web64.EncodeToString(claim)
	h := sha256.Sum256([]byte(unsigned))
	r, s, e := ecdsa.Sign(rand.Reader, priv, h[:])
	if e != nil {
		return 0, e
	}
	sig := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	key := elliptic.Marshal(elliptic.P256(), priv.X, priv.Y)
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(payload))
	if e != nil {
		return 0, e
	}
	req.Header.Set("Authorization", "vapid t="+unsigned+"."+web64.EncodeToString(sig)+", k="+web64.EncodeToString(key))
	req.Header.Set("TTL", "1800")
	if len(payload) > 0 {
		req.Header.Set("Content-Encoding", "aes128gcm")
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	res, e := p.client.Do(req)
	if e != nil {
		return 0, e
	}
	defer res.Body.Close()
	return res.StatusCode, nil
}

// PushMessage is the detailed notification shown on devices that opted in.
type PushMessage struct {
	Title string `json:"title,omitempty"`
	Body  string `json:"body,omitempty"`
	Tag   string `json:"tag,omitempty"`
	URL   string `json:"url,omitempty"`
}

func (p *PushService) sendTo(ctx context.Context, endpoint string, msg PushMessage, test bool) error {
	d, ok := p.device(endpoint)
	if !ok {
		return errors.New("missing")
	}
	if d.Expired {
		return errors.New("expired")
	}
	var payload []byte
	if d.Keys != (PushKeys{}) {
		var content any = map[string]string{"kind": "reminder"}
		if test {
			content = map[string]string{"kind": "test"}
		} else if strings.HasPrefix(msg.URL, "/task/") && fileID(strings.TrimPrefix(msg.URL, "/task/")) {
			// Keep private content off the lock screen while preserving the receipt destination.
			content = map[string]string{"kind": "intake", "url": msg.URL, "tag": msg.Tag}
		} else if d.Preview {
			if msg.URL != "" {
				u, err := url.Parse(msg.URL)
				if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(msg.URL, "/") || strings.HasPrefix(msg.URL, "//") || strings.ContainsRune(msg.URL, '\\') {
					return errors.New("invalid")
				}
			}
			content = msg
		}
		raw, err := json.Marshal(content)
		if err != nil || len(raw) > maxPushPlaintext {
			return errors.New("invalid")
		}
		payload, err = encryptPush(d.Keys, raw)
		if err != nil {
			return errors.New("pushFailed")
		}
	} else if test {
		return errors.New("pushKeys")
	}
	code, err := p.post(ctx, endpoint, payload)
	if err != nil {
		return errors.New("pushFailed")
	}
	if code == 404 || code == 410 {
		if err = p.remove(endpoint, &d); err != nil {
			return errors.New("storage")
		}
		return errors.New("expired")
	}
	if code < 200 || code >= 300 {
		return errors.New("pushFailed")
	}
	return nil
}
func (a *App) tick(ctx context.Context) {
	a.mu.Lock()
	next := a.copy()
	if refresh(&next, a.now()) {
		if a.save(next) != nil {
			a.mu.Unlock()
			return
		}
	}
	a.mu.Unlock()
	// Store one receipt per device + item, so resolving a second item never replays the first.
	for _, endpoint := range a.Push.endpoints() {
		for _, i := range next.Items {
			if i.Signal == "" || i.Seen == i.Signal {
				continue
			}
			receipt := endpoint + "\n" + i.ID
			if next.Subs[receipt] == i.Signal {
				continue
			}
			msg := PushMessage{Title: "Bob", Body: i.Text, Tag: i.ID, URL: "/#attention"}
			// Bound user text before serializing; keep every notification inside one record.
			if runes := []rune(msg.Body); len(runes) > 240 {
				msg.Body = string(runes[:240])
			}
			if err := a.Push.SendTo(ctx, endpoint, msg); err != nil {
				break
			}
			a.mu.Lock()
			s := a.copy()
			s.Subs[receipt] = i.Signal
			err := a.save(s)
			a.mu.Unlock()
			if err != nil {
				break
			}
		}
	}
}
