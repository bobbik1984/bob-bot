package life

import "strings"

// A location keeps its display name. City and Area are optional, reviewed context.
// For old records, recognise explicit city prefixes and a venue named for its area.
type placeKey struct {
	name, city, area string
	venue            bool
}

func placeOf(item Item) placeKey {
	p := placeKey{name: norm(item.Place), city: strings.TrimSuffix(norm(item.City), "市"), area: norm(item.Area)}
	local := p.name
	if p.city != "" {
		if tail, ok := strings.CutPrefix(local, p.city); ok {
			local = strings.TrimPrefix(tail, "市")
		}
	} else {
		// Direct-administered municipalities are commonly written without 市.
		for _, prefix := range []string{"上海", "北京", "天津", "重庆"} {
			if strings.HasPrefix(local, prefix) {
				p.city = prefix
				local = strings.TrimPrefix(strings.TrimPrefix(local, prefix), "市")
				break
			}
		}
		if p.city == "" {
			city, tail, ok := strings.Cut(local, "市")
			if n := len([]rune(city)); ok && n >= 2 && n <= 8 && tail != "" {
				p.city = city
				local = tail
			}
		}
	}
	if p.area != "" || local == "" {
		return p
	}
	p.area = local
	for _, suffix := range []string{"美术馆", "博物馆", "图书馆", "体育馆", "艺术中心"} {
		if part, ok := strings.CutSuffix(local, suffix); ok {
			p.venue = true
			p.area = ""
			if len([]rune(part)) >= 2 {
				p.area = part
			}
			break
		}
	}
	return p
}

func samePlace(a, b placeKey) bool {
	if a.name == "" || b.name == "" || (a.city != "" && b.city != "" && a.city != b.city) {
		return false
	}
	if a.name == b.name {
		return true
	}
	// Two unrelated venue names sharing a stem are insufficient evidence.
	return a.area != "" && a.area == b.area && !(a.venue && b.venue)
}
