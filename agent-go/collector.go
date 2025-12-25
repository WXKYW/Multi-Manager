package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
)

// HostInfo 主机静态信息
type HostInfo struct {
	Platform        string   `json:"platform"`
	PlatformVersion string   `json:"platform_version"`
	CPU             []string `json:"cpu"`
	GPU             []string `json:"gpu"`
	MemTotal        uint64   `json:"mem_total"`
	DiskTotal       uint64   `json:"disk_total"`
	SwapTotal       uint64   `json:"swap_total"`
	Arch            string   `json:"arch"`
	Virtualization  string   `json:"virtualization"`
	BootTime        int64    `json:"boot_time"`
	IP              string   `json:"ip"`
	CountryCode     string   `json:"country_code"`
	AgentVersion    string   `json:"agent_version"`
}

// State 实时状态
type State struct {
	CPU            float64  `json:"cpu"`
	MemUsed        uint64   `json:"mem_used"`
	SwapUsed       uint64   `json:"swap_used"`
	DiskUsed       uint64   `json:"disk_used"`
	NetInTransfer  uint64   `json:"net_in_transfer"`
	NetOutTransfer uint64   `json:"net_out_transfer"`
	NetInSpeed     uint64   `json:"net_in_speed"`
	NetOutSpeed    uint64   `json:"net_out_speed"`
	Uptime         uint64   `json:"uptime"`
	Load1          float64  `json:"load1"`
	Load5          float64  `json:"load5"`
	Load15         float64  `json:"load15"`
	TcpConnCount   int      `json:"tcp_conn_count"`
	UdpConnCount   int      `json:"udp_conn_count"`
	ProcessCount   int      `json:"process_count"`
	Temperatures   []string `json:"temperatures"`
	GPU            float64  `json:"gpu"`
}

// Collector 数据采集器
type Collector struct {
	mu             sync.Mutex
	cachedHostInfo *HostInfo
	cachedDiskUsed uint64

	// 网络流量缓存
	lastNetRx   uint64
	lastNetTx   uint64
	lastNetTime time.Time
}

// NewCollector 创建采集器
func NewCollector() *Collector {
	return &Collector{
		lastNetTime: time.Now(),
	}
}

// CollectHostInfo 采集主机静态信息 (变化慢，10分钟采集一次)
func (c *Collector) CollectHostInfo() *HostInfo {
	c.mu.Lock()
	defer c.mu.Unlock()

	info := &HostInfo{
		Platform:     runtime.GOOS,
		Arch:         runtime.GOARCH,
		AgentVersion: VERSION,
	}

	// 平台信息
	if hostInfo, err := host.Info(); err == nil {
		info.Platform = hostInfo.Platform
		info.PlatformVersion = fmt.Sprintf("%s %s", hostInfo.PlatformFamily, hostInfo.PlatformVersion)
		info.BootTime = int64(hostInfo.BootTime)
		info.Virtualization = hostInfo.VirtualizationSystem
	}

	// CPU 信息
	if cpuInfo, err := cpu.Info(); err == nil && len(cpuInfo) > 0 {
		cpuDesc := fmt.Sprintf("%s %s %d Core(s)", cpuInfo[0].VendorID, cpuInfo[0].ModelName, cpuInfo[0].Cores)
		info.CPU = []string{strings.TrimSpace(cpuDesc)}
	} else {
		info.CPU = []string{fmt.Sprintf("Unknown CPU %d Core(s)", runtime.NumCPU())}
	}

	// 内存信息
	if memInfo, err := mem.VirtualMemory(); err == nil {
		info.MemTotal = memInfo.Total
	}

	// Swap 信息
	if swapInfo, err := mem.SwapMemory(); err == nil {
		info.SwapTotal = swapInfo.Total
	}

	// 磁盘信息
	if partitions, err := disk.Partitions(false); err == nil {
		var totalSize uint64
		for _, p := range partitions {
			if usage, err := disk.Usage(p.Mountpoint); err == nil {
				totalSize += usage.Total
			}
		}
		info.DiskTotal = totalSize
	}

	// 公网 IP
	info.IP = getPublicIP()

	// GPU (暂不实现)
	info.GPU = []string{}

	c.cachedHostInfo = info
	return info
}

// CollectState 采集实时状态 (变化快，1-2秒采集一次)
func (c *Collector) CollectState() *State {
	state := &State{
		Temperatures: []string{},
	}

	// CPU 使用率
	if cpuPercent, err := cpu.Percent(0, false); err == nil && len(cpuPercent) > 0 {
		state.CPU = cpuPercent[0]
	}

	// 内存
	if memInfo, err := mem.VirtualMemory(); err == nil {
		state.MemUsed = memInfo.Used
	}

	// Swap
	if swapInfo, err := mem.SwapMemory(); err == nil {
		state.SwapUsed = swapInfo.Used
	}

	// 磁盘使用 (异步更新缓存)
	go func() {
		if partitions, err := disk.Partitions(false); err == nil {
			var usedSize uint64
			for _, p := range partitions {
				if usage, err := disk.Usage(p.Mountpoint); err == nil {
					usedSize += usage.Used
				}
			}
			c.mu.Lock()
			c.cachedDiskUsed = usedSize
			c.mu.Unlock()
		}
	}()
	c.mu.Lock()
	state.DiskUsed = c.cachedDiskUsed
	c.mu.Unlock()

	// 网络流量
	if netIO, err := net.IOCounters(false); err == nil && len(netIO) > 0 {
		state.NetInTransfer = netIO[0].BytesRecv
		state.NetOutTransfer = netIO[0].BytesSent

		// 计算速度
		c.mu.Lock()
		now := time.Now()
		elapsed := now.Sub(c.lastNetTime).Seconds()
		if elapsed > 0 && c.lastNetTime.Unix() > 0 {
			if netIO[0].BytesRecv >= c.lastNetRx {
				state.NetInSpeed = uint64(float64(netIO[0].BytesRecv-c.lastNetRx) / elapsed)
			}
			if netIO[0].BytesSent >= c.lastNetTx {
				state.NetOutSpeed = uint64(float64(netIO[0].BytesSent-c.lastNetTx) / elapsed)
			}
		}
		c.lastNetRx = netIO[0].BytesRecv
		c.lastNetTx = netIO[0].BytesSent
		c.lastNetTime = now
		c.mu.Unlock()
	}

	// 运行时长
	if hostInfo, err := host.Info(); err == nil {
		state.Uptime = hostInfo.Uptime
	}

	// 负载 (Windows 不支持，使用 CPU 模拟)
	if runtime.GOOS != "windows" {
		if loadAvg, err := load.Avg(); err == nil {
			state.Load1 = loadAvg.Load1
			state.Load5 = loadAvg.Load5
			state.Load15 = loadAvg.Load15
		}
	} else {
		// Windows: 使用 CPU 使用率模拟
		cpuCount := float64(runtime.NumCPU())
		state.Load1 = state.CPU / 100 * cpuCount
		state.Load5 = state.Load1
		state.Load15 = state.Load1
	}

	// TCP/UDP 连接数
	if conns, err := net.Connections("all"); err == nil {
		for _, conn := range conns {
			switch conn.Type {
			case 1: // TCP
				state.TcpConnCount++
			case 2: // UDP
				state.UdpConnCount++
			}
		}
	}

	return state
}

// getPublicIP 获取公网 IP
func getPublicIP() string {
	endpoints := []string{
		"https://api.ipify.org",
		"https://icanhazip.com",
		"http://ip.sb",
	}

	client := &http.Client{Timeout: 5 * time.Second}

	for _, endpoint := range endpoints {
		resp, err := client.Get(endpoint)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			continue
		}

		ip := strings.TrimSpace(string(body))
		if ip != "" {
			return ip
		}
	}

	return ""
}

// GetHostname 获取主机名
func GetHostname() string {
	hostname, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return hostname
}
