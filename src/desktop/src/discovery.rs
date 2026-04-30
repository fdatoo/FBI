use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};

#[derive(Serialize)]
pub struct DiscoveredServer {
    pub name: String,
    pub url: String,
}

#[derive(Deserialize)]
struct TailscaleStatus {
    #[serde(rename = "Peer")]
    peer: Option<HashMap<String, TailscalePeer>>,
}

#[derive(Deserialize)]
struct TailscalePeer {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(rename = "TailscaleIPs")]
    tailscale_ips: Option<Vec<String>>,
    #[serde(rename = "Online")]
    online: Option<bool>,
}

#[tauri::command]
pub async fn discover_servers() -> Vec<DiscoveredServer> {
    let status = match fetch_tailscale_status().await {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let candidates: Vec<(String, String)> = status
        .peer
        .unwrap_or_default()
        .into_values()
        .filter(|p| p.online.unwrap_or(false))
        .filter_map(|peer| {
            let host = peer
                .dns_name
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_end_matches('.').to_string())
                .or_else(|| peer.tailscale_ips.and_then(|ips| ips.into_iter().next()))?;
            let name = host.split('.').next().unwrap_or(&host).to_string();
            let url = format!("http://{}:3000", host);
            Some((name, url))
        })
        .collect();

    probe_candidates(candidates).await
}

async fn fetch_tailscale_status() -> Result<TailscaleStatus, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?
        .get("http://100.100.100.100/localapi/v0/status")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<TailscaleStatus>()
        .await
        .map_err(|e| e.to_string())
}

async fn probe_candidates(candidates: Vec<(String, String)>) -> Vec<DiscoveredServer> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let handles: Vec<_> = candidates
        .into_iter()
        .map(|(name, url)| {
            let c = client.clone();
            let health = format!("{}/api/health", url);
            tokio::spawn(async move {
                match c.get(&health).send().await {
                    Ok(r) if r.status().is_success() => Some(DiscoveredServer { name, url }),
                    _ => None,
                }
            })
        })
        .collect();

    let mut results = vec![];
    for h in handles {
        if let Ok(Some(s)) = h.await {
            results.push(s);
        }
    }
    results
}
