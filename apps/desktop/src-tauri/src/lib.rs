use std::{sync::mpsc, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{
  webview::{NewWindowResponse, WebviewBuilder},
  Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window,
};

const BROWSER_PILOT_WEBVIEW_SCRIPT: &str = include_str!("browser_pilot_webview.js");
const WEBVIEW_CDP_PORT: &str = "9333";

#[derive(Clone, Serialize)]
struct BrowserWebviewError {
  label: String,
  message: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserAgentPoint {
  x: i32,
  y: i32,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserTargetBox {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserTargetRisk {
  level: String,
  reason: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserTargetInteraction {
  #[serde(default)]
  clickable: bool,
  #[serde(default)]
  editable: bool,
  #[serde(default)]
  selectable: bool,
  #[serde(default)]
  scrollable: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserTargetSemantics {
  #[serde(default)]
  kind: String,
  #[serde(default)]
  role: String,
  #[serde(default, rename = "intentHints")]
  intent_hints: Vec<String>,
  #[serde(default)]
  confidence: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserAgentTarget {
  id: String,
  #[serde(default)]
  selector: String,
  label: String,
  tag: String,
  #[serde(rename = "type")]
  target_type: String,
  #[serde(default)]
  text: String,
  #[serde(default, rename = "ariaLabel")]
  aria_label: String,
  #[serde(default)]
  title: String,
  #[serde(default)]
  alt: String,
  #[serde(default)]
  placeholder: String,
  #[serde(default)]
  href: String,
  #[serde(default)]
  value: String,
  #[serde(default)]
  context: String,
  #[serde(default)]
  visibility: String,
  #[serde(default)]
  interaction: Option<BrowserTargetInteraction>,
  #[serde(default)]
  semantics: Option<BrowserTargetSemantics>,
  #[serde(default, rename = "regionId")]
  region_id: String,
  #[serde(default, rename = "blockId")]
  block_id: String,
  #[serde(default)]
  risk: Option<BrowserTargetRisk>,
  #[serde(rename = "box")]
  target_box: BrowserTargetBox,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserContentItem {
  id: String,
  #[serde(default)]
  kind: String,
  role: String,
  text: String,
  #[serde(default, rename = "targetIds")]
  target_ids: Vec<String>,
  #[serde(default, rename = "regionId")]
  region_id: String,
  #[serde(rename = "box")]
  content_box: BrowserTargetBox,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserVisualItem {
  id: String,
  kind: String,
  #[serde(default)]
  alt: String,
  #[serde(default)]
  title: String,
  #[serde(default, rename = "ariaLabel")]
  aria_label: String,
  #[serde(default, rename = "nearbyText")]
  nearby_text: String,
  #[serde(default, rename = "targetIds")]
  target_ids: Vec<String>,
  #[serde(default, rename = "regionId")]
  region_id: String,
  #[serde(rename = "box")]
  visual_box: BrowserTargetBox,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserRegionItem {
  id: String,
  role: String,
  label: String,
  #[serde(default)]
  text: String,
  #[serde(rename = "box")]
  region_box: BrowserTargetBox,
  #[serde(default, rename = "targetIds")]
  target_ids: Vec<String>,
  #[serde(default, rename = "blockIds")]
  block_ids: Vec<String>,
  #[serde(default, rename = "inputIds")]
  input_ids: Vec<String>,
  #[serde(default, rename = "visualIds")]
  visual_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserInputItem {
  id: String,
  #[serde(rename = "targetId")]
  target_id: String,
  #[serde(default)]
  name: String,
  #[serde(default, rename = "inputType")]
  input_type: String,
  #[serde(default)]
  placeholder: String,
  #[serde(default)]
  value: String,
  #[serde(default)]
  context: String,
  #[serde(default)]
  active: bool,
  #[serde(default)]
  multiline: bool,
  #[serde(default, rename = "box")]
  input_box: Option<BrowserTargetBox>,
  #[serde(default, rename = "regionId")]
  region_id: String,
  #[serde(default, rename = "blockId")]
  block_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserRelationItem {
  #[serde(rename = "type")]
  relation_type: String,
  from: String,
  to: String,
  #[serde(default)]
  confidence: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserScrollState {
  #[serde(default)]
  x: i32,
  #[serde(default)]
  y: i32,
  #[serde(default, rename = "maxX")]
  max_x: i32,
  #[serde(default, rename = "maxY")]
  max_y: i32,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserPageState {
  #[serde(default, rename = "readyState")]
  ready_state: String,
  #[serde(default, rename = "activeTargetId")]
  active_target_id: String,
  #[serde(default, rename = "hasModal")]
  has_modal: bool,
  #[serde(default, rename = "hasOverlay")]
  has_overlay: bool,
  #[serde(default)]
  scroll: Option<BrowserScrollState>,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserViewport {
  width: f64,
  height: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct BrowserAgentSnapshot {
  #[serde(default, rename = "schemaVersion")]
  schema_version: String,
  title: String,
  url: String,
  viewport: BrowserViewport,
  #[serde(default)]
  state: Option<BrowserPageState>,
  #[serde(default)]
  regions: Vec<BrowserRegionItem>,
  #[serde(default)]
  blocks: Vec<BrowserContentItem>,
  targets: Vec<BrowserAgentTarget>,
  #[serde(default)]
  content: Vec<BrowserContentItem>,
  #[serde(default)]
  inputs: Vec<BrowserInputItem>,
  #[serde(default)]
  relations: Vec<BrowserRelationItem>,
  #[serde(default)]
  visuals: Vec<BrowserVisualItem>,
}

#[derive(Clone, Deserialize)]
struct BrowserAgentAction {
  #[serde(rename = "type")]
  action_type: String,
  #[serde(rename = "targetId")]
  target_id: Option<String>,
  url: Option<String>,
  text: Option<String>,
  submit: Option<bool>,
  direction: Option<String>,
  amount: Option<f64>,
}

#[derive(Clone, Serialize)]
struct BrowserAgentResult {
  reply: String,
  action: String,
  url: Option<String>,
  point: Option<BrowserAgentPoint>,
  target: Option<BrowserAgentTarget>,
}

#[tauri::command]
fn browser_create_webview(
  window: Window,
  label: String,
  url: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
) -> Result<(), String> {
  if let Some(existing) = window.app_handle().get_webview(&label) {
    let _ = existing.close();
  }

  let parsed_url = url.parse().map_err(|error| format!("invalid url: {error}"))?;
  let app_handle = window.app_handle().clone();
  let target_label = label.clone();
  let created_label = label.clone();

  let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed_url))
    .disable_drag_drop_handler()
    .focused(true)
    .devtools(cfg!(debug_assertions))
    .initialization_script(BROWSER_PILOT_WEBVIEW_SCRIPT)
    .on_new_window(move |url, _features| {
      if let Some(webview) = app_handle.get_webview(&target_label) {
        let _ = webview.navigate(url);
      }

      NewWindowResponse::Deny
    })
    .on_page_load(|webview, payload| {
      let _ = webview.window().emit("browser:navigated", payload.url());
    });

  std::thread::spawn(move || {
    let result = window.add_child(
      builder,
      LogicalPosition::new(x, y),
      LogicalSize::new(width, height),
    );

    match result {
      Ok(webview) => {
        let _ = webview.window().emit("browser:webview-created", created_label);
      }
      Err(error) => {
        let _ = window.emit(
          "browser:webview-error",
          BrowserWebviewError {
            label: created_label,
            message: error.to_string(),
          },
        );
      }
    }
  });

  Ok(())
}

#[tauri::command]
async fn browser_agent_snapshot(
  window: Window,
  label: String,
) -> Result<BrowserAgentSnapshot, String> {
  let webview = get_webview(&window, &label)?;
  let value = eval_browser_script(&webview, "snapshot", serde_json::json!({})).await?;
  serde_json::from_value(value).map_err(|error| format!("invalid snapshot: {error}"))
}

#[tauri::command]
async fn browser_agent_observe(
  window: Window,
  label: String,
  force_full: Option<bool>,
) -> Result<serde_json::Value, String> {
  let webview = get_webview(&window, &label)?;
  eval_browser_script(
    &webview,
    "observeActionableDiff",
    serde_json::json!({
      "forceFull": force_full.unwrap_or(false),
    }),
  )
  .await
}

#[tauri::command]
async fn browser_agent_execute(
  window: Window,
  label: String,
  action: BrowserAgentAction,
) -> Result<BrowserAgentResult, String> {
  let webview = get_webview(&window, &label)?;

  match action.action_type.as_str() {
    "navigate" => {
      let url = normalize_url(action.url.as_deref().unwrap_or(""))?;
      let parsed_url = url.parse().map_err(|error| format!("invalid url: {error}"))?;
      webview
        .navigate(parsed_url)
        .map_err(|error| error.to_string())?;

      Ok(BrowserAgentResult {
        reply: format!("打开 {url}。"),
        action: "navigate".into(),
        url: Some(url),
        point: None,
        target: None,
      })
    }
    "click" => {
      let target_id = action
        .target_id
        .as_deref()
        .ok_or_else(|| "click action missing targetId".to_string())?;
      let target = locate_target(&webview, target_id).await?;
      let point = click_webview_point(
        &window,
        &webview,
        target.target_box.x + target.target_box.width / 2.0,
        target.target_box.y + target.target_box.height / 2.0,
      )?;

      std::thread::sleep(Duration::from_millis(650));

      Ok(BrowserAgentResult {
        reply: format!("点击 {}。", target.label),
        action: "click".into(),
        url: webview.url().ok().map(|url| url.to_string()),
        point: Some(point),
        target: Some(target),
      })
    }
    "type" => {
      let target_id = action
        .target_id
        .as_deref()
        .ok_or_else(|| "type action missing targetId".to_string())?;
      let text = action.text.unwrap_or_default();
      let value = eval_browser_script(
        &webview,
        "typeTarget",
        serde_json::json!({
          "targetId": target_id,
          "text": text,
          "submit": action.submit.unwrap_or(false),
        }),
      )
      .await?;
      let target = parse_action_target(value)?;

      std::thread::sleep(Duration::from_millis(650));

      Ok(BrowserAgentResult {
        reply: if action.submit.unwrap_or(false) {
          format!("输入并提交：{}。", text)
        } else {
          format!("输入：{}。", text)
        },
        action: "type".into(),
        url: webview.url().ok().map(|url| url.to_string()),
        point: None,
        target: Some(target),
      })
    }
    "scroll" => {
      let direction = action.direction.unwrap_or_else(|| "down".into());
      let amount = action.amount.unwrap_or(650.0).clamp(80.0, 1800.0);
      let value = eval_browser_script(
        &webview,
        "scrollPage",
        serde_json::json!({
          "targetId": action.target_id,
          "direction": direction,
          "amount": amount,
        }),
      )
      .await?;
      if !value
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
      {
        return Err(value
          .get("error")
          .and_then(serde_json::Value::as_str)
          .unwrap_or("browser scroll failed")
          .to_string());
      }
      let target = match value.get("target") {
        Some(target_value) if !target_value.is_null() => {
          Some(parse_action_target(target_value.clone())?)
        }
        _ => None,
      };

      std::thread::sleep(Duration::from_millis(500));

      Ok(BrowserAgentResult {
        reply: if direction == "up" {
          "向上滚动。".into()
        } else {
          "向下滚动。".into()
        },
        action: "scroll".into(),
        url: webview.url().ok().map(|url| url.to_string()),
        point: None,
        target,
      })
    }
    "none" => Ok(BrowserAgentResult {
      reply: "没有执行浏览器动作。".into(),
      action: "none".into(),
      url: webview.url().ok().map(|url| url.to_string()),
      point: None,
      target: None,
    }),
    other => Err(format!("unsupported browser action: {other}")),
  }
}

#[tauri::command]
fn browser_set_webview_bounds(
  window: Window,
  label: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
) -> Result<(), String> {
  let webview = get_webview(&window, &label)?;

  webview
    .set_position(LogicalPosition::new(x, y))
    .and_then(|_| webview.set_size(LogicalSize::new(width, height)))
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn browser_close_webview(window: Window, label: String) -> Result<(), String> {
  if let Some(webview) = window.app_handle().get_webview(&label) {
    webview.close().map_err(|error| error.to_string())?;
  }

  Ok(())
}

#[tauri::command]
fn browser_focus_webview(window: Window, label: String) -> Result<(), String> {
  let webview = get_webview(&window, &label)?;
  webview.set_focus().map_err(|error| error.to_string())
}

fn get_webview(window: &Window, label: &str) -> Result<Webview, String> {
  window
    .app_handle()
    .get_webview(label)
    .ok_or_else(|| format!("webview not found: {label}"))
}

async fn locate_target(webview: &Webview, target_id: &str) -> Result<BrowserAgentTarget, String> {
  let value = eval_browser_script(
    webview,
    "locateTarget",
    serde_json::json!({
      "targetId": target_id,
    }),
  )
  .await?;

  parse_action_target(value)
}

async fn eval_browser_script(
  webview: &Webview,
  method: &str,
  payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let payload_json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
  let script = format!(
    r#"(() => {{
      if (!window.__BROWSER_PILOT__ || typeof window.__BROWSER_PILOT__.{method} !== "function") {{
        return {{ ok: false, error: "BrowserPilot webview bridge is not ready." }};
      }}
      return window.__BROWSER_PILOT__.{method}({payload_json});
    }})()"#
  );

  eval_json(webview, script).await
}

async fn eval_json(webview: &Webview, script: String) -> Result<serde_json::Value, String> {
  let (sender, receiver) = mpsc::channel();

  webview
    .eval_with_callback(script, move |value| {
      let _ = sender.send(value);
    })
    .map_err(|error| error.to_string())?;

  let raw = tauri::async_runtime::spawn_blocking(move || {
    receiver
      .recv_timeout(Duration::from_secs(12))
      .map_err(|_| "reading DOM timed out".to_string())
  })
  .await
  .map_err(|error| error.to_string())??;

  parse_eval_json(&raw)
}

fn parse_eval_json(raw: &str) -> Result<serde_json::Value, String> {
  let value: serde_json::Value =
    serde_json::from_str(raw).map_err(|error| format!("invalid DOM response: {error}"))?;

  if let serde_json::Value::String(inner) = value {
    serde_json::from_str(&inner).map_err(|error| format!("invalid DOM response: {error}"))
  } else {
    Ok(value)
  }
}

fn parse_action_target(value: serde_json::Value) -> Result<BrowserAgentTarget, String> {
  if !value
    .get("ok")
    .and_then(serde_json::Value::as_bool)
    .unwrap_or(false)
  {
    return Err(value
      .get("error")
      .and_then(serde_json::Value::as_str)
      .unwrap_or("browser action failed")
      .to_string());
  }

  let target = value
    .get("target")
    .ok_or_else(|| "browser action did not return target".to_string())?;
  serde_json::from_value(target.clone()).map_err(|error| format!("invalid target: {error}"))
}

fn normalize_url(value: &str) -> Result<String, String> {
  let input = value.trim();
  if input.is_empty() {
    return Err("url cannot be empty".into());
  }

  if input.contains(' ') {
    return Err("url cannot contain spaces".into());
  }

  if input.starts_with("http://") || input.starts_with("https://") {
    return Ok(input.to_string());
  }

  Ok(format!("https://{input}"))
}

fn click_webview_point(
  window: &Window,
  webview: &Webview,
  x: f64,
  y: f64,
) -> Result<BrowserAgentPoint, String> {
  let scale = window.scale_factor().map_err(|error| error.to_string())?;
  let window_position = window
    .inner_position()
    .map_err(|error| error.to_string())?;
  let webview_position = webview.position().map_err(|error| error.to_string())?;
  let screen_x = window_position.x + webview_position.x + (x * scale).round() as i32;
  let screen_y = window_position.y + webview_position.y + (y * scale).round() as i32;

  webview.set_focus().map_err(|error| error.to_string())?;
  native_left_click(screen_x, screen_y)?;

  Ok(BrowserAgentPoint {
    x: screen_x,
    y: screen_y,
  })
}

#[cfg(target_os = "windows")]
fn native_left_click(x: i32, y: i32) -> Result<(), String> {
  const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
  const MOUSEEVENTF_LEFTUP: u32 = 0x0004;

  #[link(name = "user32")]
  extern "system" {
    fn SetCursorPos(x: i32, y: i32) -> i32;
    fn mouse_event(
      dw_flags: u32,
      dx: u32,
      dy: u32,
      dw_data: u32,
      dw_extra_info: usize,
    );
  }

  unsafe {
    if SetCursorPos(x, y) == 0 {
      return Err("native mouse move failed".into());
    }

    std::thread::sleep(Duration::from_millis(80));
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    std::thread::sleep(Duration::from_millis(70));
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }

  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn native_left_click(_x: i32, _y: i32) -> Result<(), String> {
  Err("native mouse click is not implemented on this platform".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  configure_webview2_cdp();

  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      browser_create_webview,
      browser_agent_observe,
      browser_agent_snapshot,
      browser_agent_execute,
      browser_set_webview_bounds,
      browser_close_webview,
      browser_focus_webview
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(target_os = "windows")]
fn configure_webview2_cdp() {
  let port_arg = format!("--remote-debugging-port={WEBVIEW_CDP_PORT}");
  let current = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();

  if current.contains("--remote-debugging-port=") {
    return;
  }

  let next = if current.trim().is_empty() {
    port_arg
  } else {
    format!("{} {}", current.trim(), port_arg)
  };

  std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", next);
}

#[cfg(not(target_os = "windows"))]
fn configure_webview2_cdp() {}
