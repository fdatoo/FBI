import gleam/erlang/process.{type Subject}
import gleam/option.{type Option}

pub type Phase {
  Starting(broadcaster: Subject(BroadcastMsg))
  Running(
    container_id: String,
    branch: String,
    broadcaster: Subject(BroadcastMsg),
    cols: Int,
    rows: Int,
  )
  Waiting(outcome: RunOutcome, broadcaster: Subject(BroadcastMsg))
  Finishing(outcome: RunOutcome)
  Done(outcome: RunOutcome)
  Failed(reason: String)
}

pub type RunOutcome {
  RunOutcome(
    exit_code: Int,
    branch_pushed: Option(String),
    head_commit: Option(String),
    title: Option(String),
    error_message: Option(String),
    claude_session_id: Option(String),
  )
}

pub type RunMsg {
  // From RunWorker
  WorkerReady(container_id: String, branch: String, cols: Int, rows: Int)
  WorkerFailed(reason: String)
  ContainerExited(outcome: RunOutcome)

  // From WebSocket clients
  Subscribe(client: Subject(TerminalEvent))
  Unsubscribe(client: Subject(TerminalEvent))
  WriteStdin(bytes: BitArray)
  Resize(cols: Int, rows: Int)

  // External commands
  Cancel
  Shutdown
  WaitingTimeout

  // From container status watcher
  AgentStatusChanged(status: String)
}

pub type BroadcastMsg {
  BroadcastChunk(data: BitArray)
  BroadcastEvent(event: TerminalEvent)
  BroadcastSubscribe(client: Subject(TerminalEvent))
  BroadcastUnsubscribe(client: Subject(TerminalEvent))
  BroadcastShutdown
}

pub type TerminalEvent {
  TerminalChunk(data: BitArray)
  StateChanged(state: String)
  TitleChanged(title: String)
  Snapshot(ansi: String, cols: Int, rows: Int, byte_offset: Int)
}
