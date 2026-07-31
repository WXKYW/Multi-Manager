package drawio

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"strings"
	"time"
)

// PageInfo 页信息
type PageInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ExternalAsset 外链资源
type ExternalAsset struct {
	URL       string `json:"url"`
	Domain    string `json:"domain"`
	AssetType string `json:"asset_type"`
}

// ParsePageInfo 从 mxfile XML 提取页信息
func ParsePageInfo(xmlContent string) ([]PageInfo, string, string) {
	var pages []PageInfo
	coverID := ""
	coverName := ""

	type MxFile struct {
		XMLName xml.Name `xml:"mxfile"`
		Diagram []struct {
			ID   string `xml:"id,attr"`
			Name string `xml:"name,attr"`
		} `xml:"diagram"`
	}

	// 尝试解析 mxfile
	var mxfile MxFile
	if err := xml.Unmarshal([]byte(xmlContent), &mxfile); err != nil {
		// 压缩页：尝试找 diagram 标签
		// 简化处理：返回空页
		return pages, coverID, coverName
	}

	for _, d := range mxfile.Diagram {
		pages = append(pages, PageInfo{
			ID:   d.ID,
			Name: d.Name,
		})
	}

	if len(pages) > 0 {
		coverID = pages[0].ID
		coverName = pages[0].Name
	}

	return pages, coverID, coverName
}

// ComputeXMLHash 计算 XML 内容哈希
func ComputeXMLHash(xmlContent string) string {
	h := sha256.New()
	h.Write([]byte(xmlContent))
	return hex.EncodeToString(h.Sum(nil))
}

// NormalizeXML 归一化 XML 为未压缩 mxfile 格式
func NormalizeXML(content string) (string, error) {
	content = strings.TrimSpace(content)

	// 如果已经是 mxfile，直接返回
	if strings.HasPrefix(content, "<mxfile") {
		return content, nil
	}

	// 如果是单个 mxGraphModel，包装为 mxfile
	if strings.Contains(content, "<mxGraphModel") {
		wrapped := fmt.Sprintf(`<mxfile host="api-monitor" modified="%s" agent="api-monitor" version="24.0.0" type="device">
  <diagram id="page-1" name="Page-1">
    %s
  </diagram>
</mxfile>`, time.Now().UTC().Format(time.RFC3339), content)
		return wrapped, nil
	}

	// 如果看起来是完整 XML，尝试当作 mxfile
	if strings.HasPrefix(content, "<?xml") || strings.HasPrefix(content, "<") {
		return content, nil
	}

	return "", fmt.Errorf("无法识别的 drawio 格式")
}

// DefaultBlankMXFile 生成默认空白文档
func DefaultBlankMXFile() string {
	return fmt.Sprintf(`<mxfile host="api-monitor" modified="%s" agent="api-monitor" version="24.0.0" type="device">
  <diagram id="page-1" name="Page-1">
    <mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`, time.Now().UTC().Format(time.RFC3339))
}

// ExtractExternalAssets 提取外链资源
func ExtractExternalAssets(xmlContent string) []ExternalAsset {
	var assets []ExternalAsset
	seen := map[string]bool{}

	// 简单扫描 image 标签
	// 在实际实现中可以使用更严格的 XML 解析
	lines := strings.Split(xmlContent, "\n")
	for _, line := range lines {
		// 查找 http:// 或 https:// URL
		for _, prefix := range []string{"http://", "https://"} {
			idx := strings.Index(line, prefix)
			if idx < 0 {
				continue
			}
			end := idx
			for end < len(line) {
				c := line[end]
				if c == '"' || c == '\'' || c == ' ' || c == '>' || c == '<' || c == '\n' || c == '\r' || c == '&' {
					break
				}
				end++
			}
			if end > idx {
				url := line[idx:end]
				if !seen[url] {
					seen[url] = true
					domain := extractDomain(url)
					assets = append(assets, ExternalAsset{
						URL:       url,
						Domain:    domain,
						AssetType: "image",
					})
				}
			}
		}
	}
	return assets
}

func extractDomain(url string) string {
	url = strings.TrimPrefix(url, "https://")
	url = strings.TrimPrefix(url, "http://")
	if idx := strings.Index(url, "/"); idx >= 0 {
		url = url[:idx]
	}
	return url
}

// IsPrivateNetworkURL 检查 URL 是否指向私网地址
func IsPrivateNetworkURL(url string) bool {
	host := extractDomain(url)
	host = strings.Split(host, ":")[0] // 去掉端口

	// 阻止 localhost
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}

	// 简单检查私网前缀
	for _, prefix := range []string{
		"10.",
		"172.16.", "172.17.", "172.18.", "172.19.",
		"172.20.", "172.21.", "172.22.", "172.23.",
		"172.24.", "172.25.", "172.26.", "172.27.",
		"172.28.", "172.29.", "172.30.", "172.31.",
		"192.168.",
	} {
		if strings.HasPrefix(host, prefix) {
			return true
		}
	}

	return false
}

// formatTime 格式化时间为 ISO 字符串
func formatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

// GetDB 获取数据库连接（复用 database 包）
func getDB(ctx context.Context, dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
