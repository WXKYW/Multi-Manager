package openai

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/applog"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
)

// RecordAnalytics saves a gateway proxy metric to the SQLite database
func (s *Service) RecordAnalytics(ctx context.Context, route, endpointID, model string, statusCode int, latencyMs int64, ttfbMs int64, promptTokens, completionTokens, totalTokens, cachedTokens int, stream, viaProxy int, clientIP, upstreamIP string) {
	if ctx == nil {
		ctx = context.Background()
	}
	gatewayKey := gatewayKeyFromContext(ctx)
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	db, err := s.open(writeCtx)
	if err != nil {
		applog.Error(writeCtx, "openai", "Failed to open db for recording analytics", "error", err.Error())
		return
	}
	defer db.Close()

	_, err = db.ExecContext(writeCtx, `
		INSERT INTO openai_gateway_analytics (endpoint_id, gateway_key_id, route, model, status_code, latency_ms, ttfb_ms, prompt_tokens, completion_tokens, total_tokens, cached_tokens, stream, via_proxy, client_ip, upstream_ip)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, endpointID, gatewayKey.ID, route, model, statusCode, latencyMs, ttfbMs, promptTokens, completionTokens, totalTokens, cachedTokens, stream, viaProxy, clientIP, upstreamIP)

	if err != nil {
		applog.Error(writeCtx, "openai", "Failed to insert gateway analytics", "error", err.Error())
	}
}

// getAnalyticsSummary returns aggregation metrics (requests, avg latency, error rate, tokens)
func (s *Service) getAnalyticsSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	daysStr := r.URL.Query().Get("days")
	days := 7
	if daysStr != "" {
		if d, err := strconv.Atoi(daysStr); err == nil && d > 0 {
			days = d
		}
	}

	timeFilter := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02 15:04:05")

	var totalRequests int
	var avgLatency float64
	var totalTokens int
	var totalCachedTokens int
	var totalPromptTokens int
	var totalCompletionTokens int
	var errorCount int

	err = db.QueryRowContext(ctx, `
		SELECT 
			COUNT(*), 
			COALESCE(AVG(latency_ms), 0.0), 
			COALESCE(SUM(total_tokens), 0),
			SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END),
			COALESCE(SUM(cached_tokens), 0),
			COALESCE(SUM(prompt_tokens), 0),
			COALESCE(SUM(completion_tokens), 0)
		FROM openai_gateway_analytics
		WHERE timestamp >= ? AND route != 'models'
	`, timeFilter).Scan(&totalRequests, &avgLatency, &totalTokens, &errorCount, &totalCachedTokens, &totalPromptTokens, &totalCompletionTokens)

	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	errorRate := 0.0
	if totalRequests > 0 {
		errorRate = float64(errorCount) / float64(totalRequests)
	}
	// 缓存命中占比：缓存命中的 token 占上游提示词 token 的比例。
	cachedRatio := 0.0
	if totalPromptTokens > 0 {
		cachedRatio = float64(totalCachedTokens) / float64(totalPromptTokens)
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"totalRequests":         totalRequests,
		"avgLatency":            avgLatency,
		"totalTokens":           totalTokens,
		"totalCachedTokens":     totalCachedTokens,
		"cachedRatio":           cachedRatio,
		"totalPromptTokens":     totalPromptTokens,
		"totalCompletionTokens": totalCompletionTokens,
		"errorRate":             errorRate,
	})
}

// getAnalyticsCharts returns daily timeseries data for the specified days range
func (s *Service) getAnalyticsCharts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	daysStr := r.URL.Query().Get("days")
	days := 7
	if daysStr != "" {
		if d, err := strconv.Atoi(daysStr); err == nil && d > 0 {
			days = d
		}
	}

	timeFilter := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02 15:04:05")

	// 时间粒度：hour / day / week
	granularity := r.URL.Query().Get("granularity")
	var timeGroup string
	var tsExpr string
	switch granularity {
	case "hour":
		timeGroup = "strftime('%m-%d %H:00', timestamp)"
		tsExpr = "CAST(strftime('%s', timestamp) AS INTEGER) / 3600 * 3600"
	case "week":
		timeGroup = "strftime('%Y-W%W', timestamp)"
		tsExpr = "CAST(strftime('%s', timestamp) AS INTEGER) / 604800 * 604800"
	default:
		granularity = "day"
		timeGroup = "strftime('%m-%d', timestamp)"
		tsExpr = "CAST(strftime('%s', timestamp) AS INTEGER) / 86400 * 86400"
	}

	// 1. Trend buckets（小时 / 天 / 周聚合，多指标）
	rows, err := db.QueryContext(ctx, `
		SELECT 
			`+timeGroup+` as bucket,
			`+tsExpr+` as ts_sec,
			COUNT(*) as count, 
			COALESCE(AVG(latency_ms), 0.0) as avg_latency, 
			COALESCE(SUM(total_tokens), 0) as tokens,
			COALESCE(SUM(cached_tokens), 0) as cached,
			SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
		FROM openai_gateway_analytics
		WHERE timestamp >= ? AND route != 'models'
		GROUP BY ts_sec
		ORDER BY ts_sec ASC
	`, timeFilter)

	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type ChartPoint struct {
		Day        string  `json:"day"`
		TsSec      int64   `json:"tsSec"`
		Count      int     `json:"count"`
		AvgLatency float64 `json:"avgLatency"`
		Tokens     int     `json:"tokens"`
		Cached     int     `json:"cachedTokens"`
		Errors     int     `json:"errors"`
		Granularity string `json:"granularity"`
	}

	dailyPoints := []ChartPoint{}
	for rows.Next() {
		var p ChartPoint
		var bucket string
		if err := rows.Scan(&bucket, &p.TsSec, &p.Count, &p.AvgLatency, &p.Tokens, &p.Cached, &p.Errors); err == nil {
			p.Day = bucket
			p.Granularity = granularity
			dailyPoints = append(dailyPoints, p)
		}
	}

	// 2. Model distribution by both request count and token usage.
	rowsModels, err := db.QueryContext(ctx, `
		SELECT 
			model,
			COUNT(*) as count,
			COALESCE(SUM(total_tokens), 0) as tokens
		FROM openai_gateway_analytics
		WHERE timestamp >= ? AND route != 'models'
		GROUP BY model
		ORDER BY count DESC, tokens DESC
	`, timeFilter)

	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rowsModels.Close()

	type ModelShare struct {
		Model  string `json:"model"`
		Count  int    `json:"count"`
		Tokens int    `json:"tokens"`
	}

	modelShares := []ModelShare{}
	for rowsModels.Next() {
		var m ModelShare
		if err := rowsModels.Scan(&m.Model, &m.Count, &m.Tokens); err == nil {
			// 过滤空白模型名（错误/异常请求可能未解析出 model）。
			if strings.TrimSpace(m.Model) == "" {
				continue
			}
			modelShares = append(modelShares, m)
		}
	}

	// 3. 按“模型 × 时段”展开调用量，供全宽趋势图多系列使用。
	rowsByModel, err := db.QueryContext(ctx, `
		SELECT 
			model,
			`+tsExpr+` as ts_sec,
			COUNT(*) as count
		FROM openai_gateway_analytics
		WHERE timestamp >= ? AND route != 'models'
		GROUP BY ts_sec, model
		ORDER BY model ASC, ts_sec ASC
	`, timeFilter)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rowsByModel.Close()

	tsToLabel := make(map[int64]string, len(dailyPoints))
	for _, point := range dailyPoints {
		tsToLabel[point.TsSec] = point.Day
	}

	type ModelSeriesGroup struct {
		Model string `json:"model"`
		Data  []int  `json:"data"`
	}
	bucketIndex := make(map[string]int, len(dailyPoints))
	bucketLabels := make([]string, 0, len(dailyPoints))
	for _, point := range dailyPoints {
		if _, ok := bucketIndex[point.Day]; !ok {
			bucketIndex[point.Day] = len(bucketLabels)
			bucketLabels = append(bucketLabels, point.Day)
		}
	}
	byModelCounts := make(map[int64]map[string]int) // ts -> model -> count
	for rowsByModel.Next() {
		var modelName string
		var tsBucket int64
		var count int
		if err := rowsByModel.Scan(&modelName, &tsBucket, &count); err == nil {
			if byModelCounts[tsBucket] == nil {
				byModelCounts[tsBucket] = map[string]int{}
			}
			byModelCounts[tsBucket][modelName] += count
		}
	}
	modelOrder := make(map[string]bool)
	for _, bucket := range byModelCounts {
		for name := range bucket {
			if strings.TrimSpace(name) == "" {
				continue
			}
			modelOrder[name] = true
		}
	}
	byModel := make([]ModelSeriesGroup, 0, len(modelOrder))
	for name := range modelOrder {
		group := ModelSeriesGroup{Model: name, Data: make([]int, len(bucketLabels))}
		for idx, label := range bucketLabels {
			for ts, bucket := range byModelCounts {
				if tsToLabel[ts] == label {
					group.Data[idx] += bucket[name]
				}
			}
		}
		byModel = append(byModel, group)
	}
	// 保持桶顺序稳定：按 daily 顺序校准一次后按模型名排序展示。
	for _, group := range byModel {
		_ = group
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"daily":   dailyPoints,
		"models":  modelShares,
		"buckets": bucketLabels,
		"byModel": byModel,
	})
}

// clearAnalyticsLogs 清空网关日志表（会话鉴权由路由层保证）。
func (s *Service) clearAnalyticsLogs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()
	result, err := db.ExecContext(ctx, "DELETE FROM openai_gateway_analytics")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	deleted, _ := result.RowsAffected()
	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "deleted": deleted})
}

// getAnalyticsLogs returns paginated raw gateway logs
func (s *Service) getAnalyticsLogs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	pageStr := r.URL.Query().Get("page")
	pageSizeStr := r.URL.Query().Get("pageSize")
	daysStr := r.URL.Query().Get("days")

	page := 1
	pageSize := 20

	if p, err := strconv.Atoi(pageStr); err == nil && p > 0 {
		page = p
	}
	if ps, err := strconv.Atoi(pageSizeStr); err == nil && ps > 0 {
		pageSize = min(ps, 100)
	}
	days := 7
	if d, err := strconv.Atoi(daysStr); err == nil && d > 0 {
		days = d
	}

	offset := (page - 1) * pageSize
	timeFilter := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02 15:04:05")

	// Get total count
	var total int
	err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM openai_gateway_analytics WHERE timestamp >= ? AND route != 'models'", timeFilter).Scan(&total)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Query paginated logs
	rows, err := db.QueryContext(ctx, `
		SELECT 
			g.id,
			g.route,
			COALESCE(e.name, 'unknown') as endpoint_name,
			COALESCE(k.name, '未识别密钥') as gateway_key_name,
			g.model,
			g.status_code,
			g.latency_ms,
			g.ttfb_ms,
			g.prompt_tokens,
			g.completion_tokens,
			g.total_tokens,
			g.cached_tokens,
			COALESCE(g.client_ip, '') as client_ip,
			COALESCE(g.upstream_ip, '') as upstream_ip,
			g.stream,
			g.via_proxy,
			g.timestamp
		FROM openai_gateway_analytics g
		LEFT JOIN openai_endpoints e ON g.endpoint_id = e.id
		LEFT JOIN openai_gateway_keys k ON g.gateway_key_id = k.id
		WHERE g.timestamp >= ? AND g.route != 'models'
		ORDER BY g.timestamp DESC
		LIMIT ? OFFSET ?
	`, timeFilter, pageSize, offset)

	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type LogRecord struct {
		ID               int    `json:"id"`
		Route            string `json:"route"`
		EndpointName     string `json:"endpointName"`
		GatewayKeyName   string `json:"gatewayKeyName"`
		Model            string `json:"model"`
		StatusCode       int    `json:"statusCode"`
		LatencyMs        int64  `json:"latencyMs"`
		TTFbMs           int64  `json:"ttfbMs"`
		PromptTokens     int    `json:"promptTokens"`
		CompletionTokens int    `json:"completionTokens"`
		TotalTokens      int    `json:"totalTokens"`
		CachedTokens     int    `json:"cachedTokens"`
		ClientIP         string `json:"clientIp"`
		UpstreamIP       string `json:"upstreamIp"`
		Stream           bool   `json:"stream"`
		ViaProxy         bool   `json:"viaProxy"`
		Timestamp        string `json:"timestamp"`
	}

	records := []LogRecord{}
	for rows.Next() {
		var rec LogRecord
		var streamVal, viaProxyVal int
		if err := rows.Scan(
			&rec.ID,
			&rec.Route,
			&rec.EndpointName,
			&rec.GatewayKeyName,
			&rec.Model,
			&rec.StatusCode,
			&rec.LatencyMs,
			&rec.TTFbMs,
			&rec.PromptTokens,
			&rec.CompletionTokens,
			&rec.TotalTokens,
			&rec.CachedTokens,
			&rec.ClientIP,
			&rec.UpstreamIP,
			&streamVal,
			&viaProxyVal,
			&rec.Timestamp,
		); err == nil {
			rec.Stream = streamVal == 1
			rec.ViaProxy = viaProxyVal == 1
			records = append(records, rec)
		}
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"total":   total,
		"records": records,
	})
}
