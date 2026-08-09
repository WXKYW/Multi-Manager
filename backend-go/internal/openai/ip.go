package openai

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// resolveClientIP 返回调用网关的客户端 IP：
// 仅当直连地址属于受信代理网关时才会采信 X-Forwarded-For / X-Real-IP，
// 防止伪造代理头。逻辑与 apikeys.requestIP 保持一致。
func (s *Service) resolveClientIP(r *http.Request) string {
	direct := ""
	if host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr)); err == nil {
		direct = host
	} else if r.RemoteAddr != "" {
		direct = strings.Trim(strings.TrimSpace(r.RemoteAddr), "[]")
	}
	if direct == "" {
		return ""
	}
	ip := net.ParseIP(direct)
	trusted := false
	if ip != nil {
		if isTrustedProxy(ip, s.cfg.TrustedProxyCIDRs) {
			trusted = true
		} else if !s.cfg.IsProduction() && ip.IsLoopback() {
			trusted = true
		}
	}
	if trusted {
		if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
			candidate := strings.TrimSpace(strings.Split(forwarded, ",")[0])
			if parsed := net.ParseIP(candidate); parsed != nil {
				return parsed.String()
			}
		}
		if candidate := strings.TrimSpace(r.Header.Get("X-Real-IP")); candidate != "" {
			if parsed := net.ParseIP(candidate); parsed != nil {
				return parsed.String()
			}
		}
	}
	return direct
}

func isTrustedProxy(ip net.IP, entries []string) bool {
	if ip == nil {
		return false
	}
	for _, entry := range entries {
		if _, network, err := net.ParseCIDR(entry); err == nil && network.Contains(ip) {
			return true
		}
		if candidate := net.ParseIP(entry); candidate != nil && candidate.Equal(ip) {
			return true
		}
	}
	return false
}

type upstreamIPEntry struct {
	ip        string
	expiresAt time.Time
}

var upstreamIPCache = struct {
	sync.Mutex
	entries map[string]upstreamIPEntry
}{entries: make(map[string]upstreamIPEntry)}

// resolveUpstreamIP 解析上游主机名对应的 IPv4 地址，带 10 秒本地缓存，
// 避免每个代理请求都触发 DNS。
func resolveUpstreamIP(ctx context.Context, rawHost string) string {
	host := rawHost
	if h, _, err := net.SplitHostPort(strings.TrimSpace(rawHost)); err == nil {
		host = h
	} else {
		host = strings.Trim(strings.TrimSpace(rawHost), "[]")
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return ""
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}

	upstreamIPCache.Lock()
	entry, ok := upstreamIPCache.entries[host]
	upstreamIPCache.Unlock()
	if ok && time.Now().Before(entry.expiresAt) {
		return entry.ip
	}

	resolveCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupHost(resolveCtx, host)
	ip := ""
	if err == nil {
		for _, a := range addrs {
			if parsed := net.ParseIP(a); parsed != nil && parsed.To4() != nil {
				ip = parsed.String()
				break
			}
		}
	}

	upstreamIPCache.Lock()
	upstreamIPCache.entries[host] = upstreamIPEntry{ip: ip, expiresAt: time.Now().Add(10 * time.Second)}
	upstreamIPCache.Unlock()
	return ip
}