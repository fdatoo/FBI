use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{protocol::frame::coding::CloseCode, Message},
};

pub const ERR_RUN_ENDED: &str = "run ended";

fn ws_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("http://") {
        Ok(format!("ws://{rest}"))
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        Ok(format!("wss://{rest}"))
    } else if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        Ok(trimmed.to_string())
    } else {
        Err(format!("unsupported scheme in {base_url:?}"))
    }
}

pub async fn forward_conn(
    base_url: &str,
    run_id: u32,
    remote_port: u16,
    stream: TcpStream,
) -> Result<(), String> {
    let ws_base = ws_url(base_url)?;
    let url = format!("{ws_base}/api/runs/{run_id}/proxy/{remote_port}");

    let (ws, _) = connect_async(url.as_str())
        .await
        .map_err(|e| format!("ws dial: {e}"))?;

    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut tcp_rx, mut tcp_tx) = tokio::io::split(stream);

    let tcp_to_ws = async {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match tcp_rx.read(&mut buf).await {
                Ok(0) | Err(_) => return Ok(()),
                Ok(n) => {
                    ws_tx
                        .send(Message::Binary(buf[..n].to_vec()))
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    };

    let ws_to_tcp = async {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    tcp_tx.write_all(&data).await.map_err(|e| e.to_string())?;
                }
                Ok(Message::Close(frame)) => {
                    if frame.map(|f| f.code == CloseCode::Away).unwrap_or(false) {
                        return Err(ERR_RUN_ENDED.to_string());
                    }
                    return Ok(());
                }
                Ok(_) => {} // ping, pong, text — ignore
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    };

    tokio::select! {
        r = tcp_to_ws => r,
        r = ws_to_tcp => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_http() {
        assert_eq!(ws_url("http://foo:3000").unwrap(), "ws://foo:3000");
    }

    #[test]
    fn ws_url_https() {
        assert_eq!(ws_url("https://foo:3000").unwrap(), "wss://foo:3000");
    }

    #[test]
    fn ws_url_strips_trailing_slash() {
        assert_eq!(ws_url("http://foo:3000/").unwrap(), "ws://foo:3000");
    }

    #[test]
    fn ws_url_passthrough_ws() {
        assert_eq!(ws_url("ws://foo:3000").unwrap(), "ws://foo:3000");
    }

    #[test]
    fn ws_url_bad_scheme() {
        assert!(ws_url("ftp://foo:3000").is_err());
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use axum::{
        extract::ws::{Message as AxMessage, WebSocket, WebSocketUpgrade},
        routing::get,
        Router,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn ws_echo(ws: WebSocketUpgrade) -> impl axum::response::IntoResponse {
        ws.on_upgrade(|mut socket: WebSocket| async move {
            while let Some(Ok(msg)) = socket.recv().await {
                if let AxMessage::Binary(data) = msg {
                    let _ = socket.send(AxMessage::Binary(data)).await;
                }
            }
        })
    }

    #[tokio::test]
    async fn forward_conn_pipes_bytes_and_echoes() {
        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_port = ws_listener.local_addr().unwrap().port();
        let app = Router::new().route("/api/runs/1/proxy/9999", get(ws_echo));
        tokio::spawn(async move { axum::serve(ws_listener, app).await.unwrap() });

        let local_server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_port = local_server.local_addr().unwrap().port();
        let mut client = tokio::net::TcpStream::connect(format!("127.0.0.1:{local_port}"))
            .await
            .unwrap();
        let (server_side, _) = local_server.accept().await.unwrap();

        let base_url = format!("http://127.0.0.1:{ws_port}");
        tokio::spawn(async move {
            let _ = forward_conn(&base_url, 1, 9999, server_side).await;
        });

        client.write_all(b"hello world").await.unwrap();
        let mut buf = vec![0u8; 11];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello world");
    }
}
