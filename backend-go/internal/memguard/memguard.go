package memguard

import (
	"bufio"
	"context"
	"math"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/applog"
)

const (
	defaultLimitRatio     = 0.70
	defaultTriggerRatio   = 0.85
	defaultCheckInterval  = 15 * time.Second
	minContainerLimitByte = 64 * 1024 * 1024
)

type Config struct {
	LimitBytes    int64
	TriggerBytes  uint64
	CheckInterval time.Duration
	Source        string
}

func Start(ctx context.Context) Config {
	cfg := resolveConfig()
	if cfg.LimitBytes <= 0 {
		applog.Info(ctx, "memguard", "memory guard disabled")
		return cfg
	}

	debug.SetMemoryLimit(cfg.LimitBytes)
	applog.Info(ctx, "memguard", "memory guard enabled",
		"limit_bytes", cfg.LimitBytes,
		"trigger_bytes", cfg.TriggerBytes,
		"source", cfg.Source,
	)

	go run(ctx, cfg)
	return cfg
}

func run(ctx context.Context, cfg Config) {
	ticker := time.NewTicker(cfg.CheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var stats runtime.MemStats
			runtime.ReadMemStats(&stats)
			rss := readProcessRSSBytes()
			if stats.Sys < cfg.TriggerBytes && stats.HeapAlloc < cfg.TriggerBytes && rss < cfg.TriggerBytes {
				continue
			}

			beforeSys := stats.Sys
			beforeHeap := stats.HeapAlloc
			beforeRSS := rss
			runtime.GC()
			debug.FreeOSMemory()
			runtime.ReadMemStats(&stats)

			applog.Warn(ctx, "memguard", "memory pressure cleanup completed",
				"before_sys_bytes", beforeSys,
				"after_sys_bytes", stats.Sys,
				"before_heap_bytes", beforeHeap,
				"after_heap_bytes", stats.HeapAlloc,
				"before_rss_bytes", beforeRSS,
				"after_rss_bytes", readProcessRSSBytes(),
				"limit_bytes", cfg.LimitBytes,
			)
		}
	}
}

func resolveConfig() Config {
	if isDisabled(os.Getenv("API_MONITOR_MEMORY_GUARD")) {
		return Config{}
	}

	if limitMB := parsePositiveInt(os.Getenv("API_MONITOR_MEMORY_LIMIT_MB")); limitMB > 0 {
		limit := int64(limitMB) * 1024 * 1024
		return configForLimit(limit, "API_MONITOR_MEMORY_LIMIT_MB")
	}

	if limit, source := cgroupMemoryLimit(); limit >= minContainerLimitByte {
		return configForLimit(int64(float64(limit)*defaultLimitRatio), source)
	}

	return Config{}
}

func configForLimit(limit int64, source string) Config {
	triggerRatio := defaultTriggerRatio
	if raw := strings.TrimSpace(os.Getenv("API_MONITOR_MEMORY_GC_TRIGGER_RATIO")); raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && parsed > 0 && parsed <= 1 {
			triggerRatio = parsed
		}
	}

	interval := defaultCheckInterval
	if seconds := parsePositiveInt(os.Getenv("API_MONITOR_MEMORY_CHECK_SECONDS")); seconds > 0 {
		interval = time.Duration(seconds) * time.Second
	}

	return Config{
		LimitBytes:    limit,
		TriggerBytes:  uint64(float64(limit) * triggerRatio),
		CheckInterval: interval,
		Source:        source,
	}
}

func cgroupMemoryLimit() (uint64, string) {
	if value, ok := readCgroupLimitFile("/sys/fs/cgroup/memory.max"); ok {
		return value, "cgroup_v2_memory_max"
	}
	if value, ok := readCgroupLimitFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); ok {
		return value, "cgroup_v1_memory_limit"
	}
	return 0, ""
}

func readCgroupLimitFile(path string) (uint64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	value := strings.TrimSpace(string(raw))
	if value == "" || value == "max" {
		return 0, false
	}
	limit, err := strconv.ParseUint(value, 10, 64)
	if err != nil || limit == 0 || limit > uint64(math.MaxInt64) {
		return 0, false
	}
	return limit, true
}

func parsePositiveInt(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return 0
	}
	return parsed
}

func isDisabled(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "0", "false", "off", "disabled", "no":
		return true
	default:
		return false
	}
}

func readProcessRSSBytes() uint64 {
	file, err := os.Open("/proc/self/status")
	if err != nil {
		return 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0
		}
		kib, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0
		}
		return kib * 1024
	}
	return 0
}
