package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
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
	Cores           int      `json:"cores"`
	GPU             []string `json:"gpu"`
	GPUMemTotal     uint64   `json:"gpu_mem_total"`
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

// DockerContainer 容器信息
type DockerContainer struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Image   string `json:"image"`
	Status  string `json:"status"`
	Created string `json:"created"`
}

// DockerInfo Docker 信息
type DockerInfo struct {
	Installed  bool              `json:"installed"`
	Running    int               `json:"running"`
	Stopped    int               `json:"stopped"`
	Containers []DockerContainer `json:"containers"`
}

// State 实时状态
type State struct {
	CPU            float64    `json:"cpu"`
	MemUsed        uint64     `json:"mem_used"`
	SwapUsed       uint64     `json:"swap_used"`
	DiskUsed       uint64     `json:"disk_used"`
	NetInTransfer  uint64     `json:"net_in_transfer"`
	NetOutTransfer uint64     `json:"net_out_transfer"`
	NetInSpeed     uint64     `json:"net_in_speed"`
	NetOutSpeed    uint64     `json:"net_out_speed"`
	Uptime         uint64     `json:"uptime"`
	Load1          float64    `json:"load1"`
	Load5          float64    `json:"load5"`
	Load15         float64    `json:"load15"`
	TcpConnCount   int        `json:"tcp_conn_count"`
	UdpConnCount   int        `json:"udp_conn_count"`
	ProcessCount   int        `json:"process_count"`
	Temperatures   []string   `json:"temperatures"`
	GPU            float64    `json:"gpu"`
	GPUMemUsed     uint64     `json:"gpu_mem_used"`
	GPUPower       float64    `json:"gpu_power"`
	Docker         DockerInfo `json:"docker"`
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

	// GPU 采集缓存 (节流: 每5秒采集一次)
	lastGPUUsage   float64
	lastGPUMemUsed uint64
	lastGPUPower   float64
	lastGPUTime    time.Time
}

// NewCollector 创建采集器
func NewCollector() *Collector {
	return &Collector{
		lastNetTime: time.Now(),
		lastGPUTime: time.Now(),
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
	logicalCores, _ := cpu.Counts(true)
	if logicalCores == 0 {
		logicalCores = runtime.NumCPU()
	}

	if cpuInfo, err := cpu.Info(); err == nil && len(cpuInfo) > 0 {
		cpuDesc := fmt.Sprintf("%s %s %d Core(s)", cpuInfo[0].VendorID, cpuInfo[0].ModelName, logicalCores)
		info.CPU = []string{strings.TrimSpace(cpuDesc)}
	} else {
		info.CPU = []string{fmt.Sprintf("Unknown CPU %d Core(s)", logicalCores)}
	}
	info.Cores = logicalCores
	fmt.Printf("[Collector] Detected %d cores, Platform: %s\n", logicalCores, info.Platform)

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

	// GPU
	gpuModels, gpuMemTotal := c.collectGPUMetadata()
	info.GPU = gpuModels
	info.GPUMemTotal = gpuMemTotal

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

	// Docker 信息采集
	state.Docker = c.collectDockerInfo()
	
	// GPU 使用率、显存与功耗采集 (节流: 每5秒实际采集一次)
	if time.Since(c.lastGPUTime) > 5*time.Second {
		gpuUsage, gpuMemUsed, gpuPower := c.collectGPUState()
		c.lastGPUUsage = gpuUsage
		c.lastGPUMemUsed = gpuMemUsed
		c.lastGPUPower = gpuPower
		c.lastGPUTime = time.Now()
	}
	state.GPU = c.lastGPUUsage
	state.GPUMemUsed = c.lastGPUMemUsed
	state.GPUPower = c.lastGPUPower

	return state
}

// collectDockerInfo 采集 Docker 容器信息
func (c *Collector) collectDockerInfo() DockerInfo {
	info := DockerInfo{
		Installed:  false,
		Running:    0,
		Stopped:    0,
		Containers: []DockerContainer{},
	}

	// 检查 Docker 是否可用
	if _, err := exec.LookPath("docker"); err != nil {
		return info
	}

	// 尝试执行 docker ps 命令
	cmd := exec.Command("docker", "ps", "-a", "--format", "{{json .}}")
	hideWindow(cmd)
	output, err := cmd.Output()
	if err != nil {
		// Docker 可能已安装但无权限或未运行
		return info
	}

	info.Installed = true

	// 解析容器列表
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		var container struct {
			ID      string `json:"ID"`
			Names   string `json:"Names"`
			Image   string `json:"Image"`
			State   string `json:"State"`
			Status  string `json:"Status"`
			Created string `json:"CreatedAt"`
		}

		if err := json.Unmarshal([]byte(line), &container); err != nil {
			continue
		}

		dc := DockerContainer{
			ID:      container.ID[:12], // 短 ID
			Name:    container.Names,
			Image:   container.Image,
			Status:  container.Status,
			Created: container.Created,
		}

		info.Containers = append(info.Containers, dc)

		// 统计运行/停止状态
		if container.State == "running" {
			info.Running++
		} else {
			info.Stopped++
		}
	}

	return info
}

// getPublicIP 获取公网 IP
func getPublicIP() string {
	endpoints := []string{
		"http://ip.sb",
		"https://api.ipify.org",
		"https://icanhazip.com",
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

// collectGPUMetadata 采集 GPU 型号和显存总量
func (c *Collector) collectGPUMetadata() ([]string, uint64) {
	nvidiaSmi := c.getNvidiaSmiPath()
	if nvidiaSmi == "" {
		return []string{}, 0
	}

	// 获取型号和显存总量
	cmd := exec.Command(nvidiaSmi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits")
	hideWindow(cmd)
	output, err := cmd.Output()
	if err != nil {
		return []string{}, 0
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	var models []string
	var totalMem uint64

	for _, line := range lines {
		parts := strings.Split(line, ",")
		if len(parts) >= 2 {
			models = append(models, strings.TrimSpace(parts[0]))
			mem, _ := strconv.ParseUint(strings.TrimSpace(parts[1]), 10, 64)
			totalMem += mem * 1024 * 1024 // MiB 转为 Bytes
		}
	}
	return models, totalMem
}

// collectGPUState 采集 GPU 使用率、显存占用和功耗 (带超时保护)
func (c *Collector) collectGPUState() (float64, uint64, float64) {
	nvidiaSmi := c.getNvidiaSmiPath()
	if nvidiaSmi == "" {
		return 0, 0, 0
	}

	// 使用 context 添加超时保护 (2秒)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// 获取使用率、显存已用量和功耗
	cmd := exec.CommandContext(ctx, nvidiaSmi, "--query-gpu=utilization.gpu,memory.used,power.draw", "--format=csv,noheader,nounits")
	hideWindow(cmd)
	output, err := cmd.Output()
	if err != nil {
		// 超时或其他错误，静默返回 0
		return 0, 0, 0
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 0 {
		return 0, 0, 0
	}

	var totalUsage float64
	var totalUsedMem uint64
	var totalPower float64
	var count int

	for _, line := range lines {
		parts := strings.Split(line, ",")
		if len(parts) >= 3 {
			usage, _ := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
			used, _ := strconv.ParseUint(strings.TrimSpace(parts[1]), 10, 64)
			power, _ := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)
			totalUsage += usage
			totalUsedMem += used * 1024 * 1024 // MiB 转为 Bytes
			totalPower += power
			count++
		}
	}

	if count == 0 {
		return 0, 0, 0
	}
	return totalUsage / float64(count), totalUsedMem, totalPower
}

func (c *Collector) getNvidiaSmiPath() string {
	nvidiaSmi := "nvidia-smi"
	if runtime.GOOS == "windows" {
		possiblePaths := []string{
			"nvidia-smi",
			"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
			"C:\\Windows\\System32\\nvidia-smi.exe",
		}
		for _, p := range possiblePaths {
			if _, err := exec.LookPath(p); err == nil {
				return p
			}
		}
		// 检查路径是否存在 (LookPath 可能在某些环境下失效)
		for _, p := range possiblePaths {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	} else {
		if _, err := exec.LookPath(nvidiaSmi); err == nil {
			return nvidiaSmi
		}
	}
	return ""
}

// 废弃旧方法
func (c *Collector) collectGPUUsage() float64 {
	u, _, _ := c.collectGPUState()
	return u
}
