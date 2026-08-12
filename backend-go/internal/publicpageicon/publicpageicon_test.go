package publicpageicon

import (
	"context"
	"strings"
	"testing"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"github.com/iwvw/api-monitor/backend-go/internal/database"
)

func TestIconIDFromConfigJSON(t *testing.T) {
	cases := []struct {
		name string
		data string
		want string
	}{
		{name: "valid icon id", data: `{"publicIconId":"site-abc123","title":"x"}`, want: "site-abc123"},
		{name: "empty object", data: `{}`, want: ""},
		{name: "null config", data: ``, want: ""},
		{name: "garbage json", data: `not-json`, want: ""},
		{name: "wrong value type", data: `{"publicIconId":42}`, want: ""},
		{name: "blank icon id", data: `{"publicIconId":"  "}`, want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IconIDFromConfigJSON([]byte(tc.data)); got != tc.want {
				t.Fatalf("IconIDFromConfigJSON(%q) = %q, want %q", tc.data, got, tc.want)
			}
		})
	}
}

func TestDefaultGlyphSVG(t *testing.T) {
	for _, kind := range []string{KindUptime, KindServer, KindGitHub, "unknown-kind"} {
		svg := DefaultGlyphSVG(kind)
		if !strings.HasPrefix(svg, "<svg") {
			t.Fatalf("glyph for %q must start with <svg, got %q", kind, svg[:min(len(svg), 20)])
		}
		if !strings.Contains(svg, DefaultIconColor) {
			t.Fatalf("glyph for %q must use brand color %s", kind, DefaultIconColor)
		}
		if !strings.HasSuffix(svg, "</svg>") {
			t.Fatalf("glyph for %q must end with </svg>", kind)
		}
	}
}

func TestValidIconID(t *testing.T) {
	valid := []string{"site-abc123", "icon_1", "A-B_c0", "x"}
	for _, id := range valid {
		if !ValidIconID(id) {
			t.Fatalf("ValidIconID(%q) = false, want true", id)
		}
	}
	invalid := []string{"", "../etc", "a/b", "a?b", "a#b", "a b", "a\\b", strings.Repeat("x", 65), "\u4e2d\u6587"}
	for _, id := range invalid {
		if ValidIconID(id) {
			t.Fatalf("ValidIconID(%q) = true, want false", id)
		}
	}
}

func TestLookupIconID(t *testing.T) {
	cfg := config.Config{DataDir: t.TempDir(), DBName: "test.db"}
	store := database.New(cfg)
	db, err := store.Open(context.Background())
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.Exec(`CREATE TABLE test_pages (
		slug TEXT NOT NULL, domain TEXT, public INTEGER NOT NULL DEFAULT 0, config_json TEXT)`,
	); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO test_pages (slug, domain, public, config_json) VALUES (?, ?, 1, ?), (?, ?, 1, ?)`,
		"custom", "custom.example.com", `{"publicIconId":"site-custom"}`, "plain", "plain.example.com", `{}`,
	); err != nil {
		t.Fatalf("insert pages: %v", err)
	}

	iconID, found, err := LookupIconID(ctx, db, "test_pages", "custom", false)
	if err != nil || !found || iconID != "site-custom" {
		t.Fatalf("slug lookup = (%q, %v, %v), want (site-custom, true, nil)", iconID, found, err)
	}
	iconID, found, err = LookupIconID(ctx, db, "test_pages", "CUSTOM.Example.COM", true)
	if err != nil || !found || iconID != "site-custom" {
		t.Fatalf("domain lookup = (%q, %v, %v), want (site-custom, true, nil)", iconID, found, err)
	}
	iconID, found, err = LookupIconID(ctx, db, "test_pages", "plain", false)
	if err != nil || !found || iconID != "" {
		t.Fatalf("plain page lookup = (%q, %v, %v), want ('', true, nil)", iconID, found, err)
	}
	iconID, found, err = LookupIconID(ctx, db, "test_pages", "missing", false)
	if err != nil || found {
		t.Fatalf("missing lookup = (%q, %v, %v), want ('', false, nil)", iconID, found, err)
	}
}
