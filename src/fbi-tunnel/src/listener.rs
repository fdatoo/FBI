use tokio::net::TcpListener;

pub async fn bind_local(preferred: u16) -> Result<(TcpListener, u16), std::io::Error> {
    if preferred > 0 {
        if let Ok(l) = TcpListener::bind(format!("127.0.0.1:{preferred}")).await {
            let port = l.local_addr()?.port();
            return Ok((l, port));
        }
    }
    let l = TcpListener::bind("127.0.0.1:0").await?;
    let port = l.local_addr()?.port();
    Ok((l, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn binds_preferred_port() {
        let l0 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let free_port = l0.local_addr().unwrap().port();
        drop(l0);

        let (l, port) = bind_local(free_port).await.unwrap();
        assert_eq!(port, free_port);
        drop(l);
    }

    #[tokio::test]
    async fn falls_back_to_random_when_preferred_is_busy() {
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let busy_port = occupied.local_addr().unwrap().port();

        let (l, port) = bind_local(busy_port).await.unwrap();
        assert_ne!(port, busy_port);
        assert!(port > 0);
        drop(l);
        drop(occupied);
    }

    #[tokio::test]
    async fn zero_preferred_always_picks_random() {
        let (l, port) = bind_local(0).await.unwrap();
        assert!(port > 0);
        drop(l);
    }
}
