package github

import "testing"

func TestParseWorkflowLayoutPreservesOrderAndNeeds(t *testing.T) {
	raw := `
name: CI
jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
  test:
    needs: lint
    strategy:
      matrix:
        node: [20, 22]
    runs-on: ubuntu-latest
  deploy:
    needs: [lint, test]
    runs-on: ubuntu-latest
`
	layers, err := parseWorkflowLayout(raw)
	if err != nil {
		t.Fatalf("parseWorkflowLayout: %v", err)
	}
	if len(layers) != 3 {
		t.Fatalf("unexpected layers: %#v", layers)
	}
	if layers[0][0].ID != "lint" || layers[0][0].Name != "Lint" {
		t.Fatalf("unexpected first layer: %#v", layers[0])
	}
	if layers[1][0].ID != "test" || !layers[1][0].Matrix || len(layers[1][0].Needs) != 1 || layers[1][0].Needs[0] != "lint" {
		t.Fatalf("unexpected second layer: %#v", layers[1])
	}
	if layers[2][0].ID != "deploy" || len(layers[2][0].Needs) != 2 {
		t.Fatalf("unexpected third layer: %#v", layers[2])
	}
}

func TestParseWorkflowLayoutKeepsDeclarationOrderWithinLayer(t *testing.T) {
	raw := `
jobs:
  build-linux:
    runs-on: ubuntu-latest
  build-windows:
    runs-on: windows-latest
  package:
    needs:
      - build-linux
      - build-windows
    runs-on: ubuntu-latest
`
	layers, err := parseWorkflowLayout(raw)
	if err != nil {
		t.Fatalf("parseWorkflowLayout: %v", err)
	}
	if len(layers) != 2 {
		t.Fatalf("unexpected layers: %#v", layers)
	}
	if layers[0][0].ID != "build-linux" || layers[0][1].ID != "build-windows" {
		t.Fatalf("declaration order was not preserved: %#v", layers[0])
	}
	if layers[1][0].ID != "package" {
		t.Fatalf("unexpected final layer: %#v", layers[1])
	}
}
