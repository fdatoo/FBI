use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct DiscoveryResp {
    ports: Vec<PortEntry>,
}

#[derive(Deserialize)]
struct PortEntry {
    port: u16,
}

pub async fn discover_ports(base_url: &str, run_id: u32) -> Result<Vec<u16>, String> {
    let url = format!(
        "{}/api/runs/{}/listening-ports",
        base_url.trim_end_matches('/'),
        run_id
    );
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;

    let status = resp.status().as_u16();
    if status != 200 {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("server returned {status}: {}", body.trim()));
    }

    let data: DiscoveryResp = resp
        .json()
        .await
        .map_err(|e| format!("parse response: {e}"))?;
    Ok(data.ports.into_iter().map(|p| p.port).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};

    async fn ports_handler() -> axum::Json<serde_json::Value> {
        axum::Json(serde_json::json!({
            "ports": [{"port": 5173, "proto": "tcp"}, {"port": 9229, "proto": "tcp"}]
        }))
    }

    async fn not_found_handler() -> impl axum::response::IntoResponse {
        (axum::http::StatusCode::NOT_FOUND, "run not found")
    }

    #[tokio::test]
    async fn returns_parsed_ports() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/api/runs/1/listening-ports", get(ports_handler));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let result = discover_ports(&format!("http://127.0.0.1:{port}"), 1)
            .await
            .unwrap();
        assert_eq!(result, vec![5173, 9229]);
    }

    #[tokio::test]
    async fn non_200_is_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/api/runs/99/listening-ports", get(not_found_handler));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let err = discover_ports(&format!("http://127.0.0.1:{port}"), 99)
            .await
            .unwrap_err();
        assert!(err.contains("404"), "expected 404 in error, got: {err}");
    }

    #[tokio::test]
    async fn trailing_slash_in_base_url_is_handled() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/api/runs/1/listening-ports", get(ports_handler));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let result = discover_ports(&format!("http://127.0.0.1:{port}/"), 1)
            .await
            .unwrap();
        assert_eq!(result, vec![5173, 9229]);
    }
}
