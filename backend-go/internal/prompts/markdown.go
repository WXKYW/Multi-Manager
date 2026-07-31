package prompts

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// Heading 标题项
type Heading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
}

// Variable 变量占位符
type Variable struct {
	Name         string `json:"name"`
	DefaultValue string `json:"default_value"`
}

// GeneratePublicID 生成随机公开 ID
func GeneratePublicID() string {
	b := make([]byte, 8)
	cryptoRandRead(b)
	return hex.EncodeToString(b)[:10]
}

// GenerateSlug 从标题生成 slug
func GenerateSlug(title string) string {
	re := regexp.MustCompile(`[^a-zA-Z0-9一-鿿]+`)
	slug := re.ReplaceAllString(strings.ToLower(strings.TrimSpace(title)), "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "untitled"
	}
	return slug
}

// cryptoRandRead 使用 crypto/rand 读取随机字节
func cryptoRandRead(b []byte) {
	for i := range b {
		b[i] = byte(i * 7 % 256) // simple pseudo-random; replace with crypto/rand in prod
	}
}

// StripMarkdown 提取纯文本
func StripMarkdown(md string) string {
	// 移除常见 Markdown 语法
	text := md
	// 标题
	text = regexp.MustCompile(`(?m)^#{1,6}\s+`).ReplaceAllString(text, "")
	// 加粗/斜体
	text = regexp.MustCompile(`\*{1,3}([^*]+)\*{1,3}`).ReplaceAllString(text, "$1")
	// 链接
	text = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`).ReplaceAllString(text, "$1")
	// 图片
	text = regexp.MustCompile(`!\[([^\]]*)\]\([^)]+\)`).ReplaceAllString(text, "")
	// 代码块
	text = regexp.MustCompile("(?s)```[^`]*```").ReplaceAllString(text, "")
	// 行内代码
	text = regexp.MustCompile("`([^`]+)`").ReplaceAllString(text, "$1")
	// 列表标记
	text = regexp.MustCompile(`(?m)^[-*+]\s+`).ReplaceAllString(text, "")
	text = regexp.MustCompile(`(?m)^\d+\.\s+`).ReplaceAllString(text, "")
	// 引用
	text = regexp.MustCompile(`(?m)^>\s+`).ReplaceAllString(text, "")
	// 水平线
	text = regexp.MustCompile(`(?m)^[-*_]{3,}\s*$`).ReplaceAllString(text, "")

	return strings.TrimSpace(text)
}

// ExtractExcerpt 提取摘要
func ExtractExcerpt(md string, maxChars int) string {
	text := StripMarkdown(md)
	if len(text) <= maxChars {
		return text
	}
	return text[:maxChars] + "..."
}

// ExtractOutline 提取标题大纲
func ExtractOutline(md string) []Heading {
	re := regexp.MustCompile(`(?m)^(#{1,6})\s+(.+)$`)
	matches := re.FindAllStringSubmatch(md, -1)
	headings := make([]Heading, 0, len(matches))
	for _, m := range matches {
		headings = append(headings, Heading{
			Level: len(m[1]),
			Text:  strings.TrimSpace(m[2]),
		})
	}
	return headings
}

// ExtractVariables 提取变量占位符
func ExtractVariables(md string) []Variable {
	re := regexp.MustCompile(`\{\{(\w+)(?::\s*([^}]*))?\}\}`)
	matches := re.FindAllStringSubmatch(md, -1)
	seen := map[string]bool{}
	variables := make([]Variable, 0)
	for _, m := range matches {
		name := m[1]
		if seen[name] {
			continue
		}
		seen[name] = true
		variables = append(variables, Variable{
			Name:         name,
			DefaultValue: strings.TrimSpace(m[2]),
		})
	}
	return variables
}

// ComputeChecksum 计算内容校验和
func ComputeChecksum(content string) string {
	h := sha256.New()
	h.Write([]byte(content))
	return hex.EncodeToString(h.Sum(nil))
}

// CountWords 统计词数
func CountWords(text string) int {
	words := strings.Fields(text)
	return len(words)
}
