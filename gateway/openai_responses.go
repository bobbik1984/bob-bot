package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type responseItem struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	CallID    string `json:"call_id"`
	Arguments string `json:"arguments"`
	Content   []struct {
		Type    string `json:"type"`
		Text    string `json:"text"`
		Refusal string `json:"refusal"`
	} `json:"content"`
}

// Keep reasoning and tool calls together when continuing a response without server-side storage.
func callResponsesStream(endpoint, key, model string, history []Message, cid string) (string, error) {
	input := make([]any, 0, len(history))
	for _, m := range history {
		role := m.Role
		if role == "model" {
			role = "assistant"
		}
		input = append(input, map[string]string{"role": role, "content": m.Text})
	}
	tools := bobToolSchemas()
	for _, tool := range tools {
		tool["type"] = "function"
		tool["strict"] = false
	}
	client := &http.Client{Timeout: 90 * time.Second}
	var answer strings.Builder
	for round := 0; round < 4; round++ {
		body, err := json.Marshal(map[string]any{"model": model, "instructions": bobSystemPrompt(), "input": input, "tools": tools, "stream": true, "store": false, "include": []string{"reasoning.encrypted_content"}})
		if err != nil {
			return "", err
		}
		req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := client.Do(req)
		if err != nil {
			return "", err
		}
		output, err := readResponseStream(resp, cid, answer.String())
		if err != nil {
			return "", err
		}
		var results []any
		for _, raw := range output {
			var item responseItem
			if err := json.Unmarshal(raw, &item); err != nil {
				return "", err
			}
			input = append(input, raw)
			for _, part := range item.Content {
				switch part.Type {
				case "output_text":
					answer.WriteString(part.Text)
				case "refusal":
					answer.WriteString(part.Refusal)
				}
			}
			if item.Type == "function_call" {
				var args map[string]any
				if err := json.Unmarshal([]byte(item.Arguments), &args); err != nil {
					return "", err
				}
				result := executeBobTool(item.Name, args, cid)
				results = append(results, map[string]string{"type": "function_call_output", "call_id": item.CallID, "output": result})
			}
		}
		if len(results) == 0 {
			if answer.Len() == 0 {
				return "", fmt.Errorf("OpenAI returned an empty response")
			}
			return answer.String(), nil
		}
		input = append(input, results...)
	}
	return "", fmt.Errorf("OpenAI tool round limit reached")
}

func readResponseStream(resp *http.Response, cid, prefix string) ([]json.RawMessage, error) {
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}
	scan := bufio.NewScanner(resp.Body)
	scan.Buffer(make([]byte, 65536), 16<<20)
	var text strings.Builder
	text.WriteString(prefix)
	for scan.Scan() {
		data, ok := strings.CutPrefix(scan.Text(), "data:")
		if !ok {
			continue
		}
		var event struct {
			Type     string
			Delta    string
			Message  string
			Response struct {
				Output []json.RawMessage
				Error  struct{ Message string }
			}
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			return nil, err
		}
		switch event.Type {
		case "response.output_text.delta", "response.refusal.delta":
			text.WriteString(event.Delta)
			broadcast(Event{Type: "delta", Role: "assistant", Text: text.String(), CID: cid})
		case "response.completed":
			return event.Response.Output, nil
		case "response.failed", "response.incomplete", "error":
			return nil, fmt.Errorf("OpenAI %s: %s%s", event.Type, event.Message, event.Response.Error.Message)
		}
	}
	if err := scan.Err(); err != nil {
		return nil, err
	}
	return nil, io.ErrUnexpectedEOF
}
