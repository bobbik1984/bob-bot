package life

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// PushSubscription mirrors PushSubscription.toJSON(). The browser is authoritative
// for transport keys; notification previews are an independent device preference.
type PushSubscription struct {
	Endpoint       string   `json:"endpoint"`
	ExpirationTime *int64   `json:"expirationTime,omitempty"`
	Keys           PushKeys `json:"keys"`
}
type pushDevice struct {
	PushSubscription
	Expired bool `json:"expired,omitempty"`
	Preview bool `json:"preview,omitempty"`
}
type pushRegistry struct {
	Origin  string `json:",omitempty"`
	Version int
	Key     string
	Devices map[string]pushDevice
}
type PushService struct {
	origin string // immutable contact and deployment identity for this process

	mu     sync.Mutex
	file   string
	state  pushRegistry
	client *http.Client
}

func openPush(dir string, old store) (*PushService, error) {
	p := &PushService{file: filepath.Join(dir, "push.json"), client: pushClient}
	b, err := os.ReadFile(p.file)
	if err == nil {
		if err = json.Unmarshal(b, &p.state); err != nil {
			return nil, err
		}
		if p.state.Version != 1 || p.state.Devices == nil {
			return nil, errors.New("invalid push registry; restore push.json")
		}
		if _, err = pushPrivate(p.state.Key); err != nil {
			return nil, errors.New("invalid persisted VAPID key")
		}
		if old.Key != "" && old.Key != p.state.Key {
			return nil, errors.New("VAPID identity mismatch; restore matching backup")
		}
		if publicOrigin != "" && p.state.Origin != "" && p.state.Origin != publicOrigin {
			return nil, errors.New("push origin differs from the installed origin")
		}
		if p.state.Origin == "" && publicOrigin != "" {
			next := p.copy()
			next.Origin = publicOrigin
			if err = p.save(next); err != nil {
				return nil, err
			}
		}
		p.origin = p.state.Origin
		return p, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	if old.PushInitialized {
		return nil, errors.New("persisted push registry missing; restore push.json")
	}
	key := old.Key
	if key == "" {
		if len(old.Subs) > 0 {
			return nil, errors.New("legacy VAPID key missing")
		}
		key, err = makePushKey()
		if err != nil {
			return nil, err
		}
	}
	if _, err = pushPrivate(key); err != nil {
		return nil, err
	}
	p.origin = publicOrigin
	next := pushRegistry{Origin: publicOrigin, Version: 1, Key: key, Devices: map[string]pushDevice{}}
	for endpoint := range old.Subs {
		if _, ok := pushURL(endpoint); ok {
			next.Devices[endpoint] = pushDevice{PushSubscription: PushSubscription{Endpoint: endpoint}}
		}
	}
	// Publish a complete first registry without overwriting a concurrent initializer.
	tmp, err := os.CreateTemp(dir, ".push-init-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	err = json.NewEncoder(tmp).Encode(next)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	if err = os.Link(tmp.Name(), p.file); os.IsExist(err) {
		return openPush(dir, old)
	}
	if err != nil {
		return nil, err
	}
	p.state = next
	return p, nil
}

func (p *PushService) save(next pushRegistry) error {
	data, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err = atomicWrite(p.file, data); err != nil {
		return err
	}
	p.state = next
	return nil
}
func (p *PushService) copy() pushRegistry {
	next := p.state
	next.Devices = make(map[string]pushDevice, len(p.state.Devices))
	for k, v := range p.state.Devices {
		next.Devices[k] = v
	}
	return next
}
func (p *PushService) device(endpoint string) (pushDevice, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	d, ok := p.state.Devices[endpoint]
	return d, ok
}
func (p *PushService) endpoints() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, 0, len(p.state.Devices))
	for endpoint, d := range p.state.Devices {
		if !d.Expired {
			out = append(out, endpoint)
		}
	}
	return out
}
func (p *PushService) secret() string { p.mu.Lock(); defer p.mu.Unlock(); return p.state.Key }
func (p *PushService) publicKey() (string, error) {
	priv, err := pushPrivate(p.secret())
	if err != nil {
		return "", err
	}
	pub, err := priv.ECDH()
	if err != nil {
		return "", err
	}
	return web64.EncodeToString(pub.PublicKey().Bytes()), nil
}
func sameExpiry(a, b *int64) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }

func (p *PushService) sync(sub PushSubscription, previous string, preview *bool) (pushDevice, error) {
	if _, ok := pushURL(sub.Endpoint); !ok {
		return pushDevice{}, errors.New("pushHost")
	}
	if sub.Keys != (PushKeys{}) {
		if _, _, err := sub.Keys.decode(); err != nil {
			return pushDevice{}, errors.New("invalid")
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	old, exists := p.state.Devices[sub.Endpoint]
	prior, rotate := p.state.Devices[previous]
	rotate = rotate && previous != sub.Endpoint
	if exists && old.Expired && (sub.Keys == (PushKeys{}) || old.Keys == sub.Keys) {
		return pushDevice{}, errors.New("expired")
	}
	d := old
	d.Expired = false
	if rotate && !exists {
		d.Preview = prior.Preview
	}
	// An older UI may still send only Endpoint. Never downgrade its newer keys.
	if sub.Keys != (PushKeys{}) || !exists {
		d.PushSubscription = sub
	}
	if preview != nil {
		d.Preview = *preview
	}
	if exists && !rotate && d.Keys == old.Keys && d.Preview == old.Preview && sameExpiry(d.ExpirationTime, old.ExpirationTime) {
		return d, nil
	}
	next := p.copy()
	if rotate {
		delete(next.Devices, previous)
	}
	next.Devices[sub.Endpoint] = d
	if err := p.save(next); err != nil {
		return pushDevice{}, errors.New("storage")
	}
	return d, nil
}
func (p *PushService) remove(endpoint string, sent *pushDevice) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	d, ok := p.state.Devices[endpoint]
	if !ok || sent != nil && d.Keys != sent.Keys {
		return nil
	}
	next := p.copy()
	if sent == nil {
		delete(next.Devices, endpoint)
	} else {
		d.Expired = true
		next.Devices[endpoint] = d
	}
	return p.save(next)
}

// Send delivers a notification to every registered device. Privacy is evaluated per
// device. A nil error means that its push service accepted the request.
func (p *PushService) Send(ctx context.Context, msg PushMessage) error {
	targets := p.endpoints()
	if len(targets) == 0 {
		return errors.New("no push devices")
	}
	var failures []error
	for _, endpoint := range targets {
		if err := p.SendTo(ctx, endpoint, msg); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
func (p *PushService) SendTo(ctx context.Context, endpoint string, msg PushMessage) error {
	return p.sendTo(ctx, endpoint, msg, false)
}
