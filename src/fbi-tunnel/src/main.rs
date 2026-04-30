mod args;
mod discovery;
mod forwarder;
mod listener;
mod mapping;

use args::parse_args;
use mapping::Mapping;

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let a = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = run(&a).await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

async fn run(args: &args::Args) -> Result<(), String> {
    let discovered = discovery::discover_ports(&args.fbi_url, args.run_id).await?;
    let mappings = mapping::merge_mappings(&discovered, &args.overrides);

    if mappings.is_empty() {
        return Err(
            "no ports to forward (run has no listening ports and no -L flags given)".into(),
        );
    }

    let mut bound: Vec<(tokio::net::TcpListener, Mapping)> = Vec::new();
    let mut final_mappings: Vec<Mapping> = Vec::new();
    for m in &mappings {
        match listener::bind_local(m.local).await {
            Ok((l, port)) => {
                let fm = Mapping {
                    local: port,
                    remote: m.remote,
                };
                bound.push((l, fm.clone()));
                final_mappings.push(fm);
            }
            Err(e) => eprintln!("bind failed for remote {}: {e}", m.remote),
        }
    }

    if bound.is_empty() {
        return Err("no listeners bound".into());
    }

    print_table(args, &final_mappings);

    let (cancel_tx, _) = tokio::sync::watch::channel(false);
    let (ended_tx, mut ended_rx) = tokio::sync::mpsc::channel::<()>(1);
    let mut join_set = tokio::task::JoinSet::new();

    for (tcp_listener, m) in bound {
        let url = args.fbi_url.clone();
        let run_id = args.run_id;
        let mut cancel_rx = cancel_tx.subscribe();
        let ended_tx = ended_tx.clone();

        join_set.spawn(async move {
            loop {
                tokio::select! {
                    accept = tcp_listener.accept() => {
                        match accept {
                            Ok((stream, addr)) => {
                                eprintln!("open  remote {}  from {addr}", m.remote);
                                let url = url.clone();
                                let ended_tx = ended_tx.clone();
                                let remote = m.remote;
                                tokio::spawn(async move {
                                    let result = forwarder::forward_conn(&url, run_id, remote, stream).await;
                                    let is_ended = matches!(&result, Err(e) if e == forwarder::ERR_RUN_ENDED);
                                    eprintln!("close remote {remote}  from {addr}  err={result:?}");
                                    if is_ended {
                                        let _ = ended_tx.send(()).await;
                                    }
                                });
                            }
                            Err(_) => return,
                        }
                    }
                    _ = cancel_rx.changed() => return,
                }
            }
        });
    }

    tokio::select! {
        _ = ended_rx.recv() => {
            eprintln!("run {} ended", args.run_id);
            let _ = cancel_tx.send(true);
        }
        _ = wait_for_signal() => {
            let _ = cancel_tx.send(true);
        }
        _ = drain_join_set(&mut join_set) => {}
    }

    while join_set.join_next().await.is_some() {}

    Ok(())
}

async fn drain_join_set(set: &mut tokio::task::JoinSet<()>) {
    while set.join_next().await.is_some() {}
}

async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT handler");
    let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = sigint.recv() => {}
        _ = sigterm.recv() => {}
    }
}

fn print_table(args: &args::Args, mappings: &[Mapping]) {
    println!("run {} → {}", args.run_id, args.fbi_url);
    for m in mappings {
        let note = if m.local != m.remote {
            format!("  (local {} was busy)", m.remote)
        } else {
            String::new()
        };
        println!(
            "  remote {}  →  http://localhost:{}{}",
            m.remote, m.local, note
        );
    }
}
