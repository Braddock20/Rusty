use serde_json::Value;

pub fn text(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(x)=v.get(*k) {
            if let Some(s)=x.as_str() { if !s.is_empty() { return Some(s.to_string()); } }
            if x.is_number() { return Some(x.to_string()); }
        }
    }
    None
}
pub fn fixture_id(v: &Value, keys: &[&str]) -> Option<String> { text(v,keys) }
pub fn walk_records(v: &Value) -> Vec<&Value> {
    for key in ["data","fixtures","results","items","matches","records"] {
        if let Some(a)=v.get(key).and_then(Value::as_array) { return a.iter().collect(); }
    }
    if let Some(a)=v.as_array() { return a.iter().collect(); }
    Vec::new()
}
pub fn looks_like_error(v: &Value) -> bool { v.get("error").is_some() }
