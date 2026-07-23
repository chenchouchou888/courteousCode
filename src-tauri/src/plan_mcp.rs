use serde_json::{json, Value};
use std::io::{BufRead, Write};

const MAX_PLAN_ITEMS: usize = 100;
const MAX_PLAN_STEP_LENGTH: usize = 1_000;
const MAX_PLAN_EXPLANATION_LENGTH: usize = 4_000;

fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message.into()}})
}

fn tools_list() -> Value {
    json!({
        "tools": [{
            "name": "update_plan",
            "description": "Create or replace the current Black Box thread Plan. Use for meaningful multi-step work, keep statuses current as work progresses, and keep at most one item in_progress.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["plan"],
                "properties": {
                    "explanation": {
                        "type": "string",
                        "maxLength": MAX_PLAN_EXPLANATION_LENGTH,
                        "description": "Optional concise explanation for this Plan update."
                    },
                    "plan": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_PLAN_ITEMS,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["step", "status"],
                            "properties": {
                                "step": {"type":"string","minLength":1,"maxLength":MAX_PLAN_STEP_LENGTH},
                                "status": {"type":"string","enum":["pending","in_progress","completed"]}
                            }
                        }
                    }
                }
            }
        }]
    })
}

fn validate_update_plan(arguments: &Value) -> Result<Value, String> {
    let object = arguments
        .as_object()
        .ok_or_else(|| "update_plan arguments must be an object".to_string())?;
    let plan = object
        .get("plan")
        .and_then(Value::as_array)
        .ok_or_else(|| "plan must be an array".to_string())?;
    if plan.is_empty() || plan.len() > MAX_PLAN_ITEMS {
        return Err(format!("plan must contain 1-{MAX_PLAN_ITEMS} items"));
    }

    let mut in_progress = 0usize;
    let mut normalized = Vec::with_capacity(plan.len());
    for (index, item) in plan.iter().enumerate() {
        let item = item
            .as_object()
            .ok_or_else(|| format!("plan item {} must be an object", index + 1))?;
        let step = item
            .get("step")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|step| !step.is_empty())
            .ok_or_else(|| format!("plan item {} must have a non-empty step", index + 1))?;
        if step.chars().count() > MAX_PLAN_STEP_LENGTH {
            return Err(format!("plan item {} exceeds the step limit", index + 1));
        }
        let status = item
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("plan item {} must have a status", index + 1))?;
        if !matches!(status, "pending" | "in_progress" | "completed") {
            return Err(format!("plan item {} has an invalid status", index + 1));
        }
        if status == "in_progress" {
            in_progress += 1;
        }
        normalized.push(json!({"step":step,"status":status}));
    }
    if in_progress > 1 {
        return Err("plan may have at most one in_progress item".to_string());
    }

    let explanation = match object.get("explanation") {
        Some(Value::String(value)) if value.chars().count() <= MAX_PLAN_EXPLANATION_LENGTH => {
            Some(value.trim().to_string())
        }
        Some(Value::String(_)) => return Err("explanation exceeds the length limit".to_string()),
        Some(_) => return Err("explanation must be a string".to_string()),
        None => None,
    };
    Ok(json!({"explanation":explanation,"plan":normalized}))
}

fn handle_request(message: &Value) -> Option<Value> {
    let method = message.get("method")?.as_str()?;
    let id = message.get("id").cloned();
    if id.is_none() {
        return None;
    }
    let id = id.unwrap_or(Value::Null);
    match method {
        "initialize" => {
            let protocol = message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05");
            Some(response(
                id,
                json!({
                    "protocolVersion": protocol,
                    "capabilities": {"tools":{"listChanged":false}},
                    "serverInfo": {"name":"blackbox-plan","version":env!("CARGO_PKG_VERSION")}
                }),
            ))
        }
        "tools/list" => Some(response(id, tools_list())),
        "tools/call" => {
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if name != "update_plan" {
                return Some(error_response(id, -32602, "unknown Plan tool"));
            }
            let arguments = message
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match validate_update_plan(&arguments) {
                Ok(normalized) => Some(response(
                    id,
                    json!({
                        "content":[{"type":"text","text":"Black Box Plan updated."}],
                        "structuredContent": normalized,
                        "isError": false
                    }),
                )),
                Err(error) => Some(response(
                    id,
                    json!({
                        "content":[{"type":"text","text":error}],
                        "isError": true
                    }),
                )),
            }
        }
        "ping" => Some(response(id, json!({}))),
        _ => Some(error_response(id, -32601, "method not found")),
    }
}

pub fn run() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("Failed to read MCP request: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Failed to parse MCP request: {error}"))?;
        if let Some(reply) = handle_request(&message) {
            serde_json::to_writer(&mut stdout, &reply)
                .map_err(|error| format!("Failed to encode MCP response: {error}"))?;
            stdout
                .write_all(b"\n")
                .and_then(|_| stdout.flush())
                .map_err(|error| format!("Failed to write MCP response: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertises_a_bounded_update_plan_tool() {
        let tools = tools_list();
        assert_eq!(tools["tools"][0]["name"], "update_plan");
        assert_eq!(
            tools["tools"][0]["inputSchema"]["properties"]["plan"]["maxItems"],
            MAX_PLAN_ITEMS
        );
    }

    #[test]
    fn accepts_one_in_progress_item_and_normalizes_whitespace() {
        let value = validate_update_plan(&json!({
            "explanation":"  move forward  ",
            "plan":[
                {"step":" done ","status":"completed"},
                {"step":" now ","status":"in_progress"},
                {"step":" later ","status":"pending"}
            ]
        }))
        .unwrap();
        assert_eq!(value["plan"][1]["step"], "now");
        assert_eq!(value["explanation"], "move forward");
    }

    #[test]
    fn rejects_parallel_in_progress_items() {
        let error = validate_update_plan(&json!({"plan":[
            {"step":"one","status":"in_progress"},
            {"step":"two","status":"in_progress"}
        ]}))
        .unwrap_err();
        assert!(error.contains("at most one"));
    }

    #[test]
    fn handles_initialize_and_tool_calls_without_side_effects() {
        let initialized = handle_request(&json!({
            "jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocolVersion":"2025-06-18"}
        }))
        .unwrap();
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        let called = handle_request(&json!({
            "jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{"name":"update_plan","arguments":{"plan":[{"step":"x","status":"pending"}]}}
        }))
        .unwrap();
        assert_eq!(called["result"]["isError"], false);
    }
}
