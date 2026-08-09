package openai

import (
	"net"
	"net/http"
	"net/url"
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

type egressEntry struct {
	ip        string
	expiresAt time.Time
}

// egressIPCache 缓存本机出口 IP，1 分钟内不重复探测，避免热路径反复拨号。
var egressIPCache = struct {
	sync.Mutex
	entry egressEntry
}{}

// egressOutboundIP 返回本机可用的出口 IP（用于直连场景下的出口标识）。
// 通过无数据 UDP 拨号探测默认路由，探测一次本地缓存。
func egressOutboundIP() string {
	egressIPCache.Lock()
	defer egressIPCache.Unlock()
	now := time.Now()
	if egressIPCache.entry.ip != "" && now.Before(egressIPCache.entry.expiresAt) {
		return egressIPCache.entry.ip
	}
	ip := ""
	if conn, err := net.DialTimeout("udp", "8.8.8.8:80", 2*time.Second); err == nil {
		if local, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			ip = local.IP.String()
		}
		conn.Close()
	}
	egressIPCache.entry = egressEntry{ip: ip, expiresAt: now.Add(60 * time.Second)}
	return ip
}

// egressOutbound 返回本机出口 IP（Service 便捷封装）。
func (s *Service) egressOutbound() string {
	return egressOutboundIP()
}

// proxyEndpointAddr 从代理字符串中提取出外连接地址（host:port），用于在网关日志
// 中标识"本次请求实际走了哪个代理出口"。兼容 socks://user:pass@host:port 形式。
func proxyEndpointAddr(proxy string) string {
	if proxy == "" {
		return ""
	}
	u, err := url.Parse(proxy)
	if err != nil {
		return proxy
	}
	if u.Host == "" {
		return proxy
	}
	return u.Host
}
