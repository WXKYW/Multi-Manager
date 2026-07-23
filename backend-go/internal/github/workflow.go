package github

import (
	"errors"
	"strings"

	"gopkg.in/yaml.v3"
)

func parseWorkflowLayout(raw string) ([][]workflowJobDefinition, error) {
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(raw), &root); err != nil {
		return nil, err
	}
	doc := &root
	if root.Kind == yaml.DocumentNode && len(root.Content) > 0 {
		doc = root.Content[0]
	}
	jobsNode := mappingValue(doc, "jobs")
	if jobsNode == nil || jobsNode.Kind != yaml.MappingNode {
		return nil, errors.New("workflow yml 中没有 jobs")
	}
	jobs := make([]workflowJobDefinition, 0, len(jobsNode.Content)/2)
	for i := 0; i+1 < len(jobsNode.Content); i += 2 {
		key := strings.TrimSpace(jobsNode.Content[i].Value)
		value := jobsNode.Content[i+1]
		if key == "" || value.Kind != yaml.MappingNode {
			continue
		}
		name := scalarString(mappingValue(value, "name"))
		if name == "" {
			name = key
		}
		jobs = append(jobs, workflowJobDefinition{
			ID:     key,
			Name:   name,
			Needs:  needsValues(mappingValue(value, "needs")),
			Matrix: hasMatrix(value),
		})
	}
	if len(jobs) == 0 {
		return nil, errors.New("workflow yml 中没有可识别的 job")
	}
	return workflowLayers(jobs), nil
}

func mappingValue(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if strings.EqualFold(strings.TrimSpace(node.Content[i].Value), key) {
			return node.Content[i+1]
		}
	}
	return nil
}

func scalarString(node *yaml.Node) string {
	if node == nil || node.Kind != yaml.ScalarNode {
		return ""
	}
	return strings.TrimSpace(node.Value)
}

func needsValues(node *yaml.Node) []string {
	if node == nil {
		return nil
	}
	switch node.Kind {
	case yaml.ScalarNode:
		if value := strings.TrimSpace(node.Value); value != "" {
			return []string{value}
		}
	case yaml.SequenceNode:
		values := make([]string, 0, len(node.Content))
		for _, item := range node.Content {
			if value := scalarString(item); value != "" {
				values = append(values, value)
			}
		}
		return values
	}
	return nil
}

func hasMatrix(job *yaml.Node) bool {
	strategy := mappingValue(job, "strategy")
	if strategy == nil || strategy.Kind != yaml.MappingNode {
		return false
	}
	matrix := mappingValue(strategy, "matrix")
	return matrix != nil
}

func workflowLayers(jobs []workflowJobDefinition) [][]workflowJobDefinition {
	byID := make(map[string]workflowJobDefinition, len(jobs))
	for _, job := range jobs {
		byID[job.ID] = job
	}
	layerByID := make(map[string]int, len(jobs))
	visiting := make(map[string]bool, len(jobs))
	var layerFor func(string) int
	layerFor = func(id string) int {
		if layer, ok := layerByID[id]; ok {
			return layer
		}
		job, ok := byID[id]
		if !ok || visiting[id] {
			return 0
		}
		visiting[id] = true
		layer := 0
		for _, need := range job.Needs {
			if _, exists := byID[need]; exists {
				if parentLayer := layerFor(need) + 1; parentLayer > layer {
					layer = parentLayer
				}
			}
		}
		visiting[id] = false
		layerByID[id] = layer
		return layer
	}
	for _, job := range jobs {
		layerFor(job.ID)
	}
	layers := make([][]workflowJobDefinition, 0)
	for _, job := range jobs {
		layer := layerByID[job.ID]
		for len(layers) <= layer {
			layers = append(layers, []workflowJobDefinition{})
		}
		layers[layer] = append(layers[layer], job)
	}
	return layers
}
