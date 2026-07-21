package openai

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/applog"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
)

// RecordAnalytics saves a gateway proxy metric to the SQLite database
func (s *Service) RecordAnalytics(ctx context.Context, route, endpointID, model string, statusCode int, latencyMs int64, promptTokens, completionTokens, totalTokens int) {
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
		INSERT INTO openai_gateway_analytics (endpoint_id, gateway_key_id, route, model, status_code, latency_ms, prompt_tokens, completion_tokens, total_tokens)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, endpointID, gatewayKey.ID, route, model, statusCode, latencyMs, promptTokens, completionTokens, totalTokens)

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
	var errorCount int

	err = db.QueryRowContext(ctx, `
		SELECT 
			COUNT(*), 
			COALESCE(AVG(latency_ms), 0.0), 
			COALESCE(SUM(total_tokens), 0),
			SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)
		FROM openai_gateway_analytics
		WHERE timestamp >= ?
	`, timeFilter).Scan(&totalRequests, &avgLatency, &totalTokens, &errorCount)

	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	errorRate := 0.0
	if totalRequests > 0 {
		errorRate = float64(errorCount) / float64(totalRequests)
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"totalRequests": totalRequests,
		"avgLatency":    avgLatency,
		"totalTokens":   totalTokens,
		"errorRate":     errorRate,
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

	// 1. Daily trends
	rows, err := db.QueryContext(ctx, `
		SELECT 
			strftime('%m-%d', timestamp) as day, 
			COUNT(*) as count, 
			COALESCE(AVG(latency_ms), 0.0) as avg_latency, 
			COALESCE(SUM(total_tokens), 0) as tokens
		FROM openai_gateway_analytics
		WHERE timestamp >= ?
		GROUP BY day
		ORDER BY day ASC
	`, timeFilter)

	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type ChartPoint struct {
		Day        string  `json:"day"`
		Count      int     `json:"count"`
		AvgLatency float64 `json:"avgLatency"`
		Tokens     int     `json:"tokens"`
	}

	dailyPoints := []ChartPoint{}
	for rows.Next() {
		var p ChartPoint
		if err := rows.Scan(&p.Day, &p.Count, &p.AvgLatency, &p.Tokens); err == nil {
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
		WHERE timestamp >= ?
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
			modelShares = append(modelShares, m)
		}
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"daily":  dailyPoints,
		"models": modelShares,
	})
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
	err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM openai_gateway_analytics WHERE timestamp >= ?", timeFilter).Scan(&total)
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
			g.prompt_tokens,
			g.completion_tokens,
			g.total_tokens,
			g.timestamp
		FROM openai_gateway_analytics g
		LEFT JOIN openai_endpoints e ON g.endpoint_id = e.id
		LEFT JOIN openai_gateway_keys k ON g.gateway_key_id = k.id
		WHERE g.timestamp >= ?
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
		PromptTokens     int    `json:"promptTokens"`
		CompletionTokens int    `json:"completionTokens"`
		TotalTokens      int    `json:"totalTokens"`
		Timestamp        string `json:"timestamp"`
	}

	records := []LogRecord{}
	for rows.Next() {
		var rec LogRecord
		if err := rows.Scan(
			&rec.ID,
			&rec.Route,
			&rec.EndpointName,
			&rec.GatewayKeyName,
			&rec.Model,
			&rec.StatusCode,
			&rec.LatencyMs,
			&rec.PromptTokens,
			&rec.CompletionTokens,
			&rec.TotalTokens,
			&rec.Timestamp,
		); err == nil {
			records = append(records, rec)
		}
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"total":   total,
		"records": records,
	})
}
